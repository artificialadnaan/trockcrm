// server/src/modules/migration/hubspot-client.ts

const HS_BASE = "https://api.hubapi.com";
const PAGE_SIZE = 100;

function hsHeaders(): HeadersInit {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) throw new Error("HUBSPOT_PRIVATE_APP_TOKEN not set");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function hsFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${HS_BASE}${path}`, { headers: hsHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot API error: ${res.status} ${path} — ${text}`);
  }
  return res.json() as Promise<T>;
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

export interface HubSpotActivity {
  id: string;
  properties: {
    hs_activity_type?: string;
    hs_call_title?: string;
    hs_call_body?: string;
    hs_call_duration?: string;
    hs_call_outcome?: string;
    hs_meeting_title?: string;
    hs_meeting_body?: string;
    hs_timestamp?: string;
    hs_note_body?: string;
    hs_email_subject?: string;
    hs_email_text?: string;
    hubspot_owner_id?: string;
    hs_lastmodifieddate?: string;
  };
  associations?: {
    deals?: { results: Array<{ id: string }> };
    contacts?: { results: Array<{ id: string }> };
  };
}

export interface HubSpotOwner {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
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

/** Fetch all engagement/activity objects: calls, notes, meetings, emails. */
export async function fetchAllActivities(): Promise<HubSpotActivity[]> {
  const types = ["calls", "notes", "meetings", "emails"] as const;
  const all: HubSpotActivity[] = [];

  for (const type of types) {
    const props = buildActivityProperties(type);
    const items = await fetchAllPages<HubSpotActivity>(
      (after) => {
        const params = new URLSearchParams({
          properties: props,
          associations: "deals,contacts",
          limit: String(PAGE_SIZE),
        });
        if (after) params.set("after", after);
        return `/crm/v3/objects/${type}?${params}`;
      },
      (body) => body.results ?? [],
      (body) => body.paging?.next?.after
    );
    // Tag each item with its engagement type for mapping
    for (const item of items) {
      (item as any).__type = type;
    }
    all.push(...items);
  }

  return all;
}

function buildActivityProperties(type: string): string {
  const base = ["hubspot_owner_id", "hs_timestamp", "hs_lastmodifieddate"];
  const typeProps: Record<string, string[]> = {
    calls: ["hs_call_title", "hs_call_body", "hs_call_duration", "hs_call_outcome"],
    notes: ["hs_note_body"],
    meetings: ["hs_meeting_title", "hs_meeting_body"],
    emails: ["hs_email_subject", "hs_email_text"],
  };
  return [...base, ...(typeProps[type] ?? [])].join(",");
}

/** Fetch all owners (used to resolve hubspot_owner_id -> email for rep matching). */
export async function fetchAllOwners(): Promise<HubSpotOwner[]> {
  const body = await hsFetch<{ results: HubSpotOwner[] }>("/crm/v3/owners?limit=500");
  return body.results ?? [];
}
