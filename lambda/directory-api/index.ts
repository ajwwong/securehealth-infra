/**
 * Directory API Lambda
 *
 * Public API for the FindTherapist.me therapist directory.
 * Queries Medplum for practitioners across organizations opted into the directory,
 * returns filtered results with availability preview, and handles booking requests.
 *
 * Routes:
 *   GET  /api/directory/practitioners     - Search practitioners with filters
 *   GET  /api/directory/practitioners/:id - Get practitioner detail with availability
 *   GET  /api/directory/filters           - Get available filter options
 *   POST /api/directory/booking-request   - Submit booking request (redirects to SecureHealth)
 */

import { MedplumClient, Practitioner, Organization, Schedule } from '@medplum/core';

/** Per-location custom-hours schedules (Location actor) are native-scheduling-only —
 * legacy availability must never read them (step-4 coexistence guard). */
function excludeLocationSchedules<
  T extends {
    actor?: { reference?: string }[];
    identifier?: { system?: string }[];
    extension?: { url?: string }[];
  },
>(schedules: T[]): T[] {
  return schedules.filter(
    (s) =>
      !(s.identifier || []).some((i) => i.system === 'https://progressnotes.app/fhir/location-schedule') &&
      !(s.extension || []).some((e) => e.url === 'https://progressnotes.app/fhir/StructureDefinition/schedule-location') &&
      !(s.actor || []).some((a) => a.reference?.startsWith('Location/'))
  );
}


const BASE_EXT = 'https://progressnotes.app/fhir/StructureDefinition';
const DIRECTORY_LISTED_EXT = `${BASE_EXT}/directory-listed`;
const PRACTITIONER_BIO_EXT = `${BASE_EXT}/practitioner-bio`;
const PRACTITIONER_PHOTO_EXT = `${BASE_EXT}/practitioner-photo-url`;
const PRACTITIONER_SPECIALTIES_EXT = `${BASE_EXT}/practitioner-specialties`;
const INSURANCE_ACCEPTED_EXT = `${BASE_EXT}/insurance-accepted`;
const ACCOUNT_DELETED_EXT = `${BASE_EXT}/account-deleted`;
const PORTAL_SLUG_SYSTEM = 'https://progressnotes.app/portal-slug';

// Reuse MedplumClient across warm Lambda invocations
let medplumClient: MedplumClient | null = null;

async function getMedplum(): Promise<MedplumClient> {
  if (medplumClient) {
    return medplumClient;
  }
  const client = new MedplumClient({
    baseUrl: process.env.MEDPLUM_BASE_URL!,
    fetch: fetch,
  });
  await client.startClientLogin(
    process.env.MEDPLUM_CLIENT_ID!,
    process.env.MEDPLUM_CLIENT_SECRET!
  );
  medplumClient = client;
  return client;
}

function resetClient(): void {
  medplumClient = null;
}

interface ApiGatewayEvent {
  routeKey: string;
  rawPath: string;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: string;
  requestContext: {
    http: { method: string; path: string };
  };
}

