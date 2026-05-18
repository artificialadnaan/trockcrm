// server/src/modules/migration/hubspot-client.ts

import { fetchWithTimeout } from "../../lib/fetch-timeout.js";

const HS_BASE = "https://api.hubapi.com";
const PAGE_SIZE = 100;
// HubSpot migration reads are batch operations; 30s bounds hung requests while
// allowing large CRM pages enough time to respond.
const HUBSPOT_REQUEST_TIMEOUT_MS = 30_000;
const HUBSPOT_MAX_ATTEMPTS = 3;
const HUBSPOT_BACKOFF_MS = [1_000, 3_000];
const HUBSPOT_RETRY_WAIT_BUDGET_MS = 10_000;

function hsHeaders(): HeadersInit {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) throw new Error("HUBSPOT_PRIVATE_APP_TOKEN not set");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function isRetryableHubSpotStatus(status: number) {
  return status === 429 || status >= 500;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const retryAt = Date.parse(value);
  if (Number.isFinite(retryAt)) return Math.max(retryAt - Date.now(), 0);

  return null;
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function hsFetch<T>(path: string): Promise<T> {
  let remainingRetryWaitMs = HUBSPOT_RETRY_WAIT_BUDGET_MS;

  for (let attempt = 0; attempt < HUBSPOT_MAX_ATTEMPTS; attempt++) {
    const res = await fetchWithTimeout(fetch, `${HS_BASE}${path}`, {
      headers: hsHeaders(),
      timeoutMs: HUBSPOT_REQUEST_TIMEOUT_MS,
      timeoutLabel: `HubSpot ${path}`,
    });

    if (res.ok) {
      return res.json() as Promise<T>;
    }

    const text = await res.text().catch(() => "");
    const shouldRetry = isRetryableHubSpotStatus(res.status) && attempt < HUBSPOT_MAX_ATTEMPTS - 1;
    if (!shouldRetry) {
      throw new Error(`HubSpot API error: ${res.status} ${path} — ${text}`);
    }

    const retryAfterMs = parseRetryAfterMs(res.headers.get("Retry-After"));
    const requestedDelayMs = retryAfterMs ?? HUBSPOT_BACKOFF_MS[attempt] ?? HUBSPOT_BACKOFF_MS.at(-1)!;
    const delayMs = Math.min(requestedDelayMs, remainingRetryWaitMs);
    remainingRetryWaitMs -= delayMs;
    await wait(delayMs);
  }

  throw new Error(`HubSpot API error: exhausted retry attempts for ${path}`);
}

// ---------------------------------------------------------------------------
// Types matching the HubSpot v3 CRM response shape
// ---------------------------------------------------------------------------

export interface HubSpotDeal {
  id: string;
  properties: {
    dealname?: string;
    dealstage?: string;
    hubspot_owner_id?: string;
    amount?: string;
    closedate?: string;
    hs_deal_stage_probability?: string;
    lead_source?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    description?: string;
    project_number?: string;
    hs_lastmodifieddate?: string;
    createdate?: string;
  };
  associations?: {
    contacts?: { results: Array<{ id: string }> };
  };
}

export interface HubSpotContact {
  id: string;
  properties: {
    firstname?: string;
    lastname?: string;
    email?: string;
    phone?: string;
    mobilephone?: string;
    company?: string;
    jobtitle?: string;
    hs_lead_status?: string;
    lifecyclestage?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    hs_lastmodifieddate?: string;
    createdate?: string;
  };
}

export interface HubSpotCompany {
  id: string;
  properties: {
    name?: string;
    domain?: string;
    phone?: string;
    hubspot_owner_id?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    hs_lastmodifieddate?: string;
    createdate?: string;
  };
}

export interface HubSpotActivity {
  id: string;
  properties: {
    hs_activity_type?: string;
    hs_call_title?: string;
    hs_call_body?: string;
    hs_call_duration?: string;
    hs_call_status?: string;
    hs_call_outcome?: string;
    hs_call_recording_url?: string;
    hs_call_has_voicemail?: string;
    hs_meeting_title?: string;
    hs_meeting_body?: string;
    hs_meeting_start_time?: string;
    hs_meeting_end_time?: string;
    hs_internal_meeting_notes?: string;
    hs_timestamp?: string;
    hs_note_body?: string;
    hs_email_subject?: string;
    hs_email_text?: string;
    hs_email_html?: string;
    hs_email_headers?: string;
    hs_email_direction?: string;
    hs_email_status?: string;
    hubspot_owner_id?: string;
    hs_task_subject?: string;
    hs_task_body?: string;
    hs_task_status?: string;
    hs_task_priority?: string;
    hs_task_type?: string;
    hs_task_reminders?: string;
    hs_lastmodifieddate?: string;
  };
  associations?: {
    deals?: { results: Array<{ id: string }> };
    companies?: { results: Array<{ id: string }> };
    contacts?: { results: Array<{ id: string }> };
  };
}

export interface HubSpotOwner {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

export type HubSpotActivityObjectType = "note" | "call" | "meeting" | "email";

const HUBSPOT_ACTIVITY_ENDPOINTS: Record<HubSpotActivityObjectType, string> = {
  note: "notes",
  call: "calls",
  meeting: "meetings",
  email: "emails",
};

export function normalizeHubSpotOwnerEmail(owner: HubSpotOwner): string | null {
  const email = owner.email?.trim().toLowerCase();
  return email && email.length > 0 ? email : null;
}

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

async function fetchAllPages<T>(
  buildUrl: (after?: string) => string,
  extractItems: (body: any) => T[],
  extractNext: (body: any) => string | undefined
): Promise<T[]> {
  const all: T[] = [];
  let after: string | undefined;

  do {
    const body = await hsFetch<any>(buildUrl(after));
    const items = extractItems(body);
    all.push(...items);
    after = extractNext(body);
  } while (after);

  return all;
}

// ---------------------------------------------------------------------------
// Public extraction functions
// ---------------------------------------------------------------------------

const DEAL_PROPERTIES = [
  "dealname", "dealstage", "hubspot_owner_id", "amount", "closedate",
  "hs_deal_stage_probability", "lead_source", "address", "city", "state",
  "zip", "description", "hs_lastmodifieddate", "createdate",
].join(",");

/** Fetch all HubSpot deals with contact associations. */
export async function fetchAllDeals(): Promise<HubSpotDeal[]> {
  return fetchAllPages<HubSpotDeal>(
    (after) => {
      const params = new URLSearchParams({
        properties: DEAL_PROPERTIES,
        associations: "contacts",
        limit: String(PAGE_SIZE),
      });
      if (after) params.set("after", after);
      return `/crm/v3/objects/deals?${params}`;
    },
    (body) => body.results ?? [],
    (body) => body.paging?.next?.after
  );
}

const CONTACT_PROPERTIES = [
  "firstname", "lastname", "email", "phone", "mobilephone", "company",
  "jobtitle", "hs_lead_status", "lifecyclestage", "address", "city",
  "state", "zip", "hs_lastmodifieddate", "createdate",
].join(",");

/** Fetch all HubSpot contacts. */
export async function fetchAllContacts(): Promise<HubSpotContact[]> {
  return fetchAllPages<HubSpotContact>(
    (after) => {
      const params = new URLSearchParams({
        properties: CONTACT_PROPERTIES,
        limit: String(PAGE_SIZE),
      });
      if (after) params.set("after", after);
      return `/crm/v3/objects/contacts?${params}`;
    },
    (body) => body.results ?? [],
    (body) => body.paging?.next?.after
  );
}

const COMPANY_PROPERTIES = [
  "name",
  "domain",
  "phone",
  "hubspot_owner_id",
  "address",
  "city",
  "state",
  "zip",
  "hs_lastmodifieddate",
  "createdate",
].join(",");

/** Fetch all HubSpot companies. */
export async function fetchAllCompanies(): Promise<HubSpotCompany[]> {
  return fetchAllPages<HubSpotCompany>(
    (after) => {
      const params = new URLSearchParams({
        properties: COMPANY_PROPERTIES,
        limit: String(PAGE_SIZE),
      });
      if (after) params.set("after", after);
      return `/crm/v3/objects/companies?${params}`;
    },
    (body) => body.results ?? [],
    (body) => body.paging?.next?.after
  );
}

/** Fetch all engagement/activity objects: calls, notes, meetings, emails. */
export async function fetchAllActivities(): Promise<HubSpotActivity[]> {
  const types = ["call", "note", "meeting", "email"] as const;
  const all: HubSpotActivity[] = [];

  for (const type of types) {
    const items = await fetchHubSpotActivitiesByType(type);
    all.push(...items);
  }

  return all;
}

export async function fetchHubSpotActivitiesByType(type: HubSpotActivityObjectType): Promise<HubSpotActivity[]> {
  const props = buildActivityProperties(type);
  const endpoint = HUBSPOT_ACTIVITY_ENDPOINTS[type];
  const items = await fetchAllPages<HubSpotActivity>(
    (after) => {
      const params = new URLSearchParams({
        properties: props,
        associations: "deals,companies,contacts",
        limit: String(PAGE_SIZE),
      });
      if (after) params.set("after", after);
      return `/crm/v3/objects/${endpoint}?${params}`;
    },
    (body) => body.results ?? [],
    (body) => body.paging?.next?.after
  );

  for (const item of items) {
    (item as any).__type = endpoint;
    (item as any).objectType = type;
  }

  return items;
}

function buildActivityProperties(type: HubSpotActivityObjectType): string {
  const base = ["hubspot_owner_id", "hs_timestamp", "hs_lastmodifieddate"];
  const typeProps: Record<HubSpotActivityObjectType, string[]> = {
    call: [
      "hs_call_title",
      "hs_call_body",
      "hs_call_duration",
      "hs_call_status",
      "hs_call_outcome",
      "hs_call_recording_url",
      "hs_call_has_voicemail",
    ],
    note: ["hs_note_body"],
    meeting: [
      "hs_meeting_title",
      "hs_meeting_body",
      "hs_meeting_start_time",
      "hs_meeting_end_time",
      "hs_internal_meeting_notes",
    ],
    email: [
      "hs_email_subject",
      "hs_email_text",
      "hs_email_html",
      "hs_email_headers",
      "hs_email_direction",
      "hs_email_status",
    ],
  };
  return [...base, ...(typeProps[type] ?? [])].join(",");
}

/** Fetch all owners (used to resolve hubspot_owner_id -> email for rep matching). */
export async function fetchAllOwners(): Promise<HubSpotOwner[]> {
  const body = await hsFetch<{ results: HubSpotOwner[] }>("/crm/v3/owners?limit=500");
  return body.results ?? [];
}
