/**
 * Booking API Lambda
 *
 * Thin proxy between the public booking page and Medplum.
 * Authenticates to Medplum with client credentials, calls existing bots/FHIR endpoints,
 * and returns results with proper CORS headers.
 *
 * Routes:
 *   GET  /api/booking/{slug}/practice     - Practice info, locations, services
 *   GET  /api/booking/{slug}/availability  - Available time slots for a date
 *   POST /api/booking/{slug}/request       - Submit booking request
 */

import { MedplumClient } from '@medplum/core';

const PORTAL_SLUG_SYSTEM = 'https://progressnotes.app/portal-slug';
const BASE_EXT = 'https://progressnotes.app/fhir/StructureDefinition';
const ALLOW_NEW_CLIENTS_EXT = `${BASE_EXT}/allow-new-clients`;
const ALLOW_NEW_COUPLES_EXT = `${BASE_EXT}/allow-new-couples`;
const LOCATION_DISPLAY_PUBLICLY_EXT = `${BASE_EXT}/location-display-publicly`;
const PRACTICE_LOGO_BINARY_ID_EXT = `${BASE_EXT}/practice-logo-binary-id`;
// Org timezones are stored at the HL7 URL (as valueCode) by registration + the 2026-06-30
// migration; the progressnotes URL is legacy. Reading only the legacy URL/valueString left
// `timezone` undefined for EVERY practice, so the public booking page fell back to Pacific
// display (live report 2026-07-18: Central practice's 5 PM slots rendered as 3 PM).
const TIMEZONE_EXT_HL7 = 'http://hl7.org/fhir/StructureDefinition/timezone';
const TIMEZONE_EXT_LEGACY = `${BASE_EXT}/timezone`;

function readOrgTimezone(org: {
  extension?: Array<{ url?: string; valueCode?: string; valueString?: string }>;
}): string | undefined {
  const tzExt =
    org.extension?.find((e) => e.url === TIMEZONE_EXT_HL7) ||
    org.extension?.find((e) => e.url === TIMEZONE_EXT_LEGACY);
  return tzExt?.valueCode || tzExt?.valueString;
}
const PRESCREENER_QUESTIONS_EXT = `${BASE_EXT}/booking-prescreener-questions`;

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

// Reset client on auth errors so next invocation re-authenticates
function resetClient(): void {
  medplumClient = null;
}

/**
 * Fetch ALL matching resources with explicit pagination, up to a hard safety cap.
 * The old one-shot `_count` fetches silently truncated (and server-order made the kept
 * subset nondeterministic) once a practice exceeded a page. The hard cap bounds work on
 * this anonymous public endpoint; hitting it is a data pathology (e.g. the historical
 * duplicate-schedule pile), so it is logged, never silent.
 */
async function searchAllBounded<T>(
  medplum: MedplumClient,
  resourceType: string,
  params: Record<string, string>,
  hardMax: number
): Promise<T[]> {
  const pageSize = 100;
  const out: T[] = [];
  for (let offset = 0; out.length < hardMax; offset += pageSize) {
    const page = (await medplum.searchResources(resourceType as never, {
      ...params,
      _count: String(Math.min(pageSize, hardMax - out.length)),
      _offset: String(offset),
    })) as unknown as T[];
    out.push(...page);
    if (page.length < pageSize) {
      return out;
    }
  }
  console.warn(`searchAllBounded: ${resourceType} hit hard cap ${hardMax} for ${JSON.stringify(params)} — results truncated`);
  return out;
}

/** Run tasks with bounded concurrency (the per-schedule bot fan-out must stay bounded). */
async function mapChunked<T, R>(items: T[], chunkSize: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    results.push(...(await Promise.allSettled(items.slice(i, i + chunkSize).map(fn))));
  }
  return results;
}

const SCHEDULES_HARD_MAX = 100;
const LOCATIONS_HARD_MAX = 200;
const BOT_FANOUT_CONCURRENCY = 10;

