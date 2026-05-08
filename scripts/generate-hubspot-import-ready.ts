import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type HubSpotEnvelope<T> = {
  records: T[];
  snapshotStartedAt?: string;
  snapshotEndedAt?: string;
};

type HubSpotObject = {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
};

type AssociationTarget = {
  toObjectId?: number | string;
  id?: number | string;
};

type AssociationBlock =
  | null
  | {
      to?: AssociationTarget[];
      results?: AssociationTarget[];
    };

type WrappedRecord<K extends string> = {
  [P in K]: HubSpotObject;
} & {
  associations?: Record<string, AssociationBlock>;
  associationCounts?: Record<string, number>;
};

type Owner = {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  archived?: boolean;
};

type Pipeline = {
  label: string;
  stages: Array<{ id: string; label: string }>;
};

type UserSeed = {
  generatedAt: string;
  source: string;
  defaultOfficeSlug: string;
  users: Array<{
    id: string;
    email: string;
    displayName: string;
    firstName: string;
    lastName: string;
    role: "rep" | "director" | "admin";
    officeSlug: string;
    isActive: boolean;
    source: "hubspot_owner" | "manual_create";
    hubspotOwnerIds: string[];
    notes: string;
  }>;
};

const SNAPSHOT_DIR = "migration-snapshot";
const TEMPLATE_DIR = join(SNAPSHOT_DIR, "import-templates");
const OUTPUT_DIR = join(SNAPSHOT_DIR, "import-ready");

const ADNAAN_OWNER_ID = "162419091";
const ANDREW_OWNER_IDS = new Set(["163096130", "1852094128"]);
const ADMIN_QUEUE_OWNER_IDS = new Set(["160660378", "79057209", "160891618"]);

const DEAL_STAGE_TO_CRM_SLUG: Record<string, string> = {
  "Pipe Line": "new_lead",
  RFP: "opportunity",
  Estimating: "estimating",
  "Internal Review": "estimate_under_review",
  "Proposal Sent": "estimate_sent_to_client",
  "Closed Won": "won",
  "Closed Lost": "lost",
  "On Hold": "estimate_sent_to_client",
  "Deal Canceled": "lost",
  "Service - Estimating": "service_estimating",
  "Service - Won": "won",
  "Service - Lost": "lost",
};

const LEAD_STAGE_TO_CRM_SLUG: Record<string, string> = {
  Connected: "qualified_lead",
  Qualified: "qualified_lead",
};

const TERMINAL_DEAL_LABELS = new Set([
  "Closed Won",
  "Closed Lost",
  "Deal Canceled",
  "Service - Won",
  "Service - Lost",
]);

const IMPORTED_HISTORICAL_LABELS = new Set([
  "Closed Won",
  "Closed Lost",
  "Deal Canceled",
  "Service - Won",
  "Service - Lost",
]);

const MAPPED_COMPANY_PROPS = new Set([
  "name",
  "phone",
  "website",
  "domain",
  "address",
  "city",
  "state",
  "zip",
  "description",
  "hubspot_owner_id",
]);

const MAPPED_CONTACT_PROPS = new Set([
  "firstname",
  "lastname",
  "email",
  "phone",
  "mobilephone",
  "company",
  "jobtitle",
  "address",
  "city",
  "state",
  "zip",
  "hubspot_owner_id",
]);

const MAPPED_DEAL_PROPS = new Set([
  "dealname",
  "dealstage",
  "hubspot_owner_id",
  "amount",
  "closedate",
  "description",
  "estimator",
  "address",
  "city",
  "state",
  "zip",
  "createdate",
  "hs_lastmodifieddate",
  "notes_last_updated",
  "hs_last_activity_date",
]);

const MAPPED_LEAD_PROPS = new Set([
  "hs_pipeline_stage",
  "hs_lead_name",
  "hs_object_id",
  "hubspot_owner_id",
  "hs_associated_company_name",
  "hs_associated_contact_firstname",
  "hs_associated_contact_lastname",
  "hs_associated_contact_email",
  "hs_lead_label",
  "hs_createdate",
  "hs_lastmodifieddate",
  "hs_last_activity_date",
]);

