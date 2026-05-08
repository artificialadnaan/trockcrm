import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HUBSPOT_BASE_URL = "https://api.hubapi.com";
const OUTPUT_DIR = "migration-snapshot";
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const DEFAULT_BACKOFF_MS = [1_000, 2_500, 5_000];

const ASSOCIATION_TYPES = [
  "contacts",
  "companies",
  "line_items",
  "calls",
  "notes",
  "meetings",
  "emails",
  "tasks",
] as const;

type AssociationType = (typeof ASSOCIATION_TYPES)[number];

const LEAD_ASSOCIATION_TYPES = ["contacts", "companies", "deals"] as const;
type LeadAssociationType = (typeof LEAD_ASSOCIATION_TYPES)[number];

const CONTACT_ASSOCIATION_TYPES = ["companies", "deals", "leads"] as const;
type ContactAssociationType = (typeof CONTACT_ASSOCIATION_TYPES)[number];

const COMPANY_ASSOCIATION_TYPES = ["contacts", "deals", "leads"] as const;
type CompanyAssociationType = (typeof COMPANY_ASSOCIATION_TYPES)[number];

const ENGAGEMENT_OBJECT_TYPES = ["notes", "calls", "emails", "meetings", "tasks"] as const;
type EngagementObjectType = (typeof ENGAGEMENT_OBJECT_TYPES)[number];
const ENGAGEMENT_ASSOCIATION_TYPES = ["deals", "contacts", "companies"] as const;
type EngagementAssociationType = (typeof ENGAGEMENT_ASSOCIATION_TYPES)[number];

interface HubSpotPage<T> {
  results?: T[];
  paging?: {
    next?: {
      after?: string;
      link?: string;
    };
  };
}

interface HubSpotPropertyDefinition {
  name: string;
  label?: string;
  type?: string;
  fieldType?: string;
  groupName?: string;
  options?: unknown[];
  [key: string]: unknown;
}

interface HubSpotPipelineDefinition {
  id: string;
  label: string;
  stages?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface HubSpotOwner {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  archived?: boolean;
  [key: string]: unknown;
}

interface HubSpotAccountDetails {
  portalId: number;
  accountType?: string;
  timeZone?: string;
  uiDomain?: string;
  dataHostingLocation?: string;
  [key: string]: unknown;
}

interface HubSpotDealRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  [key: string]: unknown;
}

interface HubSpotLeadRecord {
  id: string;
  properties: Record<string, string | null>;
  associations?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  [key: string]: unknown;
}

interface HubSpotContactRecord {
  id: string;
  properties: Record<string, string | null>;
  associations?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  [key: string]: unknown;
}

interface HubSpotCompanyRecord {
  id: string;
  properties: Record<string, string | null>;
  associations?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  [key: string]: unknown;
}

interface SnapshotRunMetadata {
  snapshotStartedAt: string;
  snapshotEndedAt?: string;
  source: "hubspot-rest-api";
  hubspotBaseUrl: typeof HUBSPOT_BASE_URL;
  portalId: number;
  accountType?: string;
  uiDomain?: string;
  dataHostingLocation?: string;
}

interface BatchAssociationResult {
  from?: { id?: string };
  to?: unknown[];
  [key: string]: unknown;
}

interface RawDealSnapshotRecord {
  deal: HubSpotDealRecord;
  associations: Partial<Record<AssociationType, BatchAssociationResult | null>>;
  associationCounts: Partial<Record<AssociationType, number>>;
}

interface RawLeadSnapshotRecord {
  lead: HubSpotLeadRecord;
  associationCounts: Partial<Record<LeadAssociationType, number>>;
}

interface RawContactSnapshotRecord {
  contact: HubSpotContactRecord;
  associationCounts: Partial<Record<ContactAssociationType, number>>;
}

interface RawCompanySnapshotRecord {
  company: HubSpotCompanyRecord;
  associationCounts: Partial<Record<CompanyAssociationType, number>>;
}

interface RawEngagementSnapshotRecord {
  engagement: HubSpotDealRecord;
  associationCounts: Partial<Record<EngagementAssociationType, number>>;
}

