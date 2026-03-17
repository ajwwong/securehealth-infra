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
const TIMEZONE_EXT = `${BASE_EXT}/timezone`;
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

  const slug = event.pathParameters?.slug;
  if (!slug) {
    return jsonResponse(400, { error: 'Missing slug parameter' });
  }

  const path = event.rawPath;
  const method = event.requestContext.http.method;

  try {
    if (method === 'GET' && path.endsWith('/practice')) {
      return await handleGetPractice(slug);
    } else if (method === 'GET' && path.endsWith('/availability-dates')) {
      return await handleGetAvailabilityDates(slug, event.queryStringParameters || {});
    } else if (method === 'GET' && path.endsWith('/availability')) {
      return await handleGetAvailability(slug, event.queryStringParameters || {});
    } else if (method === 'POST' && path.endsWith('/request')) {
      const body = event.body ? JSON.parse(event.body) : {};
      return await handlePostRequest(slug, body);
    } else if (method === 'POST' && path.endsWith('/contact')) {
      const body = event.body ? JSON.parse(event.body) : {};
      return await handlePostContact(slug, body);
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

// ─── GET /api/booking/{slug}/practice ───────────────────────────────────────

async function handleGetPractice(slug: string): Promise<ApiGatewayResponse> {
  const medplum = await getMedplum();

  // Find organization by slug
  const org = await medplum.searchOne('Organization', {
    identifier: `${PORTAL_SLUG_SYSTEM}|${slug}`,
  });

  if (!org) {
    return jsonResponse(404, { error: 'Practice not found' });
  }

  // Check if accepting new clients
  const allowNewClients = org.extension?.find((e) => e.url === ALLOW_NEW_CLIENTS_EXT);
  if (!allowNewClients?.valueBoolean) {
    return jsonResponse(404, { error: 'This practice is not accepting new client requests' });
  }

  const organizationId = org.id!;

  // Fetch locations, services, and schedules in parallel
  const [locations, servicesResult, schedules] = await Promise.all([
    medplum.searchResources('Location', {
      organization: `Organization/${organizationId}`,
      _count: '50',
    }),
    medplum.executeBot(
      { system: 'https://progressnotes.app', value: 'billing-settings' },
      { action: 'getServices', organizationId },
      'application/json'
    ),
    medplum.searchResources('Schedule', {
      _compartment: `Organization/${organizationId}`,
      active: 'true',
      _count: '10',
    }),
  ]);

  // Filter locations to public ones
  const publicLocations = locations
    .filter((loc) => {
      const displayPublicly = loc.extension?.find((e) => e.url === LOCATION_DISPLAY_PUBLICLY_EXT);
      return displayPublicly?.valueBoolean === true;
    })
    .map((loc) => ({
      id: loc.id,
      name: loc.name,
      address: loc.address
        ? `${loc.address.line?.join(', ') || ''}, ${loc.address.city || ''}, ${loc.address.state || ''} ${loc.address.postalCode || ''}`.trim()
        : undefined,
      phone: loc.telecom?.find((t) => t.system === 'phone')?.value,
    }));

  // Filter services to online + new clients
  const services = ((servicesResult as any)?.services || [])
    .filter((s: any) => s.availableOnline && s.allowNewClients)
    .map((s: any) => ({
      code: s.code,
      title: s.description,
      duration: s.defaultDuration,
      price: s.rate,
    }));

  // Extract practitioner info from schedules (include scheduleId for filtering)
  const practitionerIds = new Set<string>();
  const practitioners: Array<{ id: string; name: string; credentials?: string; scheduleId: string }> = [];

  for (const schedule of schedules) {
    for (const actor of schedule.actor || []) {
      if (actor.reference?.startsWith('Practitioner/')) {
        const practId = actor.reference.replace('Practitioner/', '');
        if (!practitionerIds.has(practId)) {
          practitionerIds.add(practId);
          try {
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

            practitioners.push({
              id: practId,
              name: displayName,
              credentials: credentials || undefined,
              scheduleId: schedule.id!,
              acceptingNewClients: practAccepting,
            });
          } catch {
            // Skip practitioners we can't read
          }
        }
      }
    }
  }

  // Practice info
  const phone = org.telecom?.find((t) => t.system === 'phone')?.value;
  const logoExt = org.extension?.find((e) => e.url === PRACTICE_LOGO_BINARY_ID_EXT);
  const timezone = org.extension?.find((e) => e.url === TIMEZONE_EXT)?.valueString;
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
    logoUrl: logoExt?.valueString
      ? `${process.env.MEDPLUM_BASE_URL}/fhir/R4/Binary/${logoExt.valueString}`
      : undefined,
    timezone,
    allowCouples,
    prescreener,
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

  if (!date) {
    return jsonResponse(400, { error: 'Missing date parameter (YYYY-MM-DD)' });
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

  // Find active schedules — if scheduleId is provided, only fetch that one
  let schedules;
  if (scheduleId) {
    try {
      const schedule = await medplum.readResource('Schedule', scheduleId);
      schedules = schedule.active !== false ? [schedule] : [];
    } catch {
      schedules = [];
    }
  } else {
    schedules = await medplum.searchResources('Schedule', {
      _compartment: `Organization/${organizationId}`,
      active: 'true',
      _count: '10',
    });
  }

  if (schedules.length === 0) {
    return jsonResponse(200, { timezone: 'America/Los_Angeles', slots: [] });
  }

  // Get availability for each schedule and merge slots (parallel)
  const allSlots: Array<{ start: string; end: string; scheduleId: string }> = [];
  let timezone = 'America/Los_Angeles';

  const results = await Promise.allSettled(
    schedules.map((schedule) =>
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
    )
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

  if (!startDate || !endDate) {
    return jsonResponse(400, { error: 'Missing startDate and/or endDate parameters (YYYY-MM-DD)' });
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

  // Find active schedules
  let schedules;
  if (scheduleId) {
    try {
      const schedule = await medplum.readResource('Schedule', scheduleId);
      schedules = schedule.active !== false ? [schedule] : [];
    } catch {
      schedules = [];
    }
  } else {
    schedules = await medplum.searchResources('Schedule', {
      _compartment: `Organization/${organizationId}`,
      active: 'true',
      _count: '10',
    });
  }

  if (schedules.length === 0) {
    return jsonResponse(200, { dates: [], timezone: 'America/Los_Angeles' });
  }

  // Collect available dates across all schedules (parallel)
  const allDates = new Set<string>();
  let timezone = 'America/Los_Angeles';

  const results = await Promise.allSettled(
    schedules.map((schedule) =>
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

async function handlePostRequest(slug: string, body: any): Promise<ApiGatewayResponse> {
  if (!body.firstName || !body.lastName || !body.email) {
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
        honeypot: body.honeypot || undefined,
        submittedAt: body.submittedAt || undefined,
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

// ─── POST /api/booking/{slug}/contact ─────────────────────────────────────

async function handlePostContact(slug: string, body: any): Promise<ApiGatewayResponse> {
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