const MAPPED_ENGAGEMENT_PROPS = new Set([
  "hs_timestamp",
  "hs_createdate",
  "hs_lastmodifieddate",
  "hubspot_owner_id",
  "hs_note_body",
  "hs_note_preview",
  "hs_body_preview",
  "hs_call_body",
  "hs_call_title",
  "hs_call_disposition",
  "hs_call_duration",
  "hs_meeting_title",
  "hs_meeting_body",
  "hs_meeting_outcome",
  "hs_task_subject",
  "hs_task_body",
  "hs_task_status",
]);

const TARGET_USERS = [
  { displayName: "Colby Burling", email: "cburling@trockgc.com", role: "rep" as const, hubspotOwnerIds: ["81630582"] },
  { displayName: "Timothy Mitchell", email: "tmitchell@trockgc.com", role: "rep" as const, hubspotOwnerIds: ["1601591180"] },
  { displayName: "Kaleb Marshall", email: "kmarshall@trockgc.com", role: "rep" as const, hubspotOwnerIds: ["80564341"] },
  { displayName: "Derek Barr", email: "dbarr@trockgc.com", role: "rep" as const, hubspotOwnerIds: ["160213489"] },
  { displayName: "Chris Higingbotham", email: "chigingbotham@trockgc.com", role: "rep" as const, hubspotOwnerIds: ["160660874"] },
  { displayName: "Andrew Green", email: "agreen@trockgc.com", role: "rep" as const, hubspotOwnerIds: ["163096130", "1852094128"] },
  { displayName: "Kevin Scott", email: "kscott@trockgc.com", role: "rep" as const, hubspotOwnerIds: ["160660379"] },
  { displayName: "Edward McCarty", email: "emccarty@trockgc.com", role: "rep" as const, hubspotOwnerIds: ["163664331"] },
  { displayName: "Adam Shaw", email: "ashaw@trockgc.com", role: "rep" as const, hubspotOwnerIds: ["662883164"] },
  { displayName: "Brett Bell", email: "bbell@trockgc.com", role: "rep" as const, hubspotOwnerIds: ["79593330"] },
  { displayName: "James Helms", email: "jhelms@trockgc.com", role: "rep" as const, hubspotOwnerIds: ["81162964"] },
  { displayName: "Takashi Yamashita", email: "tyamashita@trockgc.com", role: "director" as const, hubspotOwnerIds: ["163874455"] },
  { displayName: "T Rock Migration Admin", email: "admin@trockgc.com", role: "admin" as const, hubspotOwnerIds: [] },
];

function stableUuid(input: string): string {
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readTemplateHeader(filename: string): Promise<string[]> {
  const text = await readFile(join(TEMPLATE_DIR, filename), "utf8");
  const line = text.split(/\r?\n/).find((entry) => entry.trim() && !entry.startsWith("#"));
  if (!line) throw new Error(`No CSV header found in ${filename}`);
  return parseCsvHeader(line);
}

function parseCsvHeader(line: string): string[] {
  return line.split(",").map((value) => value.trim());
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const stringValue = typeof value === "string" ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(stringValue)) return `"${stringValue.replace(/"/g, '""')}"`;
  return stringValue;
}

function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")).join("\n")}\n`;
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function assocIds(record: { associations?: Record<string, AssociationBlock> }, key: string): string[] {
  const nestedAssociations =
    (record as { engagement?: { associations?: Record<string, AssociationBlock> } }).engagement?.associations ??
    (record as { lead?: { associations?: Record<string, AssociationBlock> } }).lead?.associations ??
    (record as { contact?: { associations?: Record<string, AssociationBlock> } }).contact?.associations ??
    (record as { company?: { associations?: Record<string, AssociationBlock> } }).company?.associations ??
    (record as { deal?: { associations?: Record<string, AssociationBlock> } }).deal?.associations;
  const block = record.associations?.[key] ?? nestedAssociations?.[key];
  if (!block) return [];
  const entries = "to" in block && block.to ? block.to : "results" in block && block.results ? block.results : [];
  return entries.map((entry) => String(entry.toObjectId ?? entry.id)).filter(Boolean);
}

function firstAssoc(record: { associations?: Record<string, AssociationBlock> }, key: string): string | undefined {
  return assocIds(record, key)[0];
}

function buildPopulatedKeys<K extends string>(
  records: Array<WrappedRecord<K>>,
  objectKey: K,
): Set<string> {
  const keys = new Set<string>();
  for (const record of records) {
    const properties = (record[objectKey] as HubSpotObject).properties;
    for (const [key, value] of Object.entries(properties)) {
      if (isPresent(value)) keys.add(key);
    }
  }
  return keys;
}