function usage() {
  console.log(`Usage:
  HUBSPOT_PRIVATE_APP_TOKEN=... node --import tsx scripts/hubspot-full-snapshot-export.ts

Outputs:
  ${OUTPUT_DIR}/hubspot-property-schema.json
  ${OUTPUT_DIR}/hubspot-pipelines.json
  ${OUTPUT_DIR}/hubspot-lead-pipelines.json
  ${OUTPUT_DIR}/hubspot-owners.json
  ${OUTPUT_DIR}/hubspot-owners-all.json
  ${OUTPUT_DIR}/hubspot-raw-export.json
  ${OUTPUT_DIR}/hubspot-lead-property-schema.json
  ${OUTPUT_DIR}/hubspot-leads-raw-export.json
  ${OUTPUT_DIR}/hubspot-contact-property-schema.json
  ${OUTPUT_DIR}/hubspot-contacts-raw-export.json
  ${OUTPUT_DIR}/hubspot-company-property-schema.json
  ${OUTPUT_DIR}/hubspot-companies-raw-export.json

Optional:
  --include-engagements writes:
    ${OUTPUT_DIR}/hubspot-engagement-{type}-property-schema.json
    ${OUTPUT_DIR}/hubspot-engagements-{type}-raw-export.json
  --engagements-only fetches only engagement objects and schemas`);
}

function getToken() {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN?.trim();
  if (!token) {
    throw new Error("HUBSPOT_PRIVATE_APP_TOKEN is required in .env or the shell environment");
  }
  return token;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const retryAt = Date.parse(value);
  if (Number.isFinite(retryAt)) return Math.max(retryAt - Date.now(), 0);
  return null;
}

