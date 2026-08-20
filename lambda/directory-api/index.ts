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
const PRACTITIONER_APPROACHES_EXT = `${BASE_EXT}/practitioner-approaches`;
const PRACTITIONER_CREDENTIAL_TIER_EXT = `${BASE_EXT}/practitioner-credential-tier`;
const PRACTITIONER_CERTIFICATIONS_EXT = `${BASE_EXT}/practitioner-certifications`;
const PRACTITIONER_WEBSITE_EXT = `${BASE_EXT}/practitioner-website`;
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
    domainName?: string;
    http: { method: string; path: string };
  };
}

interface ApiGatewayResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
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
      return await handleSearchPractitioners(event.queryStringParameters || {}, event.requestContext.domainName);
    }

    // GET /api/directory/practitioners/:id
    if (method === 'GET' && path.match(/^\/api\/directory\/practitioners\/[\w-]+$/)) {
      const id = event.pathParameters?.id || path.split('/').pop()!;
      return await handleGetPractitioner(id, event.requestContext.domainName);
    }

    // GET /api/directory/photo/:practitionerId (public image proxy)
    if (method === 'GET' && path.match(/^\/api\/directory\/photo\/[\w-]+$/)) {
      return await handleGetPhoto(path.split('/').pop()!);
    }

    // GET /api/directory/filters
    if (method === 'GET' && path === '/api/directory/filters') {
      return await handleGetFilters();
    }

    // POST /api/directory/apply - practitioner listing application
    if (method === 'POST' && path === '/api/directory/apply') {
      const body = event.body ? JSON.parse(event.body) : {};
      return await handleApply(body);
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
  /** Somatic therapy approaches (display names) — FindSomatic axis, distinct from
   *  modalities (session format). */
  approaches: string[];
  /** 'licensed' | 'pre-licensed' | 'certified' | '' — drives the credential badge. */
  credentialTier: string;
  certifications: string[];
  /** Practitioner's own site — rung-1 external listees get a visit-website CTA
   *  instead of the Book button (they have no booking page / portal slug). */
  website: string;
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

/** Public photo proxy, keyed by PRACTITIONER id (never raw Binary ids — an unauthenticated
 *  route must not be able to fetch arbitrary stored files). Serves only the photo of a
 *  directory-listed practitioner. */
async function handleGetPhoto(practitionerId: string): Promise<ApiGatewayResponse> {
  if (!/^[\w-]{10,64}$/.test(practitionerId)) {
    return jsonResponse(400, { error: 'Invalid id' });
  }
  const medplum = await getMedplum();
  try {
    const pract = await medplum.readResource('Practitioner', practitionerId);
    if (!getExtensionBoolean(pract, DIRECTORY_LISTED_EXT)) {
      return jsonResponse(404, { error: 'Not found' });
    }
    // Org toggle too: unlisting the practice (rollback) must stop photo serving as well.
    const orgRef = pract.meta?.account?.reference || '';
    if (orgRef.startsWith('Organization/')) {
      const photoOrg = await medplum.readResource('Organization', orgRef.replace('Organization/', ''));
      if (!getExtensionBoolean(photoOrg, DIRECTORY_LISTED_EXT)) {
        return jsonResponse(404, { error: 'Not found' });
      }
    }
    const photoExt = pract.extension?.find((e: any) => e.url === PRACTITIONER_PHOTO_EXT);
    const stored = (photoExt as any)?.valueUrl || (photoExt as any)?.valueString || '';
    const binaryId = stored.match(/Binary\/([\w-]+)/)?.[1];
    if (!binaryId) {
      return jsonResponse(404, { error: 'No photo' });
    }
    const token = await medplum.getAccessToken();
    const resp = await fetch(
      `${process.env.MEDPLUM_BASE_URL!.replace(/\/$/, '')}/fhir/R4/Binary/${binaryId}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'image/*' } }
    );
    if (!resp.ok) {
      console.error(`Image proxy upstream ${resp.status} for Binary ${binaryId} (token ${token ? 'present' : 'MISSING'})`);
      return jsonResponse(404, { error: 'Not found' });
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('Photo proxy error:', err);
    return jsonResponse(404, { error: 'Not found' });
  }
}

function publicPhotoUrl(practitioner: Practitioner, apiDomain: string | undefined): string | null {
  const photoExt = practitioner.extension?.find((e: any) => e.url === PRACTITIONER_PHOTO_EXT);
  const stored = (photoExt as any)?.valueUrl || (photoExt as any)?.valueString || '';
  if (!stored) return null;
  // Medplum Binary URLs require auth (verified 2026-07-20: direct fetch = 401, and practice
  // logos had the same silent breakage) — rewrite to this API's own proxy.
  const base = apiDomain ? `https://${apiDomain}` : '';
  return `${base}/api/directory/photo/${practitioner.id}`;
}

function transformPractitioner(
  practitioner: Practitioner,
  org: Organization,
  portalSlug: string,
  orgModalities: ('in-person' | 'telehealth')[] = [],
  apiDomain?: string
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
  const approachesStr = getExtensionValue(practitioner, PRACTITIONER_APPROACHES_EXT) || '';
  const certificationsStr = getExtensionValue(practitioner, PRACTITIONER_CERTIFICATIONS_EXT) || '';

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
    photo: publicPhotoUrl(practitioner, apiDomain),
    bio: getExtensionValue(practitioner, PRACTITIONER_BIO_EXT) || '',
    specialties: specialtiesStr.split(',').map((s) => s.trim()).filter(Boolean),
    approaches: approachesStr.split(',').map((s) => s.trim()).filter(Boolean),
    credentialTier: getExtensionValue(practitioner, PRACTITIONER_CREDENTIAL_TIER_EXT) || '',
    website: (() => {
      const e = practitioner.extension?.find((x: any) => x.url === PRACTITIONER_WEBSITE_EXT);
      return ((e as any)?.valueUrl || (e as any)?.valueString || '') as string;
    })(),
    certifications: certificationsStr.split(',').map((s) => s.trim()).filter(Boolean),
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

async function handleSearchPractitioners(params: Record<string, string>, apiDomain?: string): Promise<ApiGatewayResponse> {
  const { state, specialty, insurance, modality, gender, language, approach, page = '1', limit = '20' } = params;
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
      const transformed = transformPractitioner(pract, org, slug, orgModalities, apiDomain);

      // Apply additional filters
      if (specialty) {
        const hasSpecialty = transformed.specialties.some(
          (s) => s.toLowerCase().includes(specialty.toLowerCase())
        );
        if (!hasSpecialty) continue;
      }

      if (approach) {
        const hasApproach = transformed.approaches.some(
          (a) => a.toLowerCase().includes(approach.toLowerCase())
        );
        if (!hasApproach) continue;
      }

      if (insurance && insurance !== 'selfpay') {
        const hasInsurance = transformed.insurances.some(
          (i) => i.toLowerCase().includes(insurance.toLowerCase())
        );
        if (!hasInsurance) continue;
      }

      if (language) {
        // Values are display names (filter options emit what transformPractitioner emits) —
        // a code like 'es' would silently match nothing (the weekend's no-op-filter class).
        const hasLanguage = transformed.languages.some(
          (l) => l.toLowerCase().includes(language.toLowerCase())
        );
        if (!hasLanguage) continue;
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

async function handleGetPractitioner(id: string, apiDomain?: string): Promise<ApiGatewayResponse> {
  const medplum = await getMedplum();

  let practitioner: Practitioner;
  try {
    practitioner = await medplum.readResource('Practitioner', id);
  } catch {
    // readResource THROWS on missing/invalid ids — without this catch a nonexistent id
    // surfaced as a 500 (crawlers retry 500s; a gone profile should 404).
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
  const transformed = transformPractitioner(practitioner, org, slug, await resolveOrgModalities(medplum, orgId), apiDomain);

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

  // Values are DISPLAY NAMES, matching what transformPractitioner emits from
  // Practitioner.communication — ISO codes here silently matched nothing.
  const languages = [
    'English', 'Spanish', 'Mandarin', 'Cantonese', 'Hindi', 'French', 'German',
    'Portuguese', 'Russian', 'Japanese', 'Korean', 'Vietnamese', 'Tagalog', 'Arabic',
  ].map((l) => ({ value: l, label: l }));

  // Somatic approaches — display names, MIRRORED with progress2-base DirectorySettings
  // APPROACH_OPTIONS and the FindSomatic frontend (substring-matched by the approach filter).
  const approaches = [
    'Somatic Experiencing', 'Hakomi', 'Sensorimotor Psychotherapy', 'Somatic IFS',
    'Somatic Attachment Therapy', 'Polyvagal-Informed Therapy', 'TRE (Tension & Trauma Releasing)',
    'Breathwork', 'Dance/Movement Therapy', 'Body-Centered Gestalt', 'EMDR',
    'Other Somatic Approach',
  ].map((a) => ({ value: a, label: a }));

  return jsonResponse(200, { states, specialties, insurances, languages, approaches });
}


// ─── POST /api/directory/apply ───────────────────────────────────────────────

/** Practitioner listing application from the public /practitioners form. Stored as a
 * Communication with the practitioner-application category — the ONLY write this
 * client's AccessPolicy permits (criteria-scoped; updated 2026-08-16). Review queue:
 * search Communications by that category, status=in-progress. */
const APPLICATION_CATEGORY = 'https://progressnotes.app/fhir/directory';

async function handleApply(body: any): Promise<ApiGatewayResponse> {
  // Honeypot: real form leaves this empty; bots fill it. Answer 200 so they move on.
  if (body?.website_url) {
    return jsonResponse(200, { ok: true });
  }

  const str = (v: unknown, max: number): string =>
    typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim().slice(0, max) : '';

  const name = str(body?.name, 120);
  const email = str(body?.email, 160);
  const country = str(body?.country, 60);
  const state = str(body?.state, 40);
  const tier = str(body?.tier, 30);
  const credential = str(body?.credential, 300);
  const site = str(body?.site, 200);
  const note = str(body?.note, 1000);

  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return jsonResponse(400, { error: 'Name and a valid email are required.' });
  }
  if (!['licensed', 'pre-licensed', 'certified'].includes(tier)) {
    return jsonResponse(400, { error: 'Please choose a credential status.' });
  }
  if (!credential) {
    return jsonResponse(400, { error: 'Please describe your license or certification.' });
  }

  const medplum = await getMedplum();
  await medplum.createResource({
    resourceType: 'Communication',
    status: 'in-progress',
    category: [
      {
        coding: [
          { system: APPLICATION_CATEGORY, code: 'practitioner-application', display: 'Practitioner listing application' },
        ],
      },
    ],
    sent: new Date().toISOString(),
    payload: [
      {
        contentString: JSON.stringify({ name, email, country, state, tier, credential, site, note }),
      },
    ],
  } as any);

  return jsonResponse(200, { ok: true });
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