function extraProperties(
  object: HubSpotObject,
  populatedKeys: Set<string>,
  mappedKeys: Set<string>,
  additional: Record<string, unknown> = {},
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...additional };
  for (const [key, value] of Object.entries(object.properties)) {
    if (!populatedKeys.has(key)) continue;
    if (mappedKeys.has(key)) continue;
    if (!isPresent(value)) continue;
    output[key] = value;
  }
  return output;
}

function jsonForCsv(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function normalizePhone(value: string | null | undefined): string {
  if (!value) return "";
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return value;
}

function ownerName(owner: Owner | undefined): string {
  if (!owner) return "";
  return [owner.firstName, owner.lastName].filter(Boolean).join(" ").trim();
}

function splitName(displayName: string): { firstName: string; lastName: string } {
  const [firstName, ...rest] = displayName.split(/\s+/);
  return { firstName, lastName: rest.join(" ") };
}

function ownerEmailForImport(ownerId: string | null | undefined, ownersById: Map<string, Owner>): string {
  if (!ownerId) return "";
  if (ANDREW_OWNER_IDS.has(ownerId)) return "agreen@trockgc.com";
  if (ownerId === "1601591180") return "tmitchell@trockgc.com";
  const email = ownersById.get(ownerId)?.email ?? "";
  if (email.endsWith("@trockcontracting.com")) return email.replace("@trockcontracting.com", "@trockgc.com");
  return email;
}

function userIdForOwner(ownerId: string | null | undefined, ownersById: Map<string, Owner>): string {
  if (!ownerId || ADMIN_QUEUE_OWNER_IDS.has(ownerId)) return "";
  const email = ownerEmailForImport(ownerId, ownersById);
  if (!email || email === "adnaan.iqbal@gmail.com") return "";
  return stableUuid(`user:${email.toLowerCase()}`);
}

function findDealStageLabelById(pipelines: Pipeline[], stageId: string): string {
  for (const pipeline of pipelines) {
    const stage = pipeline.stages.find((entry) => entry.id === stageId);
    if (stage) return stage.label.trim();
  }
  return stageId;
}

function findLeadStageLabel(lead: HubSpotObject): string {
  const props = lead.properties;
  const stageId = props.hs_pipeline_stage ?? props.hs_lead_stage ?? props.hs_lead_status ?? "";
  if (stageId === "connected-stage-id") return "Connected";
  if (stageId === "qualified-stage-id") return "Qualified";
  if (stageId === "new-stage-id") return "New";
  if (stageId === "attempting-stage-id") return "Attempting";
  if (stageId === "unqualified-stage-id") return "Disqualified";
  return String(stageId || "");
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  return values.find((value) => isPresent(value)) ?? "";
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const [dealHeader, leadHeader, contactHeader, companyHeader, engagementHeader] = await Promise.all([
    readTemplateHeader("deals-import-template.csv"),
    readTemplateHeader("leads-import-template.csv"),
    readTemplateHeader("contacts-import-template.csv"),
    readTemplateHeader("companies-import-template.csv"),
    readTemplateHeader("engagements-import-template.csv"),
  ]);

  const dealsEnvelope = await readJson<HubSpotEnvelope<WrappedRecord<"deal">>>(join(SNAPSHOT_DIR, "hubspot-raw-export.json"));
  const leadsEnvelope = await readJson<HubSpotEnvelope<WrappedRecord<"lead">>>(join(SNAPSHOT_DIR, "hubspot-leads-raw-export.json"));
  const contactsEnvelope = await readJson<HubSpotEnvelope<WrappedRecord<"contact">>>(join(SNAPSHOT_DIR, "hubspot-contacts-raw-export.json"));
  const companiesEnvelope = await readJson<HubSpotEnvelope<WrappedRecord<"company">>>(join(SNAPSHOT_DIR, "hubspot-companies-raw-export.json"));
  const ownersEnvelope = await readJson<{ data: { owners: Owner[] } }>(join(SNAPSHOT_DIR, "hubspot-owners-all.json"));
  const pipelinesEnvelope = await readJson<{ data: { results: Pipeline[] } }>(join(SNAPSHOT_DIR, "hubspot-pipelines.json"));

  const ownersById = new Map(ownersEnvelope.data.owners.map((owner) => [owner.id, owner]));
  const pipelines = pipelinesEnvelope.data.results;
  const generatedAt = new Date().toISOString();

  const companyPopulatedKeys = buildPopulatedKeys(companiesEnvelope.records, "company");
  const contactPopulatedKeys = buildPopulatedKeys(contactsEnvelope.records, "contact");
  const dealPopulatedKeys = buildPopulatedKeys(dealsEnvelope.records, "deal");
  const leadPopulatedKeys = buildPopulatedKeys(leadsEnvelope.records, "lead");

  const excludedCompanyIds = new Set(
    companiesEnvelope.records
      .filter((record) => record.company.properties.hubspot_owner_id === ADNAAN_OWNER_ID)
      .map((record) => record.company.id),
  );

  const excludedDealIds = new Set(
    dealsEnvelope.records
      .filter((record) => record.deal.properties.hubspot_owner_id === ADNAAN_OWNER_ID)
      .map((record) => record.deal.id),
  );

  const leadDealSourceIds = new Set(
    dealsEnvelope.records
      .filter((record) => !excludedDealIds.has(record.deal.id))
      .filter((record) => DEAL_STAGE_TO_CRM_SLUG[findDealStageLabelById(pipelines, String(record.deal.properties.dealstage))] === "new_lead")
      .map((record) => record.deal.id),
  );

  const contactExclusionReasons = new Map<string, string>();
  for (const record of contactsEnvelope.records) {
    const companyIds = assocIds(record, "companies");
    const dealIds = assocIds(record, "deals");
    const leadIds = assocIds(record, "leads");
    if (
      companyIds.length > 0 &&
      companyIds.every((id) => excludedCompanyIds.has(id)) &&
      dealIds.length === 0 &&
      leadIds.length === 0
    ) {
      contactExclusionReasons.set(record.contact.id, "only associated to excluded Adnaan/test companies");
    }
  }

  const importedCompanyIds = new Set<string>();
  const companyIdByDomain = new Map<string, string>();
  const companyIdByName = new Map<string, string>();
  const usedCompanySlugs = new Map<string, number>();
  const companyRows = companiesEnvelope.records
    .filter((record) => !excludedCompanyIds.has(record.company.id))
    .map((record) => {
      const company = record.company;
      importedCompanyIds.add(company.id);
      const props = company.properties;
      if (props.domain) companyIdByDomain.set(props.domain.toLowerCase(), company.id);
      if (props.name) companyIdByName.set(props.name.toLowerCase(), company.id);
      const name = firstNonEmpty(props.name, `HubSpot Company ${company.id}`);
      const baseSlug = slugify(name, `hubspot-company-${company.id}`);
      const previousSlugUses = usedCompanySlugs.get(baseSlug) ?? 0;
      usedCompanySlugs.set(baseSlug, previousSlugUses + 1);
      return {
        id: stableUuid(`company:${company.id}`),
        name,
        slug: previousSlugUses === 0 ? baseSlug : `${baseSlug}-${company.id}`,
        category: "client",
        address: firstNonEmpty(props.address, props.address2),
        city: props.city ?? "",
        state: props.state ?? "",
        zip: props.zip ?? props.zipcode ?? "",
        phone: props.phone ?? "",
        website: firstNonEmpty(props.website, props.domain),
        source_refs: jsonForCsv({
          hubspot_company_id: company.id,
          hubspot_owner_id: props.hubspot_owner_id ?? null,
          hubspot_owner_email: ownerEmailForImport(props.hubspot_owner_id, ownersById) || null,
          associated_contact_ids: assocIds(record, "contacts"),
          associated_deal_ids: assocIds(record, "deals"),
          associated_lead_ids: assocIds(record, "leads"),
        }),
        notes: props.description ?? "",
        company_verification_status: "",
        assigned_approver_user_id: "",
        is_test_data: "false",
        is_active: "true",
        hubspot_extra_properties: jsonForCsv(
          extraProperties(company, companyPopulatedKeys, MAPPED_COMPANY_PROPS, {
            hubspot_company_id: company.id,
          }),
        ),
      };
    });

  const importedContactIds = new Set<string>();
  const contactRows = contactsEnvelope.records
    .filter((record) => !contactExclusionReasons.has(record.contact.id))
    .map((record) => {
      const contact = record.contact;
      importedContactIds.add(contact.id);
      const props = contact.properties;
      const companyId = firstAssoc(record, "companies");
      return {
        id: stableUuid(`contact:${contact.id}`),
        first_name: firstNonEmpty(props.firstname, "Unknown"),
        last_name: firstNonEmpty(props.lastname, "Contact"),
        email: props.email ?? "",
        phone: props.phone ?? "",
        mobile: props.mobilephone ?? "",
        company_name: props.company ?? "",
        company_id: companyId && importedCompanyIds.has(companyId) ? stableUuid(`company:${companyId}`) : "",
        job_title: props.jobtitle ?? "",
        category: "client",
        address: props.address ?? "",
        city: props.city ?? "",
        state: props.state ?? "",
        zip: props.zip ?? "",
        notes: "",
        touchpoint_count: String(
          (record.associationCounts?.notes ?? 0) +
            (record.associationCounts?.calls ?? 0) +
            (record.associationCounts?.meetings ?? 0) +
            (record.associationCounts?.tasks ?? 0),
        ),
        last_contacted_at: props.notes_last_updated ?? props.hs_last_sales_activity_date ?? props.hs_lastmodifieddate ?? "",
        first_outreach_completed: "false",
        hubspot_contact_id: contact.id,
        source_refs: jsonForCsv({
          hubspot_contact_id: contact.id,
          hubspot_owner_id: props.hubspot_owner_id ?? null,
          hubspot_owner_email: ownerEmailForImport(props.hubspot_owner_id, ownersById) || null,
          hubspot_company_ids: assocIds(record, "companies"),
          hubspot_deal_ids: assocIds(record, "deals"),
          hubspot_lead_ids: assocIds(record, "leads"),
        }),
        normalized_phone: normalizePhone(props.phone || props.mobilephone),
        is_test_data: "false",
        is_active: "true",
        hubspot_extra_properties: jsonForCsv(
          extraProperties(contact, contactPopulatedKeys, MAPPED_CONTACT_PROPS, {
            hubspot_contact_id: contact.id,
          }),
        ),
      };
    });

  const dealRows: Record<string, unknown>[] = [];
  const leadRows: Record<string, unknown>[] = [];

  for (const record of dealsEnvelope.records) {
    const deal = record.deal;
    if (excludedDealIds.has(deal.id)) continue;

    const props = deal.properties;
    const sourceStageLabel = findDealStageLabelById(pipelines, String(props.dealstage));
    const targetStageSlug = DEAL_STAGE_TO_CRM_SLUG[sourceStageLabel];
    if (!targetStageSlug) {
      throw new Error(`No locked CRM stage mapping for HubSpot deal stage ${sourceStageLabel} (${props.dealstage})`);
    }

    const ownerId = props.hubspot_owner_id ?? "";
    const owner = ownersById.get(ownerId);
    const ownerEmail = ownerEmailForImport(ownerId, ownersById);
    const assignedRepId = userIdForOwner(ownerId, ownersById);
    const companyId = firstAssoc(record, "companies");
    const contactId = firstAssoc(record, "contacts");
    const amount = props.amount ?? "";
    const isTerminal = TERMINAL_DEAL_LABELS.has(sourceStageLabel);
    const workflowRoute = sourceStageLabel.startsWith("Service") ? "service" : "normal";
    const pipelineDisposition = workflowRoute === "service" ? "service" : "deals";
    const ownershipStatus = assignedRepId ? "matched" : "unmatched";
    const unassignedReason = assignedRepId ? "" : owner?.archived ? "inactive_owner_match" : "owner_mapping_failure";
    const commonExtra = {
      source_hubspot_object_type: "deal",
      source_hubspot_deal_id: deal.id,
      source_hubspot_stage_id: props.dealstage,
      source_hubspot_stage_label: sourceStageLabel,
      target_crm_stage_slug: targetStageSlug,
      source_hubspot_owner_name: ownerName(owner),
      source_hubspot_owner_archived: owner?.archived ?? null,
      imported_historical_record: IMPORTED_HISTORICAL_LABELS.has(sourceStageLabel),
      leadership_review_flags: [
        sourceStageLabel === "On Hold" ? "on_hold_stage_review" : null,
        !isPresent(amount) || Number(amount) <= 0 || Number(amount) > 10_000_000 ? "suspect_or_missing_amount" : null,
      ].filter(Boolean),
    };

    if (targetStageSlug === "new_lead") {
      leadRows.push({
        id: stableUuid(`lead:deal:${deal.id}`),
        company_id: companyId && importedCompanyIds.has(companyId) ? stableUuid(`company:${companyId}`) : "",
        property_id: "",
        primary_contact_id: contactId && importedContactIds.has(contactId) ? stableUuid(`contact:${contactId}`) : "",
        name: firstNonEmpty(props.dealname, `HubSpot Deal ${deal.id}`),
        stage_id: targetStageSlug,
        assigned_rep_id: assignedRepId,
        sales_rep_id: assignedRepId,
        pipeline_type: "normal",
        status: "open",
        source: "HubSpot",
        source_category: "Other",
        source_detail: "Routed to Leads new_lead by locked migration decision",
        hubspot_owner_id: ownerId,
        hubspot_owner_email: ownerEmail,
        ownership_sync_status: ownershipStatus,
        unassigned_reason_code: unassignedReason,
        description: props.description ?? "",
        office_code: "dfw",
        project_type: "",
        qualification_payload: jsonForCsv({}),
        project_type_question_payload: jsonForCsv({}),
        bid_due_date: props.closedate ?? "",
        pre_qual_value: amount,
        last_activity_at: props.hs_last_activity_date ?? props.notes_last_updated ?? props.hs_lastmodifieddate ?? "",
        stage_entered_at: props.createdate ?? "",
        is_test_data: "false",
        is_active: "true",
        hubspot_extra_properties: jsonForCsv(extraProperties(deal, dealPopulatedKeys, MAPPED_DEAL_PROPS, commonExtra)),
      });
      continue;
    }

    dealRows.push({
      id: stableUuid(`deal:${deal.id}`),
      deal_number: `HS-${deal.id}`,
      name: firstNonEmpty(props.dealname, `HubSpot Deal ${deal.id}`),
      stage_id: targetStageSlug,
      assigned_rep_id: assignedRepId,
      primary_contact_id: contactId && importedContactIds.has(contactId) ? stableUuid(`contact:${contactId}`) : "",
      company_id: companyId && importedCompanyIds.has(companyId) ? stableUuid(`company:${companyId}`) : "",
      property_id: "",
      dd_estimate: "",
      bid_estimate: isTerminal ? "" : amount,
      awarded_amount: isTerminal ? amount : "",
      description: props.description ?? "",
      estimator: props.estimator ?? "",
      property_address: props.address ?? "",
      property_city: props.city ?? "",
      property_state: props.state ?? "",
      property_zip: props.zip ?? "",
      source: "HubSpot",
      hubspot_owner_id: ownerId,
      hubspot_owner_email: ownerEmail,
      ownership_sync_status: ownershipStatus,
      unassigned_reason_code: unassignedReason,
      expected_close_date: isTerminal ? "" : props.closedate ?? "",
      actual_close_date: isTerminal ? props.closedate ?? "" : "",
      last_synced_from_hubspot_at: generatedAt,
      last_activity_at: props.hs_last_activity_date ?? props.notes_last_updated ?? props.hs_lastmodifieddate ?? "",
      stage_entered_at: props.createdate ?? "",
      is_active: "true",
      hubspot_deal_id: deal.id,
      is_test_data: "false",
      pipeline_disposition: pipelineDisposition,
      workflow_route: workflowRoute,
      hubspot_extra_properties: jsonForCsv(extraProperties(deal, dealPopulatedKeys, MAPPED_DEAL_PROPS, commonExtra)),
    });
  }

  for (const record of leadsEnvelope.records) {
    const lead = record.lead;
    const props = lead.properties;
    const sourceStageLabel = findLeadStageLabel(lead);
    const targetStageSlug = LEAD_STAGE_TO_CRM_SLUG[sourceStageLabel];
    if (!targetStageSlug) continue;
    const ownerId = props.hubspot_owner_id ?? props.hs_all_owner_ids ?? "";
    const owner = ownersById.get(ownerId);
    const ownerEmail = ownerEmailForImport(ownerId, ownersById);
    const assignedRepId = userIdForOwner(ownerId, ownersById);
    const companyId =
      firstAssoc(record, "companies") ??
      (props.hs_associated_company_domain ? companyIdByDomain.get(props.hs_associated_company_domain.toLowerCase()) : undefined) ??
      (props.hs_associated_company_name ? companyIdByName.get(props.hs_associated_company_name.toLowerCase()) : undefined);
    const contactId = firstAssoc(record, "contacts");
    const leadName = firstNonEmpty(
      props.hs_lead_name,
      [props.hs_associated_company_name, props.hs_associated_contact_firstname, props.hs_associated_contact_lastname]
        .filter(Boolean)
        .join(" - "),
      `HubSpot Lead ${lead.id}`,
    );
    leadRows.push({
      id: stableUuid(`lead:${lead.id}`),
      company_id: companyId && importedCompanyIds.has(companyId) ? stableUuid(`company:${companyId}`) : "",
      property_id: "",
      primary_contact_id: contactId && importedContactIds.has(contactId) ? stableUuid(`contact:${contactId}`) : "",
      name: leadName,
      stage_id: targetStageSlug,
      assigned_rep_id: assignedRepId,
      sales_rep_id: assignedRepId,
      pipeline_type: "normal",
      status: "open",
      source: "HubSpot",
      source_category: "Other",
      source_detail: `${sourceStageLabel} -> ${targetStageSlug}`,
      hubspot_owner_id: ownerId,
      hubspot_owner_email: ownerEmail,
      ownership_sync_status: assignedRepId ? "matched" : "unmatched",
      unassigned_reason_code: assignedRepId ? "" : owner?.archived ? "inactive_owner_match" : "owner_mapping_failure",
      description: "",
      office_code: "dfw",
      project_type: "",
      qualification_payload: jsonForCsv({}),
      project_type_question_payload: jsonForCsv({}),
      bid_due_date: "",
      pre_qual_value: "",
      last_activity_at: props.hs_last_activity_date ?? props.hs_lastmodifieddate ?? "",
      stage_entered_at: props.hs_createdate ?? "",
      is_test_data: "false",
      is_active: "true",
      hubspot_extra_properties: jsonForCsv(
        extraProperties(lead, leadPopulatedKeys, MAPPED_LEAD_PROPS, {
          source_hubspot_object_type: "lead",
          source_hubspot_lead_id: lead.id,
          source_hubspot_stage_label: sourceStageLabel,
          target_crm_stage_slug: targetStageSlug,
          source_hubspot_owner_name: ownerName(owner),
          source_hubspot_owner_archived: owner?.archived ?? null,
        }),
      ),
    });
  }

  const engagementRows: Record<string, unknown>[] = [];
  for (const [kind, filename] of [
    ["notes", "hubspot-engagements-notes-raw-export.json"],
    ["calls", "hubspot-engagements-calls-raw-export.json"],
    ["meetings", "hubspot-engagements-meetings-raw-export.json"],
    ["tasks", "hubspot-engagements-tasks-raw-export.json"],
  ] as const) {
    const envelope = await readJson<HubSpotEnvelope<WrappedRecord<"engagement">>>(join(SNAPSHOT_DIR, filename));
    const populatedKeys = buildPopulatedKeys(envelope.records, "engagement");
    for (const record of envelope.records) {
      const engagement = record.engagement;
      const props = engagement.properties;
      const dealId = firstAssoc(record, "deals");
      const leadId = firstAssoc(record, "leads");
      const contactId = firstAssoc(record, "contacts");
      const companyId = firstAssoc(record, "companies");
      const ownerId = props.hubspot_owner_id ?? props.hs_all_owner_ids ?? "";
      const responsibleUserId = userIdForOwner(ownerId, ownersById) || stableUuid("user:admin@trockgc.com");
      const crmDealId = dealId && !leadDealSourceIds.has(dealId) && !excludedDealIds.has(dealId) ? stableUuid(`deal:${dealId}`) : "";
      const crmLeadId = dealId && leadDealSourceIds.has(dealId)
        ? stableUuid(`lead:deal:${dealId}`)
        : leadId
          ? stableUuid(`lead:${leadId}`)
          : "";
      const crmContactId = contactId && importedContactIds.has(contactId) ? stableUuid(`contact:${contactId}`) : "";
      const crmCompanyId = companyId && importedCompanyIds.has(companyId) ? stableUuid(`company:${companyId}`) : "";
      const sourceEntityType = crmDealId ? "deal" : crmLeadId ? "lead" : crmContactId ? "contact" : "company";
      const sourceEntityId = crmDealId || crmLeadId || crmContactId || crmCompanyId;
      engagementRows.push({
        id: stableUuid(`engagement:${kind}:${engagement.id}`),
        type: kind === "notes" ? "note" : kind === "calls" ? "call" : kind === "meetings" ? "meeting" : "task_completed",
        responsible_user_id: responsibleUserId,
        performed_by_user_id: responsibleUserId,
        source_entity_type: sourceEntityType,
        source_entity_id: sourceEntityId,
        company_id: crmCompanyId,
        property_id: "",
        lead_id: crmLeadId,
        deal_id: crmDealId,
        contact_id: crmContactId,
        email_id: "",
        subject: firstNonEmpty(props.hs_call_title, props.hs_meeting_title, props.hs_task_subject, props.hs_body_preview),
        body: firstNonEmpty(props.hs_note_body, props.hs_call_body, props.hs_meeting_body, props.hs_task_body, props.hs_body_preview_html, props.hs_body_preview),
        outcome: firstNonEmpty(props.hs_call_disposition, props.hs_meeting_outcome, props.hs_task_status),
        next_step: "",
        next_step_due_at: props.hs_task_due_date ?? "",
        duration_minutes: props.hs_call_duration ? String(Math.round(Number(props.hs_call_duration) / 60000)) : "",
        occurred_at: firstNonEmpty(props.hs_timestamp, props.hs_createdate, engagement.createdAt),
        hubspot_extra_properties: jsonForCsv(
          extraProperties(engagement, populatedKeys, MAPPED_ENGAGEMENT_PROPS, {
            hubspot_engagement_id: engagement.id,
            hubspot_engagement_type: kind,
            hubspot_owner_id: ownerId || null,
            source_hubspot_deal_ids: assocIds(record, "deals"),
            source_hubspot_lead_ids: assocIds(record, "leads"),
            source_hubspot_contact_ids: assocIds(record, "contacts"),
            source_hubspot_company_ids: assocIds(record, "companies"),
          }),
        ),
      });
    }
  }

  const userSeed: UserSeed = {
    generatedAt,
    source: "HubSpot migration working-session decisions, generated from migration snapshot",
    defaultOfficeSlug: "dallas",
    users: TARGET_USERS.map((user) => {
      const { firstName, lastName } = splitName(user.displayName);
      return {
        id: stableUuid(`user:${user.email.toLowerCase()}`),
        email: user.email,
        displayName: user.displayName,
        firstName,
        lastName,
        role: user.role,
        officeSlug: "dallas",
        isActive: true,
        source: user.hubspotOwnerIds.length > 0 ? "hubspot_owner" : "manual_create",
        hubspotOwnerIds: user.hubspotOwnerIds,
        notes:
          user.email === "agreen@trockgc.com"
            ? "Consolidates active HubSpot owner 163096130 and archived HubSpot owner 1852094128."
            : user.email === "tmitchell@trockgc.com"
              ? "Uses locked @trockgc.com domain; source HubSpot owner email was tmitchell@trockcontracting.com."
              : "",
      };
    }),
  };

  await Promise.all([
    writeFile(join(OUTPUT_DIR, "companies.csv"), toCsv(companyHeader, companyRows), "utf8"),
    writeFile(join(OUTPUT_DIR, "contacts.csv"), toCsv(contactHeader, contactRows), "utf8"),
    writeFile(join(OUTPUT_DIR, "deals.csv"), toCsv(dealHeader, dealRows), "utf8"),
    writeFile(join(OUTPUT_DIR, "leads.csv"), toCsv(leadHeader, leadRows), "utf8"),
    writeFile(join(OUTPUT_DIR, "engagements.csv"), toCsv(engagementHeader, engagementRows), "utf8"),
    writeFile(join(OUTPUT_DIR, "user-seed.json"), `${JSON.stringify(userSeed, null, 2)}\n`, "utf8"),
  ]);

  console.log(
    JSON.stringify(
      {
        outputDir: OUTPUT_DIR,
        companies: companyRows.length,
        contacts: contactRows.length,
        excludedContacts: contactExclusionReasons.size,
        deals: dealRows.length,
        leads: leadRows.length,
        engagements: engagementRows.length,
        users: userSeed.users.length,
        excludedCompanies: excludedCompanyIds.size,
        excludedDeals: excludedDealIds.size,
        warning:
          "stage_id values are CRM stage slugs for importer resolution because live pipeline_stage_config UUIDs are not present in the snapshot.",
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