async function hubspotFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${HUBSPOT_BASE_URL}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      const body = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS - 1) {
        throw new Error(`HubSpot API error ${response.status} ${path}: ${body}`);
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
      const backoffMs = retryAfterMs ?? DEFAULT_BACKOFF_MS[attempt] ?? DEFAULT_BACKOFF_MS.at(-1)!;
      console.warn(`[hubspot:snapshot] ${response.status} from ${path}; retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
    } catch (error) {
      lastError = error;
      const isAbort = error instanceof Error && error.name === "AbortError";
      const retryable = isAbort || String(error).includes("fetch failed");
      if (!retryable || attempt === MAX_ATTEMPTS - 1) {
        if (isAbort) throw new Error(`HubSpot request timed out after ${REQUEST_TIMEOUT_MS}ms: ${path}`);
        throw error;
      }

      const backoffMs = DEFAULT_BACKOFF_MS[attempt] ?? DEFAULT_BACKOFF_MS.at(-1)!;
      console.warn(`[hubspot:snapshot] request failed for ${path}; retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchAllPages<T>(label: string, firstPath: string): Promise<T[]> {
  const results: T[] = [];
  let after: string | undefined;

  do {
    const separator = firstPath.includes("?") ? "&" : "?";
    const path = after ? `${firstPath}${separator}after=${encodeURIComponent(after)}` : firstPath;
    const page = await hubspotFetch<HubSpotPage<T>>(path);
    results.push(...(page.results ?? []));
    after = page.paging?.next?.after;
    console.log(`[hubspot:snapshot] fetched ${results.length} ${label}`);
  } while (after);

  return results;
}

async function fetchPropertySchema() {
  return fetchAllPages<HubSpotPropertyDefinition>(
    "deal properties",
    "/crm/v3/properties/deals?archived=false&limit=100"
  );
}

async function fetchLeadPropertySchema() {
  return fetchAllPages<HubSpotPropertyDefinition>(
    "lead properties",
    "/crm/v3/properties/leads?archived=false&limit=100"
  );
}

async function fetchContactPropertySchema() {
  return fetchAllPages<HubSpotPropertyDefinition>(
    "contact properties",
    "/crm/v3/properties/contacts?archived=false&limit=100"
  );
}

async function fetchCompanyPropertySchema() {
  return fetchAllPages<HubSpotPropertyDefinition>(
    "company properties",
    "/crm/v3/properties/companies?archived=false&limit=100"
  );
}

async function fetchEngagementPropertySchema(objectType: EngagementObjectType) {
  return fetchAllPages<HubSpotPropertyDefinition>(
    `${objectType} properties`,
    `/crm/v3/properties/${objectType}?archived=false&limit=100`
  );
}

async function fetchAccountDetails() {
  return hubspotFetch<HubSpotAccountDetails>("/account-info/v3/details");
}

async function fetchPipelines() {
  return hubspotFetch<{ results?: HubSpotPipelineDefinition[] }>("/crm/v3/pipelines/deals");
}

async function fetchLeadPipelines() {
  return hubspotFetch<{ results?: HubSpotPipelineDefinition[] }>("/crm/v3/pipelines/leads");
}

async function fetchOwners() {
  return fetchAllPages<HubSpotOwner>("owners", "/crm/v3/owners?archived=false&limit=100");
}

async function fetchArchivedOwners() {
  return fetchAllPages<HubSpotOwner>("archived owners", "/crm/v3/owners?archived=true&limit=100");
}

function mergeOwners(activeOwners: HubSpotOwner[], archivedOwners: HubSpotOwner[]) {
  const ownersById = new Map<string, HubSpotOwner>();
  for (const owner of activeOwners) {
    ownersById.set(owner.id, { ...owner, archived: false });
  }
  for (const owner of archivedOwners) {
    ownersById.set(owner.id, { ...owner, archived: true });
  }
  return [...ownersById.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function fetchDealsPage(propertyNames: string[], after?: string) {
  return hubspotFetch<HubSpotPage<HubSpotDealRecord>>("/crm/v3/objects/deals/search", {
    method: "POST",
    body: JSON.stringify({
      limit: PAGE_SIZE,
      after,
      properties: propertyNames,
      sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
    }),
  });
}

async function fetchAssociationsForDeals(dealIds: string[], associationType: AssociationType) {
  if (dealIds.length === 0) return new Map<string, BatchAssociationResult>();

  const response = await hubspotFetch<{ results?: BatchAssociationResult[] }>(
    `/crm/v4/associations/deals/${associationType}/batch/read`,
    {
      method: "POST",
      body: JSON.stringify({
        inputs: dealIds.map((id) => ({ id })),
      }),
    }
  );

  return new Map((response.results ?? []).map((result) => [String(result.from?.id ?? ""), result]));
}

async function fetchAllDealSnapshots(propertyNames: string[]) {
  const snapshots: RawDealSnapshotRecord[] = [];
  let after: string | undefined;

  do {
    const page = await fetchDealsPage(propertyNames, after);
    const deals = page.results ?? [];
    const dealIds = deals.map((deal) => deal.id);
    const associationMaps = new Map<AssociationType, Map<string, BatchAssociationResult>>();

    for (const associationType of ASSOCIATION_TYPES) {
      associationMaps.set(associationType, await fetchAssociationsForDeals(dealIds, associationType));
    }

    for (const deal of deals) {
      const associations: RawDealSnapshotRecord["associations"] = {};
      const associationCounts: RawDealSnapshotRecord["associationCounts"] = {};

      for (const associationType of ASSOCIATION_TYPES) {
        const rawAssociation = associationMaps.get(associationType)?.get(deal.id) ?? null;
        associations[associationType] = rawAssociation;
        associationCounts[associationType] = Array.isArray(rawAssociation?.to) ? rawAssociation.to.length : 0;
      }

      snapshots.push({ deal, associations, associationCounts });
    }

    after = page.paging?.next?.after;
    console.log(`[hubspot:snapshot] fetched ${snapshots.length} deals`);
  } while (after);

  return snapshots;
}

async function fetchAllLeadSnapshots(propertyNames: string[]) {
  const snapshots: RawLeadSnapshotRecord[] = [];
  let after: string | undefined;

  do {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      properties: propertyNames.join(","),
      associations: LEAD_ASSOCIATION_TYPES.join(","),
    });
    if (after) params.set("after", after);

    const page = await hubspotFetch<HubSpotPage<HubSpotLeadRecord>>(`/crm/v3/objects/leads?${params}`);
    const leads = page.results ?? [];

    for (const lead of leads) {
      const associationCounts: RawLeadSnapshotRecord["associationCounts"] = {};
      for (const associationType of LEAD_ASSOCIATION_TYPES) {
        const results = (lead.associations?.[associationType] as { results?: unknown[] } | undefined)?.results;
        associationCounts[associationType] = Array.isArray(results) ? results.length : 0;
      }
      snapshots.push({ lead, associationCounts });
    }

    after = page.paging?.next?.after;
    console.log(`[hubspot:snapshot] fetched ${snapshots.length} leads`);
  } while (after);

  return snapshots;
}

async function fetchAllContactSnapshots(propertyNames: string[]) {
  const snapshots: RawContactSnapshotRecord[] = [];
  let after: string | undefined;

  do {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      properties: propertyNames.join(","),
      associations: CONTACT_ASSOCIATION_TYPES.join(","),
    });
    if (after) params.set("after", after);

    const page = await hubspotFetch<HubSpotPage<HubSpotContactRecord>>(`/crm/v3/objects/contacts?${params}`);
    const contacts = page.results ?? [];

    for (const contact of contacts) {
      const associationCounts: RawContactSnapshotRecord["associationCounts"] = {};
      for (const associationType of CONTACT_ASSOCIATION_TYPES) {
        const results = (contact.associations?.[associationType] as { results?: unknown[] } | undefined)?.results;
        associationCounts[associationType] = Array.isArray(results) ? results.length : 0;
      }
      snapshots.push({ contact, associationCounts });
    }

    after = page.paging?.next?.after;
    console.log(`[hubspot:snapshot] fetched ${snapshots.length} contacts`);
  } while (after);

  return snapshots;
}