interface ApiGatewayEvent {
  routeKey: string;
  rawPath: string;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: string;
  requestContext: {
    domainName?: string;
    http: { method: string; path: string; sourceIp?: string };
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

// Input shape guards: these values are interpolated into FHIR search strings (token searches
// treat commas as OR-lists), so constrain them to their expected shapes before use.
const SLUG_PATTERN = /^[a-z0-9-]{1,64}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True when the schedule belongs to the given organization (account or compartment). */
function scheduleBelongsToOrg(schedule: { meta?: { account?: { reference?: string }; compartment?: { reference?: string }[] } }, organizationId: string): boolean {
  const orgRef = `Organization/${organizationId}`;
  if (schedule.meta?.account?.reference === orgRef) {
    return true;
  }
  return (schedule.meta?.compartment || []).some((c) => c.reference === orgRef);
}


/** Per-location custom-hours schedules (Location actor) belong to the native scheduling
 * engine only — the legacy merge-all-schedules availability here must never read them,
 * before OR after they flip active (progress2-base
 * docs/sp-per-location-availability-research-2026-07-19.md, step 4 guard). */
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

export async function handler(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
  // Handle CORS preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const slug = event.pathParameters?.slug;
  if (!slug || !SLUG_PATTERN.test(slug)) {
    return jsonResponse(400, { error: 'Missing or invalid slug parameter' });
  }

  const path = event.rawPath;
  const method = event.requestContext.http.method;

  try {
    if (method === 'GET' && path.endsWith('/logo')) {
      return await handleGetLogo(slug);
    } else if (method === 'GET' && path.endsWith('/practice')) {
      return await handleGetPractice(slug, event.requestContext.domainName);
    } else if (method === 'GET' && path.endsWith('/availability-dates')) {
      return await handleGetAvailabilityDates(slug, event.queryStringParameters || {});
    } else if (method === 'GET' && path.endsWith('/availability')) {
      return await handleGetAvailability(slug, event.queryStringParameters || {});
    } else if (method === 'POST' && path.endsWith('/request')) {
      const body = event.body ? JSON.parse(event.body) : {};
      return await handlePostRequest(slug, body, event.requestContext.http.sourceIp);
    } else if (method === 'POST' && path.endsWith('/contact')) {
      const body = event.body ? JSON.parse(event.body) : {};
      return await handlePostContact(slug, body, event.requestContext.http.sourceIp);
    } else {
      return jsonResponse(404, { error: 'Not found' });
    }
  } catch (err: any) {
    console.error('Lambda error:', err);
    // Reset client on auth errors
    if (err?.message?.includes('Unauthorized') || err?.message?.includes('401')) {
      resetClient();
    }
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

// ─── GET /api/booking/{slug}/logo ───────────────────────────────────────────
// Public logo proxy, keyed by SLUG (never raw Binary ids). Direct Medplum Binary URLs
// require auth — logos on the public booking page were silently 401-broken until 2026-07-20.
async function handleGetLogo(slug: string): Promise<ApiGatewayResponse> {
  const medplum = await getMedplum();
  const org = await medplum.searchOne('Organization', {
    identifier: `${PORTAL_SLUG_SYSTEM}|${slug}`,
  });
  const binaryId = org?.extension?.find((e) => e.url === PRACTICE_LOGO_BINARY_ID_EXT)?.valueString;
  if (!binaryId) {
    return jsonResponse(404, { error: 'No logo' });
  }
  try {
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
    console.error('Logo proxy error:', err);
    return jsonResponse(404, { error: 'No logo' });
  }
}

// ─── GET /api/booking/{slug}/practice ───────────────────────────────────────

async function handleGetPractice(slug: string, apiDomain?: string): Promise<ApiGatewayResponse> {
  const logoProxy = (has: boolean): string | undefined =>
    has ? `${apiDomain ? `https://${apiDomain}` : ''}/api/booking/${slug}/logo` : undefined;
  const medplum = await getMedplum();

  // Find organization by slug
  const org = await medplum.searchOne('Organization', {
    identifier: `${PORTAL_SLUG_SYSTEM}|${slug}`,
  });

  if (!org) {
    return jsonResponse(404, { error: 'Practice not found' });
  }

  // Accepting-new-clients no longer 404s the endpoint: the CONTACT embed needs the practice's
  // identity (name/logo/phone) even when booking is paused (widgets audit L5, owner decision
  // 2026-07-10). Booking stays enforced twice over: the flag gates the wizard client-side, and
  // the new-client-request-handler bot independently refuses booking submits when it is off.
  // A paused practice returns a slim payload — no service/practitioner roster, no extra fetches.
  const acceptingNewClients =
    org.extension?.find((e) => e.url === ALLOW_NEW_CLIENTS_EXT)?.valueBoolean === true;
  if (!acceptingNewClients) {
    const pausedLogoExt = org.extension?.find((e) => e.url === PRACTICE_LOGO_BINARY_ID_EXT);
    return jsonResponse(200, {
      practiceName: org.name,
      phone: org.telecom?.find((t) => t.system === 'phone')?.value,
      logoUrl: logoProxy(!!pausedLogoExt?.valueString),
      acceptingNewClients: false,
      locations: [],
      services: [],
      practitioners: [],
    });
  }

  const organizationId = org.id!;

  // Fetch locations, services, and schedules in parallel
  const [locations, servicesResult, schedules] = await Promise.all([
    searchAllBounded<any>(medplum, 'Location', {
      organization: `Organization/${organizationId}`,
    }, LOCATIONS_HARD_MAX),
    medplum.executeBot(
      { system: 'https://progressnotes.app', value: 'billing-settings' },
      { action: 'getServices', organizationId },
      'application/json'
    ),
    searchAllBounded<any>(medplum, 'Schedule', {
      _compartment: `Organization/${organizationId}`,
      active: 'true',
    }, SCHEDULES_HARD_MAX),
  ]);

  // SP-parity location visibility (owner ruling 2026-07-19): EVERY bookable location is
  // listed in the wizard by name; `location-display-publicly` controls only whether the
  // STREET ADDRESS is shown. Rooms (physicalType 'ro') are internal and never listed.
  // Telehealth ('vi') addresses are never shown regardless of the flag (SP: "Your Telehealth
  // address will always be hidden from public view"). Missing physicalType = legacy office.
  const publicLocations = locations
    .filter((loc) => {
      const physical = loc.physicalType?.coding?.find(
        (c: { system?: string; code?: string }) =>
          c.system === 'http://terminology.hl7.org/CodeSystem/location-physical-type'
      )?.code;
      return physical !== 'ro';
    })
    .map((loc) => {
      const physical = loc.physicalType?.coding?.find(
        (c: { system?: string; code?: string }) =>
          c.system === 'http://terminology.hl7.org/CodeSystem/location-physical-type'
      )?.code;
      const isVirtual = physical === 'vi';
      const showAddress =
        !isVirtual &&
        loc.extension?.find((e) => e.url === LOCATION_DISPLAY_PUBLICLY_EXT)?.valueBoolean === true;
      return {
        id: loc.id,
        name: loc.name,
        address:
          showAddress && loc.address
            ? `${loc.address.line?.join(', ') || ''}, ${loc.address.city || ''}, ${loc.address.state || ''} ${loc.address.postalCode || ''}`.trim()
            : undefined,
        phone: loc.telecom?.find((t) => t.system === 'phone')?.value,
      };
    });

  // Filter services to online + new clients
  const services = ((servicesResult as any)?.services || [])
    .filter((s: any) => s.availableOnline && s.allowNewClients)
    .map((s: any) => ({
      code: s.code,
      title: s.description,
      duration: s.defaultDuration,
      price: s.rate,
    }));

  // Extract practitioner info from schedules (include scheduleId for filtering).
  // Reads are deduped by practitioner and chunk-parallelized — the schedule cap is now 100,
  // and the old sequential loop would serialize that many reads.
  const practitionerIds = new Set<string>();
  const practToSchedule: Array<{ practId: string; scheduleId: string }> = [];
  for (const schedule of schedules) {
    for (const actor of schedule.actor || []) {
      if (actor.reference?.startsWith('Practitioner/')) {
        const practId = actor.reference.replace('Practitioner/', '');
        if (!practitionerIds.has(practId)) {
          practitionerIds.add(practId);
          practToSchedule.push({ practId, scheduleId: schedule.id! });
        }
      }
    }
  }

  const practResults = await mapChunked(practToSchedule, BOT_FANOUT_CONCURRENCY, async ({ practId, scheduleId }) => {
    const pract = await medplum.readResource('Practitioner', practId);
    const name = pract.name?.[0];
    const displayName = name
      ? `${name.prefix?.join(' ') || ''} ${name.given?.join(' ') || ''} ${name.family || ''}`.trim()
      : 'Provider';
    const credentials = pract.qualification
      ?.map((q) => q.code?.text || q.code?.coding?.[0]?.display)
      .filter(Boolean)
      .join(', ');
    // Check per-practitioner accepting status (default true if not set)
    const practAccepting = pract.extension?.find(
      (e: any) => e.url === ALLOW_NEW_CLIENTS_EXT
    )?.valueBoolean ?? true;

    return {
      id: practId,
      name: displayName,
      credentials: credentials || undefined,
      scheduleId,
      acceptingNewClients: practAccepting,
    };
  });
  // Skip practitioners we can't read (same tolerance as the old per-read try/catch)
  const practitioners = practResults
    .filter((r): r is PromiseFulfilledResult<{ id: string; name: string; credentials?: string; scheduleId: string; acceptingNewClients: boolean }> => r.status === 'fulfilled')
    .map((r) => r.value);

  // Practice info
  const phone = org.telecom?.find((t) => t.system === 'phone')?.value;
  const logoExt = org.extension?.find((e) => e.url === PRACTICE_LOGO_BINARY_ID_EXT);
  const timezone = readOrgTimezone(org);
  const allowCouples = org.extension?.find((e) => e.url === ALLOW_NEW_COUPLES_EXT)?.valueBoolean === true;

  // Parse prescreener questions from Organization extension (stored as JSON string)
  // Only return questions that are visible and enabled for the booking widget
  const prescreenerEnabled = org.extension?.find(
    (e) => e.url === PRESCREENER_QUESTIONS_EXT + '-booking-enabled'
  )?.valueBoolean === true;
  const prescreenerJson = org.extension?.find((e) => e.url === PRESCREENER_QUESTIONS_EXT)?.valueString;
  let prescreener: unknown[] | undefined;
  if (prescreenerEnabled && prescreenerJson) {
    try {
      const allQuestions = JSON.parse(prescreenerJson) as Array<{
        visible?: boolean;
        placement?: string;
        [key: string]: unknown;
      }>;
      const filtered = allQuestions.filter(
        (q) => q.visible !== false && (!q.placement || q.placement === 'booking' || q.placement === 'both')
      );
      if (filtered.length > 0) {
        prescreener = filtered;
      }
    } catch {
      // Invalid JSON — skip prescreener
    }
  }

  // Filter out practitioners not accepting new clients
  const acceptingPractitioners = practitioners.filter((p) => p.acceptingNewClients !== false);

  return jsonResponse(200, {
    practiceName: org.name,
    phone,
    logoUrl: logoProxy(!!logoExt?.valueString),
    timezone,
    allowCouples,
    prescreener,
    acceptingNewClients: true,
    locations: publicLocations,
    services,
    practitioners: acceptingPractitioners,
  });
}

// ─── GET /api/booking/{slug}/availability ───────────────────────────────────

async function handleGetAvailability(
  slug: string,
  queryParams: Record<string, string>
): Promise<ApiGatewayResponse> {
  const { date, serviceCode, scheduleId } = queryParams;

  if (!date || !DATE_PATTERN.test(date)) {
    return jsonResponse(400, { error: 'Missing or invalid date parameter (YYYY-MM-DD)' });
  }

  const medplum = await getMedplum();

  // Find organization
  const org = await medplum.searchOne('Organization', {
    identifier: `${PORTAL_SLUG_SYSTEM}|${slug}`,
  });

  if (!org) {
    return jsonResponse(404, { error: 'Practice not found' });
  }

  const organizationId = org.id!;

  // Find active schedules — if scheduleId is provided, only fetch that one. The schedule must
  // belong to this slug's practice: a caller-supplied id is otherwise unbound.
  let schedules;
  if (scheduleId) {
    try {
      const schedule = await medplum.readResource('Schedule', scheduleId);
      schedules = schedule.active !== false && scheduleBelongsToOrg(schedule, organizationId) ? [schedule] : [];
    } catch {
      schedules = [];
    }
  } else {
    schedules = excludeLocationSchedules(await searchAllBounded<any>(medplum, 'Schedule', {
      _compartment: `Organization/${organizationId}`,
      active: 'true',
    }, SCHEDULES_HARD_MAX));
  }

  if (schedules.length === 0) {
    return jsonResponse(200, { timezone: readOrgTimezone(org) || 'America/Los_Angeles', slots: [] });
  }

  // Get availability for each schedule and merge slots (parallel)
  const allSlots: Array<{ start: string; end: string; scheduleId: string }> = [];
  // Org timezone as the fallback — the bot result normally overwrites it; if the bot response
  // ever drops its timezone field, we must not silently re-default a non-Pacific practice.
  let timezone = readOrgTimezone(org) || 'America/Los_Angeles';

  // Bounded fan-out: one bot execution per schedule on an anonymous endpoint — the old
  // _count:10 cap bounded this by accident; the concurrency chunk does it on purpose.
  const results = await mapChunked(schedules, BOT_FANOUT_CONCURRENCY, (schedule: any) =>
    medplum.executeBot(
      { system: 'https://progressnotes.app', value: 'calculate-availability' },
      {
        scheduleId: schedule.id,
        startDate: `${date}T00:00:00`,
        endDate: `${date}T23:59:59`,
        serviceType: serviceCode || undefined,
        organizationId,
      },
      'application/json'
    ).then((result: any) => ({ result, scheduleId: schedule.id! }))
  );

  for (const entry of results) {
    if (entry.status === 'fulfilled') {
      const { result, scheduleId: sid } = entry.value;
      if (result?.success && result.availableSlots) {
        for (const slot of result.availableSlots) {
          allSlots.push({ start: slot.start, end: slot.end, scheduleId: sid });
        }
      }
      if (result?.timezone) {
        timezone = result.timezone;
      }
    } else {
      console.error('Failed to get availability for a schedule:', entry.reason);
    }
  }

  // Deduplicate by start time (multiple practitioners may offer the same time)
  // Keep the first schedule's slot for each unique start time
  const seen = new Set<string>();
  const uniqueSlots = allSlots
    .sort((a, b) => a.start.localeCompare(b.start))
    .filter((slot) => {
      if (seen.has(slot.start)) return false;
      seen.add(slot.start);
      return true;
    });

  return jsonResponse(200, { timezone, slots: uniqueSlots });
}

// ─── GET /api/booking/{slug}/availability-dates ─────────────────────────────

async function handleGetAvailabilityDates(
  slug: string,
  queryParams: Record<string, string>
): Promise<ApiGatewayResponse> {
  const { startDate, endDate, serviceCode, scheduleId } = queryParams;

  if (!startDate || !endDate || !DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) {
    return jsonResponse(400, { error: 'Missing or invalid startDate/endDate parameters (YYYY-MM-DD)' });
  }

  const medplum = await getMedplum();

  // Find organization
  const org = await medplum.searchOne('Organization', {
    identifier: `${PORTAL_SLUG_SYSTEM}|${slug}`,
  });

  if (!org) {
    return jsonResponse(404, { error: 'Practice not found' });
  }

  const organizationId = org.id!;

  // Find active schedules — a caller-supplied scheduleId must belong to this slug's practice.
  let schedules;
  if (scheduleId) {
    try {
      const schedule = await medplum.readResource('Schedule', scheduleId);
      schedules = schedule.active !== false && scheduleBelongsToOrg(schedule, organizationId) ? [schedule] : [];
    } catch {
      schedules = [];
    }
  } else {
    schedules = excludeLocationSchedules(await searchAllBounded<any>(medplum, 'Schedule', {
      _compartment: `Organization/${organizationId}`,
      active: 'true',
    }, SCHEDULES_HARD_MAX));
  }

  if (schedules.length === 0) {
    return jsonResponse(200, { dates: [], timezone: readOrgTimezone(org) || 'America/Los_Angeles' });
  }

  // Collect available dates across all schedules (parallel)
  const allDates = new Set<string>();
  // Same org-timezone fallback as /availability.
  let timezone = readOrgTimezone(org) || 'America/Los_Angeles';

  // Bounded fan-out (see /availability).
  const results = await mapChunked(schedules, BOT_FANOUT_CONCURRENCY, (schedule: any) =>
    medplum.executeBot(
      { system: 'https://progressnotes.app', value: 'calculate-availability' },
      {
        scheduleId: schedule.id,
        startDate: `${startDate}T00:00:00`,
        endDate: `${endDate}T23:59:59`,
        serviceType: serviceCode || undefined,
        organizationId,
        datesOnly: true,
      },
      'application/json'
    )
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const data = result.value as any;
      if (data?.success && data.availableDates) {
        for (const d of data.availableDates) {
          allDates.add(d);
        }
      }
      if (data?.timezone) {
        timezone = data.timezone;
      }
    } else {
      console.error('Failed to get availability dates for a schedule:', result.reason);
    }
  }

  const sortedDates = Array.from(allDates).sort();
  return jsonResponse(200, { dates: sortedDates, timezone });
}

// ─── reCAPTCHA verification ──────────────────────────────────────────────────

async function verifyRecaptcha(secretKey: string, token: string): Promise<{ success: boolean; score?: number }> {
  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`,
  });
  return res.json() as Promise<{ success: boolean; score?: number }>;
}

// ─── POST /api/booking/{slug}/request ───────────────────────────────────────

async function handlePostRequest(slug: string, body: any, sourceIp?: string): Promise<ApiGatewayResponse> {
  // A guardian booking for a minor may omit the client's email — the guardian email is the
  // correspondence address (the bot enforces the same rule).
  const hasReachableEmail = body.email || (body.careRecipient === 'someone-else' && body.guardianEmail);
  if (!body.firstName || !body.lastName || !hasReachableEmail) {
    return jsonResponse(400, { error: 'Missing required fields: firstName, lastName, email' });
  }

  // reCAPTCHA verification (soft enforcement — skip if no token provided)
  const recaptchaSecret = process.env.RECAPTCHA_SECRET_KEY;
  if (recaptchaSecret && body.recaptchaToken) {
    try {
      const recaptchaResult = await verifyRecaptcha(recaptchaSecret, body.recaptchaToken);
      if (!recaptchaResult.success) {
        return jsonResponse(400, { success: false, error: 'reCAPTCHA verification failed. Please try again.' });
      }
      // Optional: reject very low scores (likely bot). Score ranges 0.0–1.0.
      if (recaptchaResult.score !== undefined && recaptchaResult.score < 0.3) {
        console.warn(`Low reCAPTCHA score ${recaptchaResult.score} for ${body.email}`);
        return jsonResponse(400, { success: false, error: 'Request blocked. Please try again later.' });
      }
    } catch (err) {
      console.error('reCAPTCHA verification error:', err);
      // Fail open — don't block if Google's API is unreachable
    }
  }

  const medplum = await getMedplum();

  try {
    const result = await medplum.executeBot(
      { system: 'https://progressnotes.app', value: 'new-client-request-handler' },
      {
        action: 'submit',
        slug,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone || undefined,
        reason: body.reason || undefined,
        dateOfBirth: body.dateOfBirth || undefined,
        preferredName: body.preferredName || undefined,
        serviceCode: body.serviceCode || undefined,
        serviceTitle: body.serviceTitle || undefined,
        requestedStart: body.requestedStart || undefined,
        requestedEnd: body.requestedEnd || undefined,
        scheduleId: body.scheduleId || undefined,
        locationId: body.locationId || undefined,
        isCouples: body.isCouples || undefined,
        partnerFirstName: body.partnerFirstName || undefined,
        partnerLastName: body.partnerLastName || undefined,
        partnerEmail: body.partnerEmail || undefined,
        partnerPhone: body.partnerPhone || undefined,
        partnerDateOfBirth: body.partnerDateOfBirth || undefined,
        partnerPreferredName: body.partnerPreferredName || undefined,
        careRecipient: body.careRecipient || undefined,
        prescreenerAnswers: body.prescreenerAnswers || undefined,
        guardianFirstName: body.guardianFirstName || undefined,
        guardianLastName: body.guardianLastName || undefined,
        guardianEmail: body.guardianEmail || undefined,
        guardianPhone: body.guardianPhone || undefined,
        // Marketing attribution captured by the booking page (bot sanitizes + caps; the
        // shape guard here just keeps non-strings out of the payload)
        utmSource: attributionString(body.utmSource),
        utmMedium: attributionString(body.utmMedium),
        utmCampaign: attributionString(body.utmCampaign),
        utmTerm: attributionString(body.utmTerm),
        utmContent: attributionString(body.utmContent),
        gclid: attributionString(body.gclid),
        fbclid: attributionString(body.fbclid),
        referrer: attributionString(body.referrer),
        landingPage: attributionString(body.landingPage),
        honeypot: body.honeypot || undefined,
        submittedAt: body.submittedAt || undefined,
        clientIp: sourceIp || undefined,
      },
      'application/json'
    ) as any;

    if (result?.success) {
      return jsonResponse(200, { success: true });
    } else {
      return jsonResponse(400, { success: false, error: result?.error || 'Request failed' });
    }
  } catch (err) {
    console.error('Failed to execute new-client-request-handler bot:', err);
    return jsonResponse(500, { success: false, error: 'Failed to process request' });
  }
}

function attributionString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, 500) : undefined;
}

// ─── POST /api/booking/{slug}/contact ─────────────────────────────────────

async function handlePostContact(slug: string, body: any, sourceIp?: string): Promise<ApiGatewayResponse> {
  if (!body.firstName || !body.lastName || !body.email || !body.message) {
    return jsonResponse(400, { error: 'Missing required fields: firstName, lastName, email, message' });
  }

  // reCAPTCHA verification
  const recaptchaSecret = process.env.RECAPTCHA_SECRET_KEY;
  if (recaptchaSecret && body.recaptchaToken) {
    try {
      const recaptchaResult = await verifyRecaptcha(recaptchaSecret, body.recaptchaToken);
      if (!recaptchaResult.success || (recaptchaResult.score !== undefined && recaptchaResult.score < 0.3)) {
        return jsonResponse(400, { success: false, error: 'Verification failed. Please try again.' });
      }
    } catch {
      // Fail open
    }
  }

  const medplum = await getMedplum();

  try {
    const result = await medplum.executeBot(
      { system: 'https://progressnotes.app', value: 'new-client-request-handler' },
      {
        action: 'contact',
        slug,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone || undefined,
        message: body.message,
        honeypot: body.honeypot || undefined,
        submittedAt: body.submittedAt || undefined,
        clientIp: sourceIp || undefined,
      },
      'application/json'
    ) as any;

    if (result?.success) {
      return jsonResponse(200, { success: true });
    } else {
      return jsonResponse(400, { success: false, error: result?.error || 'Failed to send message' });
    }
  } catch (err) {
    console.error('Failed to execute contact handler:', err);
    return jsonResponse(500, { success: false, error: 'Failed to send message' });
  }
}
