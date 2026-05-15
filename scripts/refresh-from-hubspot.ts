import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { buildAuditActorFromSystem } from "../server/src/modules/audit/audit-logger.js";
import { logActivityWithPgClient } from "../server/src/modules/audit/pg-activity-logger.js";
import { HUBSPOT_REFRESH } from "../server/src/modules/audit/system-processes.js";

type WorkflowFamily = "standard_deal" | "service_deal";
type StageAction = "update" | "skip";
type StageSkipReason = "on_hold" | "unmapped_stage";

export type StageMappingEntry =
  | {
      hubSpotStage: string;
      action: "update";
      crmStageSlug: string;
      workflowFamily: WorkflowFamily;
    }
  | {
      hubSpotStage: string;
      action: "skip";
      reason: StageSkipReason;
    };

export const STAGE_MAPPING: StageMappingEntry[] = [
  { hubSpotStage: "Pipe Line", action: "update", crmStageSlug: "opportunity", workflowFamily: "standard_deal" },
  { hubSpotStage: "RFP", action: "update", crmStageSlug: "opportunity", workflowFamily: "standard_deal" },
  { hubSpotStage: "Estimating", action: "update", crmStageSlug: "estimate_in_progress", workflowFamily: "standard_deal" },
  { hubSpotStage: "Internal Review", action: "update", crmStageSlug: "estimate_under_review", workflowFamily: "standard_deal" },
  { hubSpotStage: "Proposal Sent", action: "update", crmStageSlug: "estimate_sent_to_client", workflowFamily: "standard_deal" },
  { hubSpotStage: "Follow-Up", action: "update", crmStageSlug: "estimate_sent_to_client", workflowFamily: "standard_deal" },
  { hubSpotStage: "Approval 30 Days", action: "update", crmStageSlug: "estimate_sent_to_client", workflowFamily: "standard_deal" },
  { hubSpotStage: "Approval 60-90 days", action: "update", crmStageSlug: "estimate_sent_to_client", workflowFamily: "standard_deal" },
  { hubSpotStage: "Closed Won", action: "update", crmStageSlug: "sent_to_production", workflowFamily: "standard_deal" },
  { hubSpotStage: "Closed Lost", action: "update", crmStageSlug: "production_lost", workflowFamily: "standard_deal" },
  { hubSpotStage: "On Hold", action: "skip", reason: "on_hold" },
  { hubSpotStage: "Deal Canceled", action: "update", crmStageSlug: "production_lost", workflowFamily: "standard_deal" },
  { hubSpotStage: "Service - Estimating", action: "update", crmStageSlug: "service_estimating", workflowFamily: "service_deal" },
  { hubSpotStage: "Service - Production", action: "update", crmStageSlug: "service_sent_to_production", workflowFamily: "service_deal" },
  { hubSpotStage: "Service - Won", action: "update", crmStageSlug: "service_sent_to_production", workflowFamily: "service_deal" },
  { hubSpotStage: "Service - Lost", action: "update", crmStageSlug: "service_lost", workflowFamily: "service_deal" },
];

const TENANT_SCHEMA = "office_dallas";
const HS_BASE_URL = "https://api.hubapi.com";

export interface CrmDealForRefresh {
  id: string;
  name: string;
  hubSpotDealId?: string | null;
  stageId: string;
  stageSlug: string;
  expectedCloseDate: string | Date | null;
  propertyCity: string | null;
  propertyState: string | null;
  bidEstimate: string | number | null;
  description: string | null;
  companyId: string | null;
  assignedRepId?: string | null;
  awardedAmount?: string | number | null;
  bidBoardProjectNumber?: string | null;
}

export interface HubSpotDealForRefresh {
  dealname?: string | null;
  dealstage?: string | null;
  closedate?: string | null;
  city?: string | null;
  state?: string | null;
  amount?: string | null;
  description?: string | null;
  companyName?: string | null;
}

export interface CrmCompanyForRefresh {
  id: string;
  name: string;
}

export interface FieldChange {
  dealId: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string;
}

export interface DealUpdatePlan {
  changes: FieldChange[];
  stageSkipReason?: StageSkipReason | "unmapped_stage";
  unmappedStage?: string | null;
  unmatchedCompanyName?: string | null;
  matchedCompanyName?: string | null;
  companyRefreshSuppressed?: boolean;
  warnings: string[];
}