async function fetchAllCompanySnapshots(propertyNames: string[]) {
  const snapshots: RawCompanySnapshotRecord[] = [];
  let after: string | undefined;

  do {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      properties: propertyNames.join(","),
      associations: COMPANY_ASSOCIATION_TYPES.join(","),
    });
    if (after) params.set("after", after);

    const page = await hubspotFetch<HubSpotPage<HubSpotCompanyRecord>>(`/crm/v3/objects/companies?${params}`);
    const companies = page.results ?? [];

    for (const company of companies) {
      const associationCounts: RawCompanySnapshotRecord["associationCounts"] = {};
      for (const associationType of COMPANY_ASSOCIATION_TYPES) {
        const results = (company.associations?.[associationType] as { results?: unknown[] } | undefined)?.results;
        associationCounts[associationType] = Array.isArray(results) ? results.length : 0;
      }
      snapshots.push({ company, associationCounts });
    }

    after = page.paging?.next?.after;
    console.log(`[hubspot:snapshot] fetched ${snapshots.length} companies`);
  } while (after);

  return snapshots;
}

async function fetchAllEngagementSnapshots(
  objectType: EngagementObjectType,
  propertyNames: string[]
) {
  const snapshots: RawEngagementSnapshotRecord[] = [];
  let after: string | undefined;

  do {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      properties: propertyNames.join(","),
      associations: ENGAGEMENT_ASSOCIATION_TYPES.join(","),
      archived: "false",
    });
    if (after) params.set("after", after);

    const page = await hubspotFetch<HubSpotPage<HubSpotDealRecord>>(`/crm/v3/objects/${objectType}?${params}`);
    const engagements = page.results ?? [];

    for (const engagement of engagements) {
      const associationCounts: RawEngagementSnapshotRecord["associationCounts"] = {};
      for (const associationType of ENGAGEMENT_ASSOCIATION_TYPES) {
        const results = (engagement.associations?.[associationType] as { results?: unknown[] } | undefined)?.results;
        associationCounts[associationType] = Array.isArray(results) ? results.length : 0;
      }
      snapshots.push({ engagement, associationCounts });
    }

    after = page.paging?.next?.after;
    console.log(`[hubspot:snapshot] fetched ${snapshots.length} ${objectType}`);
  } while (after);

  return snapshots;
}