interface ApiGatewayResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function jsonResponse(statusCode: number, body: unknown): ApiGatewayResponse {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

export async function handler(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
  // Handle CORS preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const path = event.rawPath;
  const method = event.requestContext.http.method;

  try {
    // GET /api/directory/practitioners
    if (method === 'GET' && path === '/api/directory/practitioners') {
      return await handleSearchPractitioners(event.queryStringParameters || {});
    }

    // GET /api/directory/practitioners/:id
    if (method === 'GET' && path.match(/^\/api\/directory\/practitioners\/[\w-]+$/)) {
      const id = event.pathParameters?.id || path.split('/').pop()!;
      return await handleGetPractitioner(id);
    }

    // GET /api/directory/filters
    if (method === 'GET' && path === '/api/directory/filters') {
      return await handleGetFilters();
    }

    // POST /api/directory/booking-request
    if (method === 'POST' && path === '/api/directory/booking-request') {
      const body = event.body ? JSON.parse(event.body) : {};
      return await handleBookingRequest(body);
    }

    // POST /api/cora/check-email - Check if email is associated with a deleted Cora account
    if (method === 'POST' && path === '/api/cora/check-email') {
      const body = event.body ? JSON.parse(event.body) : {};
      return await handleCheckEmail(body);
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (err: any) {
    console.error('Lambda error:', err);
    if (err?.message?.includes('Unauthorized') || err?.message?.includes('401')) {
      resetClient();
    }
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface TransformedPractitioner {
  id: string;
  name: string;
  credentials: string;
  photo: string | null;
  bio: string;
  specialties: string[];
  insurances: string[];
  languages: string[];
  modalities: ('in-person' | 'telehealth')[];
  gender: string;
  location: {
    city: string;
    state: string;
    address?: string;
  };
  organization: {
    id: string;
    name: string;
    portalSlug: string;
  };
  nextAvailable: Array<{ scheduleId: string; start: string; end: string; modality: 'in-person' | 'telehealth' }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getExtensionValue(resource: any, url: string): string | undefined {
  return resource.extension?.find((e: any) => e.url === url)?.valueString;
}

function getExtensionBoolean(resource: any, url: string): boolean {
  return resource.extension?.find((e: any) => e.url === url)?.valueBoolean === true;
}

/** Modalities offered by an org, from its ACTIVE Locations (virtual => telehealth, physical
 *  => in-person). Errors return [] and the transform falls back to telehealth-only. */
async function resolveOrgModalities(
  medplum: MedplumClient,
  orgId: string
): Promise<('in-person' | 'telehealth')[]> {
  try {
    const locations = await medplum.searchResources('Location', {
      _compartment: `Organization/${orgId}`,
      _count: '50',
    });
    const out = new Set<'in-person' | 'telehealth'>();
    for (const loc of locations as any[]) {
      if (loc.status && loc.status !== 'active') continue;
      const virtual = loc.physicalType?.coding?.some(
        (c: any) => c.system === 'http://terminology.hl7.org/CodeSystem/location-physical-type' && c.code === 'vi'
      );
      out.add(virtual ? 'telehealth' : 'in-person');
    }
    return [...out];
  } catch {
    return [];
  }
}

function transformPractitioner(
  practitioner: Practitioner,
  org: Organization,
  portalSlug: string,
  orgModalities: ('in-person' | 'telehealth')[] = []
): Omit<TransformedPractitioner, 'nextAvailable'> {
  const name = practitioner.name?.[0];
  const displayName = name
    ? `${name.prefix?.join(' ') || ''} ${name.given?.join(' ') || ''} ${name.family || ''}`.trim()
    : 'Provider';

  const credentials = practitioner.qualification
    ?.map((q) => q.code?.text || q.code?.coding?.[0]?.display)
    .filter(Boolean)
    .join(', ') || '';

  const address = practitioner.address?.[0] || org.address?.[0];
  const city = address?.city || '';
  const state = address?.state || '';

  const specialtiesStr = getExtensionValue(practitioner, PRACTITIONER_SPECIALTIES_EXT) || '';
  const insurancesStr = getExtensionValue(practitioner, INSURANCE_ACCEPTED_EXT) || '';

  // Modalities come from the org's actual active Locations (resolved once per org by the
  // caller) — the old hardcoded "both" made every card claim in-person + telehealth
  // regardless of truth and rendered the modality filter inert.
  const modalities: ('in-person' | 'telehealth')[] =
    orgModalities.length > 0 ? orgModalities : ['telehealth'];

  // Languages from the proper FHIR field (Practitioner.communication) — was hardcoded [].
  const languages = (practitioner.communication || [])
    .map((c) => c.coding?.[0]?.display || c.coding?.[0]?.code || c.text)
    .filter((l): l is string => !!l);

  return {
    id: practitioner.id!,
    name: displayName,
    credentials,
    // practitioner-photo-url is documented as valueUrl (fhirExtensions.ts); accept valueString too
    photo:
      practitioner.extension?.find((e) => e.url === PRACTITIONER_PHOTO_EXT)?.valueUrl ||
      getExtensionValue(practitioner, PRACTITIONER_PHOTO_EXT) ||
      null,
    bio: getExtensionValue(practitioner, PRACTITIONER_BIO_EXT) || '',
    specialties: specialtiesStr.split(',').map((s) => s.trim()).filter(Boolean),
    insurances: insurancesStr.split(',').map((s) => s.trim()).filter(Boolean),
    languages,
    modalities,
    gender: practitioner.gender || 'unknown',
    location: { city, state },
    organization: {
      id: org.id!,
      name: org.name || '',
      portalSlug,
    },
  };
}

// ─── GET /api/directory/practitioners ────────────────────────────────────────

async function handleSearchPractitioners(
  params: Record<string, string>
): Promise<ApiGatewayResponse> {
  const { state, specialty, insurance, modality, gender, page = '1', limit = '20' } = params;
  const pageNum = parseInt(page, 10) || 1;
  const limitNum = Math.min(parseInt(limit, 10) || 20, 50);
  const offset = (pageNum - 1) * limitNum;

  const medplum = await getMedplum();

  // 1. Find organizations opted into directory — paginated, so listed orgs beyond a single
  // capped page can't silently drop out of the directory.
  const orgs: Organization[] = [];
  for (let orgOffset = 0; orgOffset < 5000; orgOffset += 500) {
    const page = await medplum.searchResources('Organization', {
      _count: '500',
      _offset: String(orgOffset),
    });
    orgs.push(...page);
    if (page.length < 500) break;
  }

  console.log(`Found ${orgs.length} total organizations`);

  const listedOrgs = orgs.filter((org) => getExtensionBoolean(org, DIRECTORY_LISTED_EXT));

  console.log(`Found ${listedOrgs.length} directory-listed organizations`);
  listedOrgs.forEach(org => console.log(`  - ${org.name} (${org.id})`));

  if (listedOrgs.length === 0) {
    return jsonResponse(200, {
      practitioners: [],
      total: 0,
      page: pageNum,
      totalPages: 0,
    });
  }

  // Build org lookup map
  const orgMap = new Map<string, { org: Organization; slug: string }>();
  for (const org of listedOrgs) {
    const slug = org.identifier?.find((i) => i.system === PORTAL_SLUG_SYSTEM)?.value || '';
    orgMap.set(org.id!, { org, slug });
  }

  // 2. Search practitioners across listed organizations
  // Note: In production, you'd want more sophisticated cross-org querying
  const matched: Omit<TransformedPractitioner, 'nextAvailable'>[] = [];

  for (const { org, slug } of orgMap.values()) {
    const searchParams: Record<string, string> = {
      _compartment: `Organization/${org.id}`,
      active: 'true',
      _count: '50',
    };

    if (state) {
      searchParams['address-state'] = state;
    }

    if (gender && gender !== 'any') {
      searchParams['gender'] = gender;
    }

    const practitioners = await medplum.searchResources('Practitioner', searchParams);
    const orgModalities = await resolveOrgModalities(medplum, org.id!);

    for (const pract of practitioners) {
      // Listing a person on a public directory is THEIR opt-in, not their employer's: the
      // org toggle opens the practice, each practitioner must also carry directory-listed.
      if (!getExtensionBoolean(pract, DIRECTORY_LISTED_EXT)) continue;
      const transformed = transformPractitioner(pract, org, slug, orgModalities);

      // Apply additional filters
      if (specialty) {
        const hasSpecialty = transformed.specialties.some(
          (s) => s.toLowerCase().includes(specialty.toLowerCase())
        );
        if (!hasSpecialty) continue;
      }

      if (insurance && insurance !== 'selfpay') {
        const hasInsurance = transformed.insurances.some(
          (i) => i.toLowerCase().includes(insurance.toLowerCase())
        );
        if (!hasInsurance) continue;
      }

      if (modality && modality !== 'both') {
        if (!transformed.modalities.includes(modality as 'in-person' | 'telehealth')) {
          continue;
        }
      }

      matched.push(transformed);
    }
  }

  // Paginate FIRST, then compute availability only for the page being returned. Availability is
  // a calculate-availability bot execution per schedule — doing it for every match across every
  // org on each unauthenticated request multiplied cost with directory size and invited abuse.
  const total = matched.length;
  const totalPages = Math.ceil(total / limitNum);
  const pageItems = matched.slice(offset, offset + limitNum);

  const paginated: TransformedPractitioner[] = await Promise.all(
    pageItems.map(async (p) => ({
      ...p,
      nextAvailable: await getNextAvailableSlots(medplum, p.id, p.organization.id, 3),
    }))
  );

  return jsonResponse(200, {
    practitioners: paginated,
    total,
    page: pageNum,
    totalPages,
  });
}

async function getNextAvailableSlots(
  medplum: MedplumClient,
  practitionerId: string,
  organizationId: string,
  count: number
): Promise<Array<{ scheduleId: string; start: string; end: string; modality: 'in-person' | 'telehealth' }>> {
  try {
    const schedules = excludeLocationSchedules(
      await medplum.searchResources('Schedule', {
        actor: `Practitioner/${practitionerId}`,
        active: 'true',
        _count: '5',
      })
    );

    if (schedules.length === 0) return [];

    const now = new Date();
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + 14); // Look 2 weeks ahead

    const slots: Array<{ scheduleId: string; start: string; end: string; modality: 'in-person' | 'telehealth' }> = [];

    for (const schedule of schedules) {
      try {
        const result = await medplum.executeBot(
          { system: 'https://progressnotes.app', value: 'calculate-availability' },
          {
            scheduleId: schedule.id,
            startDate: now.toISOString(),
            endDate: endDate.toISOString(),
            organizationId,
          },
          'application/json'
        ) as any;

        if (result?.success && result.availableSlots) {
          for (const slot of result.availableSlots.slice(0, count - slots.length)) {
            slots.push({
              scheduleId: schedule.id!,
              start: slot.start,
              end: slot.end,
              modality: 'telehealth', // TODO: Determine from slot/schedule
            });
            if (slots.length >= count) break;
          }
        }
      } catch {
        // Skip on error
      }
      if (slots.length >= count) break;
    }

    return slots;
  } catch {
    return [];
  }
}

// ─── GET /api/directory/practitioners/:id ────────────────────────────────────

async function handleGetPractitioner(id: string): Promise<ApiGatewayResponse> {
  const medplum = await getMedplum();

  const practitioner = await medplum.readResource('Practitioner', id);
  if (!practitioner) {
    return jsonResponse(404, { error: 'Practitioner not found' });
  }

  // Get organization
  const compartment = practitioner.meta?.account?.reference;
  if (!compartment) {
    return jsonResponse(404, { error: 'Practitioner organization not found' });
  }

  const orgId = compartment.replace('Organization/', '');
  const org = await medplum.readResource('Organization', orgId);

  if (!getExtensionBoolean(org, DIRECTORY_LISTED_EXT)) {
    return jsonResponse(404, { error: 'Practitioner not in directory' });
  }

  if (!getExtensionBoolean(practitioner, DIRECTORY_LISTED_EXT)) {
    return jsonResponse(404, { error: 'Practitioner not in directory' });
  }

  const slug = org.identifier?.find((i) => i.system === PORTAL_SLUG_SYSTEM)?.value || '';
  const transformed = transformPractitioner(practitioner, org, slug, await resolveOrgModalities(medplum, orgId));

  // Get full availability for next 30 days
  const now = new Date();
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() + 30);

  const schedules = excludeLocationSchedules(
    await medplum.searchResources('Schedule', {
      actor: `Practitioner/${id}`,
      active: 'true',
      _count: '10',
    })
  );

  const allSlots: Array<{ scheduleId: string; start: string; end: string; modality: 'in-person' | 'telehealth' }> = [];

  for (const schedule of schedules) {
    try {
      const result = await medplum.executeBot(
        { system: 'https://progressnotes.app', value: 'calculate-availability' },
        {
          scheduleId: schedule.id,
          startDate: now.toISOString(),
          endDate: endDate.toISOString(),
          organizationId: orgId,
        },
        'application/json'
      ) as any;

      if (result?.success && result.availableSlots) {
        for (const slot of result.availableSlots) {
          allSlots.push({
            scheduleId: schedule.id!,
            start: slot.start,
            end: slot.end,
            modality: 'telehealth',
          });
        }
      }
    } catch {
      // Skip on error
    }
  }

  return jsonResponse(200, {
    practitioner: { ...transformed, nextAvailable: [] },
    availability: allSlots,
  });
}

// ─── GET /api/directory/filters ──────────────────────────────────────────────

async function handleGetFilters(): Promise<ApiGatewayResponse> {
  // Return static filter options
  // In production, you might derive these from actual data

  const states = [
    { value: 'CA', label: 'California' },
    { value: 'NY', label: 'New York' },
    { value: 'TX', label: 'Texas' },
    { value: 'FL', label: 'Florida' },
    { value: 'IL', label: 'Illinois' },
    { value: 'PA', label: 'Pennsylvania' },
    { value: 'OH', label: 'Ohio' },
    { value: 'GA', label: 'Georgia' },
    { value: 'NC', label: 'North Carolina' },
    { value: 'MI', label: 'Michigan' },
    // Add more as needed
  ];

  const specialties = [
    { value: 'anxiety', label: 'Anxiety' },
    { value: 'depression', label: 'Depression' },
    { value: 'trauma', label: 'Trauma & PTSD' },
    { value: 'relationships', label: 'Relationships' },
    { value: 'couples', label: 'Couples Therapy' },
    { value: 'family', label: 'Family Issues' },
    { value: 'stress', label: 'Stress' },
    { value: 'addiction', label: 'Addiction' },
    { value: 'eating', label: 'Eating Disorders' },
    { value: 'lgbtq', label: 'LGBTQ+' },
  ];

  const insurances = [
    { value: 'aetna', label: 'Aetna' },
    { value: 'anthem', label: 'Anthem' },
    { value: 'bcbs', label: 'Blue Cross Blue Shield' },
    { value: 'cigna', label: 'Cigna' },
    { value: 'humana', label: 'Humana' },
    { value: 'uhc', label: 'UnitedHealthcare' },
    { value: 'medicare', label: 'Medicare' },
    { value: 'medicaid', label: 'Medicaid' },
    { value: 'selfpay', label: 'Self-pay' },
  ];

  const languages = [
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Spanish' },
    { value: 'zh', label: 'Chinese' },
    { value: 'vi', label: 'Vietnamese' },
    { value: 'ko', label: 'Korean' },
    { value: 'tl', label: 'Tagalog' },
  ];

  return jsonResponse(200, { states, specialties, insurances, languages });
}

// ─── POST /api/directory/booking-request ─────────────────────────────────────

async function handleBookingRequest(body: any): Promise<ApiGatewayResponse> {
  const { practitionerId, slot, firstName, lastName, email, phone, modality } = body;

  if (!practitionerId || !slot || !firstName || !lastName || !email) {
    return jsonResponse(400, { error: 'Missing required fields' });
  }

  const medplum = await getMedplum();

  // Get practitioner to find organization
  const practitioner = await medplum.readResource('Practitioner', practitionerId);
  const compartment = practitioner.meta?.account?.reference;
  if (!compartment) {
    return jsonResponse(400, { error: 'Invalid practitioner' });
  }

  const orgId = compartment.replace('Organization/', '');
  const org = await medplum.readResource('Organization', orgId);
  const portalSlug = org.identifier?.find((i) => i.system === PORTAL_SLUG_SYSTEM)?.value;

  if (!portalSlug) {
    return jsonResponse(400, { error: 'Practice not configured for booking' });
  }

  // Build redirect URL to SecureHealth booking page
  const params = new URLSearchParams({
    scheduleId: slot.scheduleId,
    start: slot.start,
    end: slot.end,
    firstName,
    lastName,
    email,
    phone: phone || '',
    source: 'findtherapist',
  });

  const redirectUrl = `https://${portalSlug}.securehealth.me/book?${params.toString()}`;

  return jsonResponse(200, { redirectUrl });
}

// ─── POST /api/cora/check-email ──────────────────────────────────────────────

async function handleCheckEmail(body: any): Promise<ApiGatewayResponse> {
  const { email } = body;

  if (!email) {
    return jsonResponse(400, { error: 'Missing email' });
  }

  const medplum = await getMedplum();

  try {
    // Answer ONLY whether this email once had an account that was deleted — that single case is
    // what the app's registration screen needs a specific message for. Whether an email exists
    // at all is deliberately not disclosed here: this is an unauthenticated endpoint, and an
    // existence answer would let anyone probe arbitrary emails against every patient record in
    // the system. Duplicate active emails are rejected by the registration endpoint itself,
    // which the app already handles.
    const patients = await medplum.searchResources('Patient', {
      email: email.toLowerCase(),
      _count: '10',
    });

    const isDeleted = patients.some((patient) =>
      patient.extension?.some((e) => e.url === ACCOUNT_DELETED_EXT)
    );

    return jsonResponse(200, { isDeleted });
  } catch (err: any) {
    console.error('Error checking email:', err);
    // On error, allow the registration attempt to proceed
    // (the registration endpoint still blocks duplicate emails)
    return jsonResponse(200, { isDeleted: false });
  }
}