interface CliOptions {
  dryRun: boolean;
  limit: number | null;
  verbose: boolean;
  refreshCompanyId: boolean;
}

interface HubSpotStageResolution {
  action: StageAction;
  targetSlug?: string;
  workflowFamily?: WorkflowFamily;
  reason?: StageSkipReason | "unmapped_stage";
  stageLabel?: string | null;
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function formatValue(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function normalizeStageLabel(value: string): string {
  return normalizeText(value).replace(/\band\b/g, "&");
}

function parseMoney(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function sameNullableText(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftValue = formatValue(left);
  const rightValue = formatValue(right);
  if (leftValue == null && rightValue == null) return true;
  return leftValue === rightValue;
}

const US_STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

export function normalizePropertyState(value: string | null | undefined): string | null {
  const formatted = formatValue(value);
  if (!formatted) return null;
  const upper = formatted.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return US_STATE_ABBREVIATIONS[normalizeText(formatted)] ?? null;
}

function toDateOnly(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function parseHubSpotCloseDate(value: string | null | undefined): {
  value: string | null;
  warning: "invalid_date" | "out_of_range_year" | null;
} {
  if (!value) return { value: null, warning: null };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { value: null, warning: "invalid_date" };
  const year = parsed.getUTCFullYear();
  if (year < 2020 || year > 2050) return { value: null, warning: "out_of_range_year" };
  return { value: parsed.toISOString().slice(0, 10), warning: null };
}

export function resolveHubSpotStage(
  hubSpotStage: string | null | undefined,
  hubSpotStageLabelsById: Map<string, string>
): HubSpotStageResolution {
  const raw = String(hubSpotStage ?? "").trim();
  if (!raw) return { action: "skip", reason: "unmapped_stage", stageLabel: null };
  const label = hubSpotStageLabelsById.get(raw) ?? raw;
  const normalizedLabel = normalizeStageLabel(label);
  const entry = STAGE_MAPPING.find(
    (candidate) => normalizeStageLabel(candidate.hubSpotStage) === normalizedLabel
  );

  if (!entry) return { action: "skip", reason: "unmapped_stage", stageLabel: label };
  if (entry.action === "skip") return { action: "skip", reason: entry.reason, stageLabel: label };
  return {
    action: "update",
    targetSlug: entry.crmStageSlug,
    workflowFamily: entry.workflowFamily,
    stageLabel: label,
  };
}

export function findCompanyByHubSpotName(
  hubSpotCompanyName: string | null | undefined,
  companies: CrmCompanyForRefresh[]
): string | null {
  const normalized = normalizeText(hubSpotCompanyName);
  if (!normalized) return null;
  return companies.find((company) => normalizeText(company.name) === normalized)?.id ?? null;
}

export function shouldRefreshBidEstimate(
  crmBidEstimate: string | number | null | undefined,
  hubSpotAmount: string | number | null | undefined
): { shouldRefresh: boolean; reason: string } {
  const crmAmount = parseMoney(crmBidEstimate);
  const hsAmount = parseMoney(hubSpotAmount);

  if (hsAmount == null) return { shouldRefresh: false, reason: "hubspot_amount_missing" };
  if ((crmAmount == null || crmAmount === 0) && hsAmount !== 0) {
    return { shouldRefresh: true, reason: "crm_missing_or_zero_hubspot_nonzero" };
  }
  if (crmAmount == null) return { shouldRefresh: false, reason: "both_missing_or_zero" };
  if (crmAmount === 0 && hsAmount === 0) return { shouldRefresh: false, reason: "both_zero" };

  const denominator = Math.max(Math.abs(crmAmount), 0.01);
  const drift = Math.abs(hsAmount - crmAmount) / denominator;
  if (drift > 0.05) return { shouldRefresh: true, reason: "gt_5_percent_drift" };
  return { shouldRefresh: false, reason: "within_5_percent_threshold" };
}

function addChange(
  changes: FieldChange[],
  dealId: string,
  fieldName: string,
  oldValue: unknown,
  newValue: unknown,
  reason: string
) {
  changes.push({
    dealId,
    fieldName,
    oldValue: formatValue(oldValue),
    newValue: formatValue(newValue),
    reason,
  });
}

export function buildDealUpdatePlan(input: {
  crmDeal: CrmDealForRefresh;
  hubSpotDeal: HubSpotDealForRefresh;
  hubSpotStages: Map<string, string>;
  stageByKey: Map<string, string>;
  companies: CrmCompanyForRefresh[];
  refreshCompanyId?: boolean;
}): DealUpdatePlan {
  const changes: FieldChange[] = [];
  const warnings: string[] = [];
  const crmDeal = input.crmDeal;
  const hsDeal = input.hubSpotDeal;

  const stageResolution = resolveHubSpotStage(hsDeal.dealstage, input.hubSpotStages);
  if (stageResolution.action === "update") {
    const stageKey = `${stageResolution.workflowFamily}:${stageResolution.targetSlug}`;
    const targetStageId = input.stageByKey.get(stageKey);
    if (!targetStageId) {
      warnings.push(`missing_crm_stage:${stageKey}`);
    } else if (crmDeal.stageId !== targetStageId) {
      addChange(changes, crmDeal.id, "stage_id", crmDeal.stageId, targetStageId, `hubspot_stage:${stageResolution.stageLabel}`);
    }
  }

  const closeDate = parseHubSpotCloseDate(hsDeal.closedate);
  if (closeDate.warning) {
    warnings.push(`closedate_${closeDate.warning}:${hsDeal.closedate}`);
  }
  if (!sameNullableText(toDateOnly(crmDeal.expectedCloseDate), closeDate.value)) {
    addChange(
      changes,
      crmDeal.id,
      "expected_close_date",
      toDateOnly(crmDeal.expectedCloseDate),
      closeDate.value,
      closeDate.warning ? `hubspot_closedate_${closeDate.warning}` : "hubspot_closedate"
    );
  }

  if (!sameNullableText(crmDeal.propertyCity, hsDeal.city)) {
    addChange(changes, crmDeal.id, "property_city", crmDeal.propertyCity, hsDeal.city ?? null, "hubspot_city");
  }
  const hubSpotState = normalizePropertyState(hsDeal.state);
  if (!sameNullableText(crmDeal.propertyState, hubSpotState)) {
    addChange(changes, crmDeal.id, "property_state", crmDeal.propertyState, hubSpotState, "hubspot_state");
  }

  const bidEstimateDecision = shouldRefreshBidEstimate(crmDeal.bidEstimate, hsDeal.amount);
  if (bidEstimateDecision.shouldRefresh) {
    addChange(changes, crmDeal.id, "bid_estimate", crmDeal.bidEstimate, parseMoney(hsDeal.amount), bidEstimateDecision.reason);
  }

  let unmatchedCompanyName: string | null = null;
  let matchedCompanyName: string | null = null;
  let companyRefreshSuppressed = false;
  if (hsDeal.companyName && normalizeText(hsDeal.companyName)) {
    const companyId = findCompanyByHubSpotName(hsDeal.companyName, input.companies);
    if (companyId && companyId !== crmDeal.companyId) {
      matchedCompanyName = hsDeal.companyName;
      if (input.refreshCompanyId === true) {
        addChange(changes, crmDeal.id, "company_id", crmDeal.companyId, companyId, `hubspot_company:${hsDeal.companyName}`);
      } else {
        companyRefreshSuppressed = true;
      }
    } else if (!companyId) {
      unmatchedCompanyName = hsDeal.companyName;
    }
  }

  const crmDescriptionEmpty = !formatValue(crmDeal.description);
  const hubSpotDescription = formatValue(hsDeal.description);
  if (crmDescriptionEmpty && hubSpotDescription) {
    addChange(changes, crmDeal.id, "description", crmDeal.description, hubSpotDescription, "hubspot_description_backfill");
  }

  return {
    changes,
    stageSkipReason: stageResolution.action === "skip" ? stageResolution.reason : undefined,
    unmappedStage: stageResolution.reason === "unmapped_stage" ? stageResolution.stageLabel ?? hsDeal.dealstage ?? null : null,
    unmatchedCompanyName,
    matchedCompanyName,
    companyRefreshSuppressed,
    warnings,
  };
}

class HubSpotClient {
  constructor(private readonly token: string) {}

  async get<T>(path: string): Promise<{ ok: true; data: T; headers: Headers } | { ok: false; status: number; body: string; headers: Headers }> {
    const response = await fetch(`${HS_BASE_URL}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        body: await response.text().catch(() => ""),
        headers: response.headers,
      };
    }
    return { ok: true, data: (await response.json()) as T, headers: response.headers };
  }
}

interface HubSpotPipelineResponse {
  results: Array<{
    id: string;
    label: string;
    stages: Array<{ id: string; label: string }>;
  }>;
}

interface HubSpotDealResponse {
  id: string;
  properties: Record<string, string | null | undefined>;
  associations?: {
    companies?: { results?: Array<{ id: string }> };
  };
}

interface HubSpotCompanyResponse {
  id: string;
  properties: { name?: string | null };
}

interface CrmDealRow extends CrmDealForRefresh {
  hubSpotDealId: string;
}

function optionsFromEnv(): CliOptions {
  return {
    dryRun: process.env.DRY_RUN !== "false",
    limit: process.env.LIMIT ? Number(process.env.LIMIT) : null,
    verbose: process.env.VERBOSE === "true",
    refreshCompanyId: process.env.REFRESH_COMPANY_ID === "true",
  };
}

function assertDallasSchema(schema: string): string {
  if (schema !== TENANT_SCHEMA) throw new Error(`Unexpected tenant schema: ${schema}`);
  return schema;
}

async function fetchCrmDeals(client: Client, limit: number | null): Promise<CrmDealRow[]> {
  const limitClause = limit && limit > 0 ? `LIMIT ${Math.trunc(limit)}` : "";
  const result = await client.query(`
    SELECT
      d.id,
      d.name,
      d.hubspot_deal_id AS "hubSpotDealId",
      d.stage_id AS "stageId",
      psc.slug AS "stageSlug",
      d.expected_close_date AS "expectedCloseDate",
      d.property_city AS "propertyCity",
      d.property_state AS "propertyState",
      d.bid_estimate AS "bidEstimate",
      d.description,
      d.company_id AS "companyId",
      d.assigned_rep_id AS "assignedRepId",
      d.awarded_amount AS "awardedAmount",
      d.bid_board_project_number AS "bidBoardProjectNumber"
    FROM office_dallas.deals d
    JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE d.hubspot_deal_id IS NOT NULL
    ORDER BY d.created_at ASC NULLS LAST, d.id ASC
    ${limitClause}
  `);
  return result.rows;
}

async function fetchStageByKey(client: Client): Promise<Map<string, string>> {
  const result = await client.query(`
    SELECT id, slug, workflow_family
    FROM public.pipeline_stage_config
  `);
  return new Map(result.rows.map((row) => [`${row.workflow_family}:${row.slug}`, row.id]));
}

async function fetchCompanies(client: Client): Promise<CrmCompanyForRefresh[]> {
  const result = await client.query(`
    SELECT id, name
    FROM office_dallas.companies
    WHERE name IS NOT NULL
  `);
  return result.rows;
}

async function fetchHubSpotStageLabels(client: HubSpotClient): Promise<Map<string, string>> {
  const response = await client.get<HubSpotPipelineResponse>("/crm/v3/pipelines/deals");
  if (response.ok === false) {
    throw new Error(`HubSpot pipeline fetch failed: ${response.status} ${response.body}`);
  }
  const labels = new Map<string, string>();
  for (const pipeline of response.data.results ?? []) {
    for (const stage of pipeline.stages ?? []) {
      labels.set(stage.id, stage.label);
    }
  }
  return labels;
}

async function fetchHubSpotCompanyName(
  client: HubSpotClient,
  companyId: string,
  cache: Map<string, string | null>
): Promise<string | null> {
  if (cache.has(companyId)) return cache.get(companyId) ?? null;
  const response = await client.get<HubSpotCompanyResponse>(
    `/crm/v3/objects/companies/${encodeURIComponent(companyId)}?properties=name`
  );
  if (response.ok === false) {
    cache.set(companyId, null);
    return null;
  }
  const name = response.data.properties?.name?.trim() || null;
  cache.set(companyId, name);
  return name;
}

async function fetchHubSpotDealForRefresh(
  client: HubSpotClient,
  hubSpotDealId: string,
  companyCache: Map<string, string | null>
): Promise<
  | { status: "ok"; deal: HubSpotDealForRefresh }
  | { status: "orphan"; httpStatus: number }
  | { status: "error"; httpStatus: number; body: string }
> {
  const properties = [
    "dealname",
    "dealstage",
    "hubspot_owner_id",
    "amount",
    "closedate",
    "lead_source",
    "address",
    "city",
    "state",
    "zip",
    "description",
  ].join(",");
  const response = await client.get<HubSpotDealResponse>(
    `/crm/v3/objects/deals/${encodeURIComponent(hubSpotDealId)}?properties=${encodeURIComponent(properties)}&associations=companies`
  );
  if (response.ok === false) {
    if (response.status === 404) return { status: "orphan", httpStatus: response.status };
    return { status: "error", httpStatus: response.status, body: response.body };
  }
  const companyId = response.data.associations?.companies?.results?.[0]?.id ?? null;
  const companyName = companyId ? await fetchHubSpotCompanyName(client, companyId, companyCache) : null;
  const props = response.data.properties ?? {};
  return {
    status: "ok",
    deal: {
      dealname: props.dealname,
      dealstage: props.dealstage,
      closedate: props.closedate,
      city: props.city,
      state: props.state,
      amount: props.amount,
      description: props.description,
      companyName,
    },
  };
}

async function ensureAuditTable(client: Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.hubspot_refresh_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL,
      tenant_schema TEXT NOT NULL,
      deal_id UUID NOT NULL,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS hubspot_refresh_log_run_idx
      ON public.hubspot_refresh_log (run_id, tenant_schema, deal_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS hubspot_refresh_log_created_idx
      ON public.hubspot_refresh_log (created_at DESC)
  `);
}

function auditFieldKeyForRefreshColumn(fieldName: string): string {
  if (fieldName === "stage_id") return "stageId";
  if (fieldName === "expected_close_date") return "expectedCloseDate";
  if (fieldName === "property_city") return "propertyCity";
  if (fieldName === "property_state") return "propertyState";
  if (fieldName === "bid_estimate") return "bidEstimate";
  if (fieldName === "company_id") return "companyId";
  return fieldName;
}

export async function applyDealChanges(client: Client, runId: string, dealId: string, changes: FieldChange[]) {
  if (changes.length === 0) return;
  const allowed = new Set([
    "stage_id",
    "expected_close_date",
    "property_city",
    "property_state",
    "bid_estimate",
    "company_id",
    "description",
  ]);
  for (const change of changes) {
    if (!allowed.has(change.fieldName)) {
      throw new Error(`Refusing to write forbidden field ${change.fieldName}`);
    }
  }

  const assignments = changes.map((change, index) => `${change.fieldName} = $${index + 1}`);
  const values = changes.map((change) => change.newValue);
  assignments.push(`last_synced_from_hubspot_at = $${values.length + 1}`);
  values.push(new Date().toISOString());
  values.push(dealId);
  const updateResult = await client.query<{
    id: string;
    name: string | null;
    deal_number: string | null;
    project_number: string | null;
  }>(
    `UPDATE office_dallas.deals
       SET ${assignments.join(", ")}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING id, name, deal_number, project_number`,
    values
  );

  if (updateResult.rows.length === 0) {
    console.warn(`HubSpot Refresh: deal ${dealId} not updated (row not found). Skipping audit log entry.`);
    return;
  }

  for (const change of changes) {
    await client.query(
      `INSERT INTO public.hubspot_refresh_log
       (run_id, tenant_schema, deal_id, field_name, old_value, new_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [runId, TENANT_SCHEMA, dealId, change.fieldName, change.oldValue, change.newValue, change.reason]
    );
  }

  const deal = updateResult.rows[0];
  const fieldChanges = Object.fromEntries(
    changes.map((change) => [
      auditFieldKeyForRefreshColumn(change.fieldName),
      { from: change.oldValue, to: change.newValue },
    ])
  );
  await logActivityWithPgClient({
    client,
    schemaName: TENANT_SCHEMA,
    actor: buildAuditActorFromSystem({ systemProcess: HUBSPOT_REFRESH }),
    action: "update",
    entity: {
      tableName: "deals",
      entityType: "deal",
      recordId: deal.id,
      nameSnapshot: deal.name ?? "Deal",
      secondaryIdSnapshot: deal.project_number ?? deal.deal_number ?? null,
    },
    fieldChanges,
    metadata: { runId, reasons: changes.map((change) => change.reason) },
  });
}

function emptyReport(runId: string, dryRun: boolean, refreshCompanyId: boolean) {
  return {
    runId,
    dryRun,
    refreshCompanyId,
    tenant: TENANT_SCHEMA,
    totalHubSpotLinkedCrmDeals: 0,
    hubSpotFetchSucceeded: 0,
    hubSpot404: 0,
    hubSpotErrored: 0,
    stageChangesByTransition: new Map<string, number>(),
    stageSkippedOnHold: 0,
    stageSkippedUnmapped: new Map<string, number>(),
    closeDateChanges: 0,
    cityStateChanges: 0,
    companyChanges: 0,
    companyMatchesAvailableButRefreshDisabled: 0,
    unmatchedCompanies: new Map<string, number>(),
    bidEstimateChanges: {
      crmMissingOrZeroHubSpotNonzero: 0,
      gt5PercentDrift: 0,
    },
    descriptionBackfills: 0,
    totalDealsWithAtLeastOneChange: 0,
    totalDealsWithNoChanges: 0,
    errors: [] as string[],
    warnings: [] as string[],
    sampleMultiFieldChanges: [] as Array<{ dealId: string; name: string; hubSpotDealId: string; changes: FieldChange[] }>,
    fieldChangeCounts: new Map<string, number>(),
    auditRowsWritten: 0,
  };
}

function increment(map: Map<string, number>, key: string, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function serializeReport(report: ReturnType<typeof emptyReport>, runtimeMs: number) {
  const stageTransitions = Object.fromEntries([...report.stageChangesByTransition.entries()].sort());
  const unmappedStages = Object.fromEntries([...report.stageSkippedUnmapped.entries()].sort());
  const unmatchedCompanies = Object.fromEntries(
    [...report.unmatchedCompanies.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
  const fieldChangeCounts = Object.fromEntries([...report.fieldChangeCounts.entries()].sort());
  return {
    run_id: report.runId,
    dry_run: report.dryRun,
    runtime_ms: runtimeMs,
    tenant_breakdown: {
      [report.tenant]: {
        total_hubspot_linked_crm_deals: report.totalHubSpotLinkedCrmDeals,
        deals_with_at_least_one_change: report.totalDealsWithAtLeastOneChange,
        deals_with_no_changes: report.totalDealsWithNoChanges,
      },
    },
    hubspot_fetches: {
      succeeded: report.hubSpotFetchSucceeded,
      not_found_404: report.hubSpot404,
      errored: report.hubSpotErrored,
    },
    stage_changes_by_transition: stageTransitions,
    stage_skipped_on_hold: report.stageSkippedOnHold,
    stage_skipped_unmapped: {
      count: [...report.stageSkippedUnmapped.values()].reduce((sum, count) => sum + count, 0),
      stages: unmappedStages,
    },
    close_date_changes_proposed: report.closeDateChanges,
    city_state_changes_proposed: report.cityStateChanges,
    company_changes_proposed: report.companyChanges,
    company_id_refresh_enabled: report.refreshCompanyId,
    company_matches_available_but_refresh_disabled: report.companyMatchesAvailableButRefreshDisabled,
    hubspot_company_names_without_crm_match: unmatchedCompanies,
    bid_estimate_changes_proposed: report.bidEstimateChanges,
    description_backfills_proposed: report.descriptionBackfills,
    field_change_counts: fieldChangeCounts,
    audit_rows_written: report.auditRowsWritten,
    total_sanity_check:
      report.totalDealsWithAtLeastOneChange + report.totalDealsWithNoChanges + report.hubSpot404 + report.hubSpotErrored,
    warnings: report.warnings,
    errors: report.errors,
    sample_multi_field_changes: report.sampleMultiFieldChanges,
  };
}

async function runRefresh() {
  const started = Date.now();
  const options = optionsFromEnv();
  const runId = randomUUID();
  const report = emptyReport(runId, options.dryRun, options.refreshCompanyId);
  const databaseUrl = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;

  if (!databaseUrl) throw new Error("DATABASE_URL or DATABASE_PUBLIC_URL is required");
  if (!token) throw new Error("HUBSPOT_PRIVATE_APP_TOKEN is required");

  const db = new Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });
  const hubSpot = new HubSpotClient(token);
  await db.connect();

  try {
    assertDallasSchema(TENANT_SCHEMA);
    const [stageByKey, companies, hubSpotStages] = await Promise.all([
      fetchStageByKey(db),
      fetchCompanies(db),
      fetchHubSpotStageLabels(hubSpot),
    ]);
    for (const entry of STAGE_MAPPING) {
      if (entry.action === "update") {
        const key = `${entry.workflowFamily}:${entry.crmStageSlug}`;
        if (!stageByKey.has(key)) throw new Error(`Missing CRM stage target for ${key}`);
      }
    }

    const deals = await fetchCrmDeals(db, options.limit);
    report.totalHubSpotLinkedCrmDeals = deals.length;
    if (!options.dryRun) await ensureAuditTable(db);

    const companyCache = new Map<string, string | null>();
    for (const crmDeal of deals) {
      try {
        const hubSpotResult = await fetchHubSpotDealForRefresh(hubSpot, crmDeal.hubSpotDealId, companyCache);
        if (hubSpotResult.status === "orphan") {
          report.hubSpot404++;
          continue;
        }
        if (hubSpotResult.status === "error") {
          report.hubSpotErrored++;
          report.errors.push(`${crmDeal.hubSpotDealId}: HubSpot fetch failed ${hubSpotResult.httpStatus}`);
          continue;
        }
        report.hubSpotFetchSucceeded++;

        const plan = buildDealUpdatePlan({
          crmDeal,
          hubSpotDeal: hubSpotResult.deal,
          hubSpotStages,
          stageByKey,
          companies,
          refreshCompanyId: options.refreshCompanyId,
        });

        if (plan.stageSkipReason === "on_hold") report.stageSkippedOnHold++;
        if (plan.stageSkipReason === "unmapped_stage") {
          increment(report.stageSkippedUnmapped, plan.unmappedStage ?? "(blank)");
        }
        if (plan.unmatchedCompanyName) increment(report.unmatchedCompanies, plan.unmatchedCompanyName);
        if (plan.companyRefreshSuppressed) report.companyMatchesAvailableButRefreshDisabled++;
        report.warnings.push(...plan.warnings.map((warning) => `${crmDeal.id}:${warning}`));

        if (plan.changes.length === 0) {
          report.totalDealsWithNoChanges++;
          continue;
        }

        report.totalDealsWithAtLeastOneChange++;
        for (const change of plan.changes) {
          increment(report.fieldChangeCounts, change.fieldName);
          if (change.fieldName === "stage_id") {
            const from = crmDeal.stageSlug;
            const resolution = resolveHubSpotStage(hubSpotResult.deal.dealstage, hubSpotStages);
            increment(report.stageChangesByTransition, `${from} -> ${resolution.targetSlug ?? "unknown"}`);
          } else if (change.fieldName === "expected_close_date") {
            report.closeDateChanges++;
          } else if (change.fieldName === "property_city" || change.fieldName === "property_state") {
            report.cityStateChanges++;
          } else if (change.fieldName === "company_id") {
            report.companyChanges++;
          } else if (change.fieldName === "bid_estimate") {
            if (change.reason === "crm_missing_or_zero_hubspot_nonzero") {
              report.bidEstimateChanges.crmMissingOrZeroHubSpotNonzero++;
            } else if (change.reason === "gt_5_percent_drift") {
              report.bidEstimateChanges.gt5PercentDrift++;
            }
          } else if (change.fieldName === "description") {
            report.descriptionBackfills++;
          }
        }

        if (plan.changes.length >= 2 && report.sampleMultiFieldChanges.length < 10) {
          report.sampleMultiFieldChanges.push({
            dealId: crmDeal.id,
            name: crmDeal.name,
            hubSpotDealId: crmDeal.hubSpotDealId,
            changes: plan.changes,
          });
        }

        if (options.verbose) {
          console.log(JSON.stringify({ dealId: crmDeal.id, hubSpotDealId: crmDeal.hubSpotDealId, changes: plan.changes }));
        }

        if (!options.dryRun) {
          await db.query("BEGIN");
          try {
            await applyDealChanges(db, runId, crmDeal.id, plan.changes);
            await db.query("COMMIT");
            report.auditRowsWritten += plan.changes.length;
          } catch (error) {
            await db.query("ROLLBACK");
            report.errors.push(`${crmDeal.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } catch (error) {
        report.hubSpotErrored++;
        report.errors.push(`${crmDeal.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await db.end();
  }

  console.log(JSON.stringify(serializeReport(report, Date.now() - started), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRefresh().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