async function fetchAndWriteEngagementSnapshots(metadata: SnapshotRunMetadata) {
  for (const objectType of ENGAGEMENT_OBJECT_TYPES) {
    try {
      console.log(`[hubspot:snapshot] fetching HubSpot ${objectType} property schema`);
      const propertySchema = await fetchEngagementPropertySchema(objectType);
      const propertyNames = propertySchema.map((property) => property.name).filter(Boolean).sort();
      await writeJson(join(OUTPUT_DIR, `hubspot-engagement-${objectType}-property-schema.json`), withMetadata(metadata, propertySchema));

      console.log(`[hubspot:snapshot] fetching ${objectType} with ${propertyNames.length} properties`);
      const records = await fetchAllEngagementSnapshots(objectType, propertyNames);
      await writeJson(join(OUTPUT_DIR, `hubspot-engagements-${objectType}-raw-export.json`), {
        ...metadata,
        snapshotEndedAt: new Date().toISOString(),
        propertyCount: propertyNames.length,
        engagementType: objectType,
        engagementCount: records.length,
        associationTypes: ENGAGEMENT_ASSOCIATION_TYPES,
        records,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[hubspot:snapshot] ${objectType} export failed: ${message}`);
      await writeJson(join(OUTPUT_DIR, `hubspot-engagements-${objectType}-export-error.json`), {
        ...metadata,
        snapshotEndedAt: new Date().toISOString(),
        engagementType: objectType,
        error: {
          message,
        },
      });
    }
  }
}

async function writeJson(path: string, data: unknown) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`[hubspot:snapshot] wrote ${path}`);
}

function withMetadata<T>(metadata: SnapshotRunMetadata, data: T) {
  return {
    ...metadata,
    data,
  };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const includeEngagements = process.argv.includes("--include-engagements");
  const engagementsOnly = process.argv.includes("--engagements-only");

  await mkdir(OUTPUT_DIR, { recursive: true });

  const snapshotStartedAt = new Date().toISOString();
  console.log(`[hubspot:snapshot] started at ${snapshotStartedAt}`);
  console.log("[hubspot:snapshot] using direct HubSpot REST API base https://api.hubapi.com");

  console.log("[hubspot:snapshot] fetching HubSpot account details");
  const accountDetails = await fetchAccountDetails();
  if (accountDetails.accountType && accountDetails.accountType !== "STANDARD") {
    throw new Error(
      [
        "Refusing to export non-production HubSpot account.",
        `accountType=${accountDetails.accountType}`,
        `portalId=${accountDetails.portalId}`,
        `uiDomain=${accountDetails.uiDomain ?? "unknown"}`,
      ].join(" ")
    );
  }

  const metadata: SnapshotRunMetadata = {
    snapshotStartedAt,
    source: "hubspot-rest-api",
    hubspotBaseUrl: HUBSPOT_BASE_URL,
    portalId: accountDetails.portalId,
    accountType: accountDetails.accountType,
    uiDomain: accountDetails.uiDomain,
    dataHostingLocation: accountDetails.dataHostingLocation,
  };
  console.log(
    `[hubspot:snapshot] portal ${metadata.portalId} accountType=${metadata.accountType ?? "unknown"} uiDomain=${metadata.uiDomain ?? "unknown"}`
  );

  if (engagementsOnly) {
    await fetchAndWriteEngagementSnapshots(metadata);
    return;
  }

  console.log("[hubspot:snapshot] fetching HubSpot deal property schema");
  const propertySchema = await fetchPropertySchema();
  const propertyNames = propertySchema.map((property) => property.name).filter(Boolean).sort();
  await writeJson(join(OUTPUT_DIR, "hubspot-property-schema.json"), withMetadata(metadata, propertySchema));

  console.log("[hubspot:snapshot] fetching HubSpot deal pipelines");
  const pipelines = await fetchPipelines();
  await writeJson(join(OUTPUT_DIR, "hubspot-pipelines.json"), withMetadata(metadata, pipelines));

  console.log("[hubspot:snapshot] fetching HubSpot lead pipelines");
  const leadPipelines = await fetchLeadPipelines();
  await writeJson(join(OUTPUT_DIR, "hubspot-lead-pipelines.json"), withMetadata(metadata, leadPipelines));

  console.log("[hubspot:snapshot] fetching HubSpot owners");
  const owners = await fetchOwners();
  await writeJson(join(OUTPUT_DIR, "hubspot-owners.json"), withMetadata(metadata, owners));

  console.log("[hubspot:snapshot] fetching HubSpot archived owners");
  const archivedOwners = await fetchArchivedOwners();
  await writeJson(join(OUTPUT_DIR, "hubspot-owners-all.json"), withMetadata(metadata, {
    activeCount: owners.length,
    archivedCount: archivedOwners.length,
    owners: mergeOwners(owners, archivedOwners),
  }));

  console.log("[hubspot:snapshot] fetching HubSpot lead property schema");
  const leadPropertySchema = await fetchLeadPropertySchema();
  const leadPropertyNames = leadPropertySchema.map((property) => property.name).filter(Boolean).sort();
  await writeJson(join(OUTPUT_DIR, "hubspot-lead-property-schema.json"), withMetadata(metadata, leadPropertySchema));

  console.log(`[hubspot:snapshot] fetching leads with ${leadPropertyNames.length} properties`);
  const leadSnapshots = await fetchAllLeadSnapshots(leadPropertyNames);
  await writeJson(join(OUTPUT_DIR, "hubspot-leads-raw-export.json"), {
    ...metadata,
    propertyCount: leadPropertyNames.length,
    leadCount: leadSnapshots.length,
    associationTypes: LEAD_ASSOCIATION_TYPES,
    records: leadSnapshots,
  });

  console.log("[hubspot:snapshot] fetching HubSpot contact property schema");
  const contactPropertySchema = await fetchContactPropertySchema();
  const contactPropertyNames = contactPropertySchema.map((property) => property.name).filter(Boolean).sort();
  await writeJson(join(OUTPUT_DIR, "hubspot-contact-property-schema.json"), withMetadata(metadata, contactPropertySchema));

  console.log(`[hubspot:snapshot] fetching contacts with ${contactPropertyNames.length} properties`);
  const contactSnapshots = await fetchAllContactSnapshots(contactPropertyNames);
  await writeJson(join(OUTPUT_DIR, "hubspot-contacts-raw-export.json"), {
    ...metadata,
    propertyCount: contactPropertyNames.length,
    contactCount: contactSnapshots.length,
    associationTypes: CONTACT_ASSOCIATION_TYPES,
    records: contactSnapshots,
  });

  console.log("[hubspot:snapshot] fetching HubSpot company property schema");
  const companyPropertySchema = await fetchCompanyPropertySchema();
  const companyPropertyNames = companyPropertySchema.map((property) => property.name).filter(Boolean).sort();
  await writeJson(join(OUTPUT_DIR, "hubspot-company-property-schema.json"), withMetadata(metadata, companyPropertySchema));

  console.log(`[hubspot:snapshot] fetching companies with ${companyPropertyNames.length} properties`);
  const companySnapshots = await fetchAllCompanySnapshots(companyPropertyNames);
  await writeJson(join(OUTPUT_DIR, "hubspot-companies-raw-export.json"), {
    ...metadata,
    propertyCount: companyPropertyNames.length,
    companyCount: companySnapshots.length,
    associationTypes: COMPANY_ASSOCIATION_TYPES,
    records: companySnapshots,
  });

  console.log(`[hubspot:snapshot] fetching deals with ${propertyNames.length} properties`);
  const dealSnapshots = await fetchAllDealSnapshots(propertyNames);
  const snapshotEndedAt = new Date().toISOString();
  const completedMetadata = { ...metadata, snapshotEndedAt };
  console.log(`[hubspot:snapshot] ended at ${snapshotEndedAt}`);
  await writeJson(join(OUTPUT_DIR, "hubspot-raw-export.json"), {
    ...completedMetadata,
    propertyCount: propertyNames.length,
    dealCount: dealSnapshots.length,
    associationTypes: ASSOCIATION_TYPES,
    records: dealSnapshots,
  });

  if (includeEngagements) {
    await fetchAndWriteEngagementSnapshots(completedMetadata);
  } else {
    console.log("[hubspot:snapshot] engagement object export skipped; pass --include-engagements to fetch notes/calls/emails/meetings/tasks");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
