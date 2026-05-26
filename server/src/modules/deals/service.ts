import { randomUUID } from "node:crypto";
import { eq, and, desc, asc, ilike, inArray, sql, or, isNull, not, getTableColumns, type SQLWrapper } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  dealHistory,
  dealStageHistory,
  dealApprovals,
  changeOrders,
  pipelineStageConfig,
  contacts,
  companies,
  leads,
  users,
  userOfficeAccess,
  tasks,
  jobQueue,
  projectTypeConfig,
  offices,
} from "@trock-crm/shared/schema";
import {
  DOMAIN_EVENTS,
  getDealAtRiskResult,
  resolveEffectiveStageEnteredAt,
  USER_ROLES,
  type AtRiskResult,
  type DealContractSignedEventPayload,
  type StagePageSort,
  type UserRole,
  type WorkflowRoute,
  resolveOfficeCodeFromOffice,
} from "@trock-crm/shared/types";
import type * as schema from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { calculateCommissionForDeal } from "../commissions/service.js";
import { getActiveProjectTypes, getStageById, getStageBySlug, resolveActiveProjectTypeValue } from "../pipeline/service.js";
import { evaluatePostConversionEnrichment } from "./post-conversion-enrichment.js";
import { createAssignmentTaskIfNeeded } from "../assignment-tasks/service.js";
import { generateDealNumberForProject } from "../../services/projectNumber.js";
import { isContractSignedHandoffEnabled } from "../../config/feature-flags.js";
import { resolveActiveOfficeUserIds, resolveTeamRepIds } from "../shared/team-scope.js";
import {
  buildAliasedDealMineVisibilityCondition,
  buildDealMineVisibilityCondition,
  resolveMineVisibilityFeatures,
} from "../shared/mine-visibility.js";
import { resolveLeadSourceDisplayValue } from "../leads/source-control.js";
import { resolveDealCreationPolicy, type DealCreationOrigin } from "./direct-create-rules.js";
import { logActivity, type AuditContext } from "../audit/audit-logger.js";
import { LOST_STAGE_SLUGS, TERMINAL_STAGE_SLUGS, WON_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";
import { assertActiveDealStageWriteTarget } from "./stage-write-guard.js";
import {
  aliasedActiveDealCountFilterSql,
  aliasedDealAwardedFirstWithFallbackSql,
  aliasedDealBestEstimateSql,
  dealAwardedFirstWithFallbackSql,
  dealBestEstimateSql,
} from "../shared/deal-value-sql.js";

// Type alias for the tenant-scoped Drizzle instance
type TenantDb = NodePgDatabase<typeof schema>;
type DealRow = typeof deals.$inferSelect;
type PipelineStageRow = typeof pipelineStageConfig.$inferSelect;
type DealWithAtRisk<T> = T & { atRisk: AtRiskResult };
const contractSignedDateForReporting = sql`COALESCE(contract_signed_at::date, contract_signed_date)`;
const DEFAULT_PIPELINE_CARDS_PER_STAGE_LIMIT = 100;
const MAX_PIPELINE_CARDS_PER_STAGE_LIMIT = 1000;

function sqlStringList(values: readonly string[]) {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

function nonTerminalMirroredStageCondition() {
  return sql`COALESCE(${deals.bidBoardStageSlug}, '') NOT IN (${sqlStringList(TERMINAL_STAGE_SLUGS)})`;
}

function normalizeAtRiskViewerRole(role: string | null | undefined): UserRole | null {
  return USER_ROLES.includes(role as UserRole) ? (role as UserRole) : null;
}

function attachAtRiskResult<T extends {
  stageId?: string | null;
  stageSlug?: string | null;
  bidBoardStageSlug?: string | null;
  isBidBoardOwned?: boolean | null;
  workflowRoute?: WorkflowRoute | null;
  stageEnteredAt?: string | Date | null;
  bidBoardStageEnteredAt?: string | Date | null;
  onHold?: boolean | null;
  onHoldStartedAt?: string | Date | null;
  onHoldAccumulatedSeconds?: number | bigint | null;
  onHoldAccumulatedSecondsAtStageEntry?: number | bigint | null;
}>(
  deal: T,
  viewerRole: string | null | undefined,
  fallbackStageSlug?: string | null
): DealWithAtRisk<T> {
  const actualStageSlug = deal.stageSlug ?? fallbackStageSlug ?? deal.stageId ?? null;
  const isTerminalStage =
    actualStageSlug != null && TERMINAL_STAGE_SLUGS.includes(actualStageSlug);
  const stageSlug = isTerminalStage
    ? actualStageSlug
    : deal.bidBoardStageSlug ?? actualStageSlug;

  return {
    ...deal,
    atRisk: getDealAtRiskResult(
      {
        stageSlug,
        workflowRoute: deal.workflowRoute ?? "normal",
        stageEnteredAt: resolveEffectiveStageEnteredAt(deal),
        onHold: deal.onHold,
        onHoldStartedAt: deal.onHoldStartedAt,
        onHoldAccumulatedSeconds:
          deal.onHoldAccumulatedSeconds == null ? null : Number(deal.onHoldAccumulatedSeconds),
        onHoldAccumulatedSecondsAtStageEntry:
          deal.onHoldAccumulatedSecondsAtStageEntry == null
            ? null
            : Number(deal.onHoldAccumulatedSecondsAtStageEntry),
      },
      normalizeAtRiskViewerRole(viewerRole),
      new Date()
    ),
  };
}

function normalizeOptionalDealBidDueDate(value: unknown) {
  if (value == null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError(400, "bidDueDate must be an ISO date in YYYY-MM-DD format");
  }

  if (value.trim() === "") {
    return null;
  }

  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new AppError(400, "bidDueDate must be an ISO date in YYYY-MM-DD format");
  }

  const [year, month, day] = trimmed.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new AppError(400, "bidDueDate must be an ISO date in YYYY-MM-DD format");
  }

  return new Date(`${trimmed}T00:00:00.000Z`);
}

async function resolveActiveOfficeScope(tenantDb: TenantDb, activeOfficeId: string) {
  const officeRows = await db
    .select({ slug: offices.slug, name: offices.name })
    .from(offices)
    .where(eq(offices.id, activeOfficeId))
    .limit(1);
  const office = officeRows[0] ?? null;
  const officeUserIds = await resolveActiveOfficeUserIds(tenantDb, activeOfficeId);

  return {
    activeOfficeId,
    officeCode: resolveOfficeCodeFromOffice(office),
    officeUserIds,
  };
}

function buildDealOfficeScopeCondition(
  alias: string,
  input: { activeOfficeId: string; officeCode: string | null; officeUserIds: string[] }
) {
  const dealAlias = sql.raw(alias);
  const assignedRepFallback =
    input.activeOfficeId
      ? sql`${dealAlias}.office_code is null and exists (
          select 1
          from ${users} assigned_rep
          where assigned_rep.id = ${dealAlias}.assigned_rep_id
            and assigned_rep.office_id = ${input.activeOfficeId}
        )`
      : sql`false`;

  if (input.officeCode) {
    return sql`(${dealAlias}.office_code = ${input.officeCode} or ${assignedRepFallback})`;
  }

  return input.officeUserIds.length > 0
    ? sql`${dealAlias}.assigned_rep_id in (${sqlList(input.officeUserIds)})`
    : sql`false`;
}

export interface DealFilters {
  search?: string;
  stageIds?: string[];
  inactiveStageIds?: string[];
  assignedRepId?: string;
  projectTypeId?: string;
  regionId?: string;
  source?: string;
  isActive?: boolean | "all" | "pipeline";
  // Inclusive YYYY-MM-DD bounds against deals.contract_signed_at::date, with
  // deals.contract_signed_date as a transition fallback.
  contractSignedFrom?: string;
  contractSignedTo?: string;
  estimateSentFrom?: string;
  estimateSentTo?: string;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  sortBy?: "name" | "created_at" | "updated_at" | "awarded_amount" | "stage_entered_at" | "expected_close_date" | "contract_signed_date";
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
  scope?: WorkspaceScope;
  activeOfficeId?: string;
}

export interface PipelineTerminalDateFilters {
  wonSince?: string;
  wonUntil?: string;
  wonAllTime?: boolean;
  wonPeriodFrom?: string;
  wonPeriodTo?: string;
  lostSince?: string;
  lostUntil?: string;
  lostAllTime?: boolean;
  now?: Date;
}

export interface CreateDealInput {
  name: string;
  stageId: string;
  assignedRepId: string;
  actorUserId?: string;
  officeId?: string; // Active office — used to validate assignee has access
  companyId?: string;
  propertyId?: string;
  sourceLeadId?: string;
  sourceLeadWriteMode?: "direct" | "lead_conversion";
  creationContext?: DealCreationOrigin;
  workflowRoute?: WorkflowRoute;
  migrationMode?: boolean;
  primaryContactId?: string;
  ddEstimate?: string;
  bidEstimate?: string;
  awardedAmount?: string;
  bidDueDate?: string | null;
  description?: string;
  propertyAddress?: string;
  propertyCity?: string;
  propertyState?: string;
  propertyZip?: string;
  officeCode: string;
  projectType?: string;
  projectTypeId?: string;
  regionId?: string;
  source?: string;
  winProbability?: number;
  expectedCloseDate?: string;
  auditContext?: AuditContext;
}

export interface UpdateDealInput {
  name?: string;
  assignedRepId?: string;
  primaryContactId?: string | null;
  sourceLeadId?: string | null;
  companyId?: string | null;
  propertyId?: string | null;
  workflowRoute?: WorkflowRoute;
  migrationMode?: boolean;
  ddEstimate?: string | null;
  bidEstimate?: string | null;
  awardedAmount?: string | null;
  description?: string | null;
  propertyAddress?: string | null;
  propertyCity?: string | null;
  propertyState?: string | null;
  propertyZip?: string | null;
  projectType?: string | null;
  projectTypeId?: string | null;
  regionId?: string | null;
  source?: string | null;
  winProbability?: number | null;
  expectedCloseDate?: string | null;
  onHold?: boolean;
  proposalStatus?: string | null;
  proposalNotes?: string | null;
  estimatingSubstage?: string | null;
  auditContext?: AuditContext;
}

type DealLineageRequirementInput = Pick<CreateDealInput, "migrationMode" | "creationContext">;
type DealLineageRequirement = {
  companyId?: string | null;
  propertyId?: string | null;
};
type DealUpdateLineageInput = Pick<UpdateDealInput, "sourceLeadId" | "companyId" | "propertyId">;
type DealUpdateLineageExisting = Pick<DealRow, "sourceLeadId" | "companyId" | "propertyId">;

export function isMigrationDealCreation(input: DealLineageRequirementInput) {
  return input.migrationMode === true || input.creationContext === "migration";
}

export function assertDealCreateLineageRequirements(
  input: DealLineageRequirementInput,
  lineage: DealLineageRequirement
) {
  if (!isMigrationDealCreation(input) && (!lineage.companyId || !lineage.propertyId)) {
    throw new AppError(
      400,
      "Deals require company and property unless migrationMode is true"
    );
  }
}

export function assertDealUpdateLineagePolicy(
  existing: DealUpdateLineageExisting,
  input: DealUpdateLineageInput
) {
  if (input.sourceLeadId === null) {
    throw new AppError(400, "sourceLeadId cannot be cleared once set");
  }

  if (input.companyId === null || input.propertyId === null) {
    throw new AppError(400, "companyId and propertyId cannot be cleared once set");
  }

  if (input.sourceLeadId !== undefined && input.sourceLeadId !== existing.sourceLeadId) {
    throw new AppError(400, "sourceLeadId is immutable once established");
  }

  if (
    existing.companyId &&
    input.companyId !== undefined &&
    input.companyId !== existing.companyId
  ) {
    throw new AppError(400, "companyId is immutable once established");
  }

  if (
    existing.propertyId &&
    input.propertyId !== undefined &&
    input.propertyId !== existing.propertyId
  ) {
    throw new AppError(400, "propertyId is immutable once established");
  }
}

export const VALID_PROPOSAL_STATUSES = [
  "not_started",
  "drafting",
  "sent",
  "under_review",
  "revision_requested",
  "accepted",
  "signed",
  "rejected",
] as const;
export const VALID_ESTIMATING_SUBSTAGES = [
  "scope_review",
  "site_visit",
  "missing_info",
  "building_estimate",
  "under_review",
  "sent_to_client",
] as const;
const WON_TERMINAL_STAGE_SLUGS = WON_STAGE_SLUGS;
const LOST_TERMINAL_STAGE_SLUGS = LOST_STAGE_SLUGS;
const ESTIMATE_SENT_STAGE_SLUGS = [
  "estimate_sent_to_client",
  "service_estimate_sent_to_client",
  "bid_sent",
] as const;
const VALID_PROPOSAL_STATUS_SET = new Set<string>(VALID_PROPOSAL_STATUSES);
const VALID_ESTIMATING_SUBSTAGE_SET = new Set<string>(VALID_ESTIMATING_SUBSTAGES);
export const BID_BOARD_CRM_EDITABLE_FIELDS = [
  "deal details",
  "files",
  "activity",
  "notes",
] as const;
export const BID_BOARD_MIRRORED_FIELDS = [
  "stage progression",
  "proposal status",
  "estimating progress",
  "estimate amounts",
  "downstream mirror metadata",
] as const;
export const BID_BOARD_STAGE_READ_ONLY_MESSAGE =
  "Deal stage progression is read-only in CRM after estimating handoff. Bid Board is now the source of truth for downstream stages.";
export const BID_BOARD_BOUNDARY_STAGE_MISSING_MESSAGE =
  "Estimating stage configuration is required to enforce the Bid Board ownership boundary.";
const BID_BOARD_OWNED_UPDATE_FIELD_LABELS: Partial<Record<keyof UpdateDealInput, string>> = {
  ddEstimate: "DD estimate",
  bidEstimate: "Bid estimate",
  awardedAmount: "Awarded amount",
  estimatingSubstage: "Estimating progress",
  proposalStatus: "Proposal status",
};

function startOfUtcDay(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function getDealSecondaryIdSnapshot(deal: Pick<DealRow, "projectNumber" | "dealNumber">) {
  return deal.projectNumber ?? deal.dealNumber ?? null;
}

function buildDealAuditEntity(
  deal: Pick<DealRow, "id" | "name" | "projectNumber" | "dealNumber">
) {
  return {
    tableName: "deals",
    entityType: "deal" as const,
    recordId: deal.id,
    nameSnapshot: deal.name,
    secondaryIdSnapshot: getDealSecondaryIdSnapshot(deal),
  };
}

function toIsoIfDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

function buildRawFieldChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: string[]
) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    const from = toIsoIfDate(before[key]);
    const to = toIsoIfDate(after[key]);
    if (from === to) continue;
    changes[key] = { from, to };
  }
  return changes;
}

function parseIsoDateParam(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolvePipelineWonPeriodRange(input: Pick<PipelineTerminalDateFilters, "wonPeriodFrom" | "wonPeriodTo">) {
  return {
    from: parseIsoDateParam(input.wonPeriodFrom),
    to: parseIsoDateParam(input.wonPeriodTo),
  };
}

function toIsoDateOnly(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

export function resolvePipelineTerminalDateFilters(input: PipelineTerminalDateFilters = {}) {
  const now = input.now ?? new Date();
  const defaultSince = addUtcDays(startOfUtcDay(now), -30);

  return {
    won: {
      since: input.wonAllTime ? null : parseIsoDateParam(input.wonSince) ?? defaultSince,
      until: parseIsoDateParam(input.wonUntil),
    },
    lost: {
      since: input.lostAllTime ? null : parseIsoDateParam(input.lostSince) ?? defaultSince,
      until: parseIsoDateParam(input.lostUntil),
    },
  };
}

async function assertValidProjectType(value: string | null | undefined): Promise<string> {
  const normalized = await resolveActiveProjectTypeValue(value);
  if (!normalized) {
    throw new AppError(400, `Invalid project type: ${value ?? ""}`.trim());
  }

  return normalized;
}

function assertValidOfficeCode(value: string | null | undefined): "dfw" | "atl" {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized !== "dfw" && normalized !== "atl") {
    throw new AppError(400, "officeCode must be 'dfw' or 'atl'");
  }

  return normalized;
}

export function resolveIntendedProjectNumberFromParts(
  issuedProjectNumber: string | null | undefined,
  officeCode: string,
  projectTypeCode: string,
  julianDate: string,
  suffix: string
): string | null {
  const intended = `${officeCode.toUpperCase()}-${projectTypeCode}-${julianDate}-${suffix.toLowerCase()}`;
  if (!issuedProjectNumber) return intended;
  return intended.toLowerCase() === issuedProjectNumber.toLowerCase() ? null : intended;
}

function resolveIntendedProjectNumberFromCode(
  issuedProjectNumber: string | null | undefined,
  projectTypeCode: string
): string | null {
  const match = String(issuedProjectNumber ?? "").match(/^([A-Z]{2,4})-[1-9]-(\d{5})-([a-z]+)$/i);
  if (!match || !/^[1-9]$/.test(projectTypeCode)) {
    return null;
  }

  const [, officeCode, julianDate, suffix] = match;
  return resolveIntendedProjectNumberFromParts(
    issuedProjectNumber,
    officeCode,
    projectTypeCode,
    julianDate,
    suffix
  );
}

async function isPastOpportunity(stageId: string | null | undefined) {
  if (!stageId) return true;

  const stage = await getStageById(stageId);
  const opportunity = await getStageBySlug("opportunity", "standard_deal");

  if (!stage || !opportunity) {
    return true;
  }

  if (stage.workflowFamily !== opportunity.workflowFamily) {
    return stage.workflowFamily !== "lead";
  }

  return stage.displayOrder > opportunity.displayOrder;
}

async function resolveProjectTypeConfigById(projectTypeId: string | null | undefined) {
  if (!projectTypeId) return null;
  const projectTypes = await getActiveProjectTypes();
  return projectTypes.find((projectType) => projectType.id === projectTypeId) ?? null;
}

async function resolveProjectTypeConfigByValue(value: string | null | undefined) {
  const normalized = await resolveActiveProjectTypeValue(value);
  if (!normalized) return null;

  const projectTypes = await getActiveProjectTypes();
  return (
    projectTypes.find((projectType) => {
      const name = projectType.name.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
      const slug = projectType.slug.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
      return name === normalized || slug === normalized;
    }) ?? null
  );
}

export async function applyProjectTypeChange(
  tenantDb: TenantDb,
  deal: Pick<
    DealRow,
    "id" | "dealNumber" | "stageId" | "projectTypeId" | "projectType" | "intendedProjectNumber"
  >,
  newProjectTypeId: string | null,
  actor: { id: string; role: string },
  options: { projectTypeValue?: string | null } = {}
) {
  if (await isPastOpportunity(deal.stageId)) {
    if (actor.role !== "admin") {
      throw new AppError(403, "Only admins can edit project type after Opportunity");
    }
    if (!newProjectTypeId && options.projectTypeValue === undefined) {
      throw new AppError(400, "projectType cannot be cleared after Opportunity");
    }
  }

  const projectType = options.projectTypeValue
    ? await resolveProjectTypeConfigByValue(options.projectTypeValue)
    : await resolveProjectTypeConfigById(newProjectTypeId);

  if (!projectType) {
    throw new AppError(400, "Invalid project type");
  }

  const nextProjectTypeId = projectType.id;
  const nextProjectTypeValue = projectType.name.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  const nextIntendedProjectNumber = resolveIntendedProjectNumberFromCode(
    deal.dealNumber,
    projectType.code ?? ""
  );

  if (
    nextProjectTypeId === (deal.projectTypeId ?? null) &&
    nextProjectTypeValue === (deal.projectType ?? null) &&
    nextIntendedProjectNumber === (deal.intendedProjectNumber ?? null)
  ) {
    return {};
  }

  await tenantDb.insert(dealHistory).values({
    dealId: deal.id,
    fieldName: "project_type",
    oldValue: JSON.stringify({
      oldProjectTypeId: deal.projectTypeId ?? null,
      oldProjectType: deal.projectType ?? null,
      oldIntendedProjectNumber: deal.intendedProjectNumber ?? null,
    }),
    newValue: JSON.stringify({
      newProjectTypeId: nextProjectTypeId,
      newProjectType: nextProjectTypeValue,
      newIntendedProjectNumber: nextIntendedProjectNumber,
    }),
    changedBy: actor.id,
    changedAt: new Date(),
  });

  return {
    projectTypeId: nextProjectTypeId,
    projectType: nextProjectTypeValue,
    intendedProjectNumber: nextIntendedProjectNumber,
  };
}

function estimatingBoundaryStageSlugForRoute(workflowRoute: WorkflowRoute) {
  return workflowRoute === "service" ? "service_estimating" : "estimate_in_progress";
}

type WorkspaceScope = "mine" | "team" | "all";

export interface DealBoardInput {
  role: string;
  atRiskViewerRole?: string;
  userId: string;
  activeOfficeId: string;
  scope: WorkspaceScope;
  includeDd?: boolean;
}

export interface DealStagePageInput extends DealBoardInput {
  stageId: string;
  page: number;
  pageSize: number;
  sort?: StagePageSort;
  search?: string;
  assignedRepId?: string;
  estimateSentFrom?: string;
  estimateSentTo?: string;
  regionId?: string;
  workflowRoute?: string;
  updatedFrom?: string;
  updatedTo?: string;
  minAgeDays?: number;
  maxAgeDays?: number;
  wonSince?: string;
  wonUntil?: string;
  wonAllTime?: boolean;
  lostSince?: string;
  lostUntil?: string;
  lostAllTime?: boolean;
}

type DealStageWorkspaceRow = {
  id: string;
  deal_number: string;
  project_number: string | null;
  name: string;
  stage_id: string;
  workflow_route: WorkflowRoute;
  assigned_rep_id: string;
  assigned_rep_name: string;
  region_id: string | null;
  source: string | null;
  property_city: string | null;
  property_state: string | null;
  updated_at: string;
  stage_entered_at: string;
  is_bid_board_owned: boolean;
  bid_board_stage_slug: string | null;
  bid_board_stage_entered_at: string | null;
  on_hold: boolean;
  on_hold_started_at: string | null;
  on_hold_accumulated_seconds: string | number | null;
  on_hold_accumulated_seconds_at_stage_entry: string | number | null;
  awarded_amount: string | null;
  bid_board_total_sales: string | null;
  bid_estimate: string | null;
  dd_estimate: string | null;
  days_in_stage: number;
};

function buildSortWithIdTieBreaker(column: SQLWrapper, dir: "asc" | "desc") {
  return dir === "asc"
    ? [asc(column), asc(deals.id)] as const
    : [desc(column), desc(deals.id)] as const;
}

function buildDealListOrder(filters: DealFilters) {
  switch (filters.sortBy) {
    case "name":
      return buildSortWithIdTieBreaker(deals.name, filters.sortDir === "asc" ? "asc" : "desc");
    case "created_at":
      return buildSortWithIdTieBreaker(deals.createdAt, filters.sortDir === "asc" ? "asc" : "desc");
    case "awarded_amount":
      return buildSortWithIdTieBreaker(deals.awardedAmount, filters.sortDir === "asc" ? "asc" : "desc");
    case "stage_entered_at":
      return buildSortWithIdTieBreaker(deals.stageEnteredAt, filters.sortDir === "asc" ? "asc" : "desc");
    case "expected_close_date":
      return buildSortWithIdTieBreaker(deals.expectedCloseDate, filters.sortDir === "asc" ? "asc" : "desc");
    case "contract_signed_date":
      return buildSortWithIdTieBreaker(contractSignedDateForReporting, filters.sortDir === "asc" ? "asc" : "desc");
    case "updated_at":
      return buildSortWithIdTieBreaker(deals.updatedAt, filters.sortDir === "asc" ? "asc" : "desc");
    default:
      return buildSortWithIdTieBreaker(deals.createdAt, "desc");
  }
}

function buildPipelineStageCardsOrder() {
  // Sort before preview limiting so each column shows the actual newest cards,
  // not an arbitrary subset from a tied timestamp group.
  return [desc(deals.createdAt), desc(deals.id)] as const;
}

function buildStagePageOrder(sort: StagePageSort | undefined, stage: PipelineStageRow) {
  // The stage workspace previously ignored the incoming sort and silently used
  // age-based ordering. Default it to the same newest/oldest contract as the
  // shared list/board, but keep legacy explicit modes working for old links.
  switch (sort) {
    case "oldest":
      return sql`d.created_at asc, d.id asc`;
    case "age_desc":
      return sql`d.stage_entered_at asc, d.id asc`;
    case "updated_desc":
      return sql`d.updated_at desc, d.id desc`;
    case "name_asc":
      return sql`d.name asc, d.id asc`;
    case "value_desc":
      return stage.isTerminal || stage.slug === "won" || stage.slug === "lost"
        ? sql`${aliasedDealAwardedFirstWithFallbackSql("d")} desc, d.id desc`
        : sql`${aliasedDealBestEstimateSql("d")} desc, d.id desc`;
    case "newest":
    default:
      return sql`d.created_at desc, d.id desc`;
  }
}

export interface DealBidBoardOwnershipState {
  isOwned: boolean;
  sourceOfTruth: "crm" | "bid_board";
  handoffStageSlug: string;
  downstreamStagesReadOnly: boolean;
  canEditInCrm: readonly string[];
  mirroredInCrm: readonly string[];
  reason: string;
  message: string;
}

/**
 * Validate that the assigned user exists, is active, and has access to the office.
 */
async function validateAssignee(tenantDb: TenantDb, assigneeId: string, officeId?: string): Promise<void> {
  const [user] = await tenantDb.select().from(users)
    .where(and(eq(users.id, assigneeId), eq(users.isActive, true))).limit(1);
  if (!user) throw new AppError(400, "Assigned user not found or inactive");
  if (officeId && user.officeId !== officeId) {
    const [access] = await tenantDb.select().from(userOfficeAccess)
      .where(and(eq(userOfficeAccess.userId, assigneeId), eq(userOfficeAccess.officeId, officeId))).limit(1);
    if (!access) throw new AppError(400, "Assigned user does not have access to this office");
  }
}

async function validateDealReassignmentAssignee(
  tenantDb: TenantDb,
  assigneeId: string,
  dealOfficeCode: string | null | undefined,
  currentAssignedRepId: string | null,
  fallbackOfficeId?: string,
): Promise<void> {
  const [targetUser] = await tenantDb
    .select()
    .from(users)
    .where(and(eq(users.id, assigneeId), eq(users.isActive, true)))
    .limit(1);
  if (!targetUser) throw new AppError(400, "Assigned user not found or inactive");

  const normalizedDealOfficeCode = resolveOfficeCodeFromOffice(dealOfficeCode ?? null);
  if (normalizedDealOfficeCode) {
    const [targetOffice] = await tenantDb
      .select({ slug: offices.slug, name: offices.name })
      .from(offices)
      .where(eq(offices.id, targetUser.officeId))
      .limit(1);
    const normalizedTargetOfficeCode = resolveOfficeCodeFromOffice(targetOffice ?? null);
    if (normalizedTargetOfficeCode !== normalizedDealOfficeCode) {
      throw new AppError(
        400,
        "Deals can only be reassigned to users in the same office",
        "DEAL_REASSIGNMENT_OFFICE_MISMATCH"
      );
    }
    return;
  }

  let dealOfficeId = fallbackOfficeId ?? null;
  if (currentAssignedRepId) {
    const [currentOwner] = await tenantDb
      .select()
      .from(users)
      .where(eq(users.id, currentAssignedRepId))
      .limit(1);
    dealOfficeId = currentOwner?.officeId ?? dealOfficeId;
  }

  if (dealOfficeId && targetUser.officeId !== dealOfficeId) {
    throw new AppError(
      400,
      "Deals can only be reassigned to users in the same office",
      "DEAL_REASSIGNMENT_OFFICE_MISMATCH"
    );
  }
}

export function workflowFamilyForRoute(workflowRoute: WorkflowRoute) {
  return workflowRoute === "service" ? "service_deal" : "standard_deal";
}

const SHARED_CANONICAL_DEAL_STAGE_SLUGS = new Set([
  // opportunity is standard_deal-family but valid for service deals as the
  // CRM-side RFP approval trigger before Bid Board-owned progression.
  "opportunity",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "won",
  "lost",
]);

function isServiceRouteStandardFamilyStage(stage: PipelineStageRow | null | undefined) {
  return (
    stage?.workflowFamily === "standard_deal" &&
    SHARED_CANONICAL_DEAL_STAGE_SLUGS.has(stage.slug)
  );
}

async function getStageByIdForWorkflowRoute(stageId: string, workflowRoute: WorkflowRoute) {
  const stage = await getStageById(stageId, workflowFamilyForRoute(workflowRoute));
  if (stage) return stage;

  if (workflowRoute !== "service") return null;

  const standardStage = await getStageById(stageId, "standard_deal");
  return isServiceRouteStandardFamilyStage(standardStage) ? standardStage : null;
}

async function listDealStages() {
  return db
    .select()
    .from(pipelineStageConfig)
    .where(inArray(pipelineStageConfig.workflowFamily, ["standard_deal", "service_deal"]))
    .orderBy(asc(pipelineStageConfig.displayOrder));
}

const sqlList = (values: readonly string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);

function workspaceWonWindowDateSql() {
  return sql`COALESCE(d.contract_signed_at, d.contract_signed_date::timestamptz)`;
}

function workspaceWonWindowEligibilitySql() {
  const date = workspaceWonWindowDateSql();
  return sql`
    ${date} IS NOT NULL
    AND NOT (
      d.bid_board_last_updated_at IS NOT NULL
      AND ${date}::date = d.bid_board_last_updated_at::date
    )
  `;
}

function workspaceLostWindowDateSql() {
  return sql`d.lost_at`;
}

function workspaceLostWindowEligibilitySql() {
  const date = workspaceLostWindowDateSql();
  return sql`
    ${date} IS NOT NULL
    AND NOT (
      d.bid_board_last_updated_at IS NOT NULL
      AND ${date}::date = d.bid_board_last_updated_at::date
    )
  `;
}

function dealWonWindowDateSql() {
  return contractSignedDateForReporting;
}

function dealWonWindowEligibilitySql() {
  const date = dealWonWindowDateSql();
  return sql`
    ${date} IS NOT NULL
    AND NOT (
      ${deals.bidBoardLastUpdatedAt} IS NOT NULL
      AND ${date}::date = ${deals.bidBoardLastUpdatedAt}::date
    )
  `;
}

function dealLostWindowDateSql() {
  return deals.lostAt;
}

function dealLostWindowEligibilitySql() {
  const date = dealLostWindowDateSql();
  return sql`
    ${date} IS NOT NULL
    AND NOT (
      ${deals.bidBoardLastUpdatedAt} IS NOT NULL
      AND ${date}::date = ${deals.bidBoardLastUpdatedAt}::date
    )
  `;
}

function dealEstimateSentAtSql() {
  return sql`
    COALESCE(
      (
        SELECT MAX(${dealStageHistory.createdAt})
        FROM ${dealStageHistory}
        JOIN ${pipelineStageConfig} estimate_sent_history_stage
          ON estimate_sent_history_stage.id = ${dealStageHistory.toStageId}
        WHERE ${dealStageHistory.dealId} = ${deals.id}
          AND estimate_sent_history_stage.slug IN (${sqlList(ESTIMATE_SENT_STAGE_SLUGS)})
      ),
      (
        SELECT CASE
          WHEN estimate_sent_current_stage.slug IN (${sqlList(ESTIMATE_SENT_STAGE_SLUGS)})
            THEN ${deals.stageEnteredAt}
          ELSE NULL
        END
        FROM ${pipelineStageConfig} estimate_sent_current_stage
        WHERE estimate_sent_current_stage.id = ${deals.stageId}
      )
    )
  `;
}

function effectiveDealValueSql(isTerminalStage: boolean) {
  const rawValue = isTerminalStage
    ? dealAwardedFirstWithFallbackSql(deals)
    : dealBestEstimateSql(deals);

  return sql`CASE WHEN ${deals.onHold} THEN 0 ELSE ${rawValue} END`;
}

function addEstimateSentDateConditions(
  conditions: any[],
  input: { estimateSentFrom?: string; estimateSentTo?: string }
) {
  if (!input.estimateSentFrom && !input.estimateSentTo) return;

  const estimateSentAt = dealEstimateSentAtSql();
  if (input.estimateSentFrom) {
    conditions.push(sql`${estimateSentAt} >= ${input.estimateSentFrom}::date`);
  }
  if (input.estimateSentTo) {
    conditions.push(sql`${estimateSentAt} < (${input.estimateSentTo}::date + interval '1 day')`);
  }
}

function workspaceEstimateSentAtSql() {
  return sql`
    COALESCE(
      (
        SELECT MAX(dsh.created_at)
        FROM deal_stage_history dsh
        JOIN public.pipeline_stage_config estimate_sent_history_stage
          ON estimate_sent_history_stage.id = dsh.to_stage_id
        WHERE dsh.deal_id = d.id
          AND estimate_sent_history_stage.slug IN (${sqlList(ESTIMATE_SENT_STAGE_SLUGS)})
      ),
      (
        SELECT CASE
          WHEN estimate_sent_current_stage.slug IN (${sqlList(ESTIMATE_SENT_STAGE_SLUGS)})
            THEN d.stage_entered_at
          ELSE NULL
        END
        FROM public.pipeline_stage_config estimate_sent_current_stage
        WHERE estimate_sent_current_stage.id = d.stage_id
      )
    )
  `;
}

function addWorkspaceEstimateSentDateConditions(
  conditions: any[],
  input: { estimateSentFrom?: string; estimateSentTo?: string }
) {
  if (!input.estimateSentFrom && !input.estimateSentTo) return;

  const estimateSentAt = workspaceEstimateSentAtSql();
  if (input.estimateSentFrom) {
    conditions.push(sql`${estimateSentAt} >= ${input.estimateSentFrom}::date`);
  }
  if (input.estimateSentTo) {
    conditions.push(sql`${estimateSentAt} < (${input.estimateSentTo}::date + interval '1 day')`);
  }
}

function workspaceEffectiveDealValueSql(stage: PipelineStageRow) {
  const isTerminalStage = stage.isTerminal || stage.slug === "won" || stage.slug === "lost";
  const rawValue = isTerminalStage
    ? aliasedDealAwardedFirstWithFallbackSql("d")
    : aliasedDealBestEstimateSql("d");

  return sql`CASE WHEN d.on_hold THEN 0 ELSE ${rawValue} END`;
}

function terminalWorkspaceDateConditions(stage: PipelineStageRow, input: DealStagePageInput) {
  const terminalFilters = resolvePipelineTerminalDateFilters(input);
  if (WON_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof WON_TERMINAL_STAGE_SLUGS)[number])) {
    const enteredAt = workspaceWonWindowDateSql();
    const conditions: any[] = [];
    if (terminalFilters.won.since || terminalFilters.won.until) {
      conditions.push(workspaceWonWindowEligibilitySql());
    }
    if (terminalFilters.won.since) {
      conditions.push(sql`${enteredAt} >= ${terminalFilters.won.since}`);
    }
    if (terminalFilters.won.until) {
      conditions.push(sql`${enteredAt} < ${addUtcDays(terminalFilters.won.until, 1)}`);
    }
    return conditions;
  }
  if (LOST_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof LOST_TERMINAL_STAGE_SLUGS)[number])) {
    const enteredAt = workspaceLostWindowDateSql();
    const conditions: any[] = [];
    if (terminalFilters.lost.since || terminalFilters.lost.until) {
      conditions.push(workspaceLostWindowEligibilitySql());
    }
    if (terminalFilters.lost.since) {
      conditions.push(sql`${enteredAt} >= ${terminalFilters.lost.since}`);
    }
    if (terminalFilters.lost.until) {
      conditions.push(sql`${enteredAt} < ${addUtcDays(terminalFilters.lost.until, 1)}`);
    }
    return conditions;
  }
  return [];
}

function isTerminalWorkspaceStage(stage?: PipelineStageRow) {
  if (!stage) return false;
  return (
    WON_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof WON_TERMINAL_STAGE_SLUGS)[number]) ||
    LOST_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof LOST_TERMINAL_STAGE_SLUGS)[number])
  );
}

async function buildDealWorkspaceScope(
  tenantDb: TenantDb,
  input: DealBoardInput | DealStagePageInput,
  stage?: PipelineStageRow
) {
  const terminalDateConditions = stage && "stageId" in input ? terminalWorkspaceDateConditions(stage, input) : [];
  const terminalScope = "stageId" in input && isTerminalWorkspaceStage(stage);
  const activeOfficeScope = await resolveActiveOfficeScope(tenantDb, input.activeOfficeId);
  const filters = [
    buildDealOfficeScopeCondition("d", activeOfficeScope),
  ];

  if (!terminalScope) {
    filters.unshift(sql`d.is_active = true`);
  } else {
    filters.push(...terminalDateConditions);
  }

  const mineVisibility = input.scope === "mine" ? await resolveMineVisibilityFeatures(tenantDb) : null;

  if (input.scope === "mine") {
    filters.push(
      buildAliasedDealMineVisibilityCondition("d", input.userId, {
        includeSubscriptions: mineVisibility?.dealSubscriptions,
        includeCreatedBy: mineVisibility?.dealsCreatedByUserId,
        includeSubscriptionDeletedAt: mineVisibility?.dealSubscriptionsDeletedAt,
      })
    );
  } else if (input.scope === "team") {
    const teamRepIds = await resolveTeamRepIds(tenantDb, input.userId, input.activeOfficeId);
    filters.push(teamRepIds.length > 0 ? sql`d.assigned_rep_id IN (${sqlList(teamRepIds)})` : sql`false`);
  }

  return sql.join(filters, sql` and `);
}

function mapDealStageWorkspaceRow(
  row: DealStageWorkspaceRow,
  viewerRole: string | null | undefined,
  fallbackStageSlug?: string | null
) {
  const deal = {
    id: row.id,
    dealNumber: row.deal_number,
    projectNumber: row.project_number,
    name: row.name,
    stageId: row.stage_id,
    stageSlug: fallbackStageSlug ?? null,
    workflowRoute: row.workflow_route,
    assignedRepId: row.assigned_rep_id,
    assignedRepName: row.assigned_rep_name,
    regionId: row.region_id,
    source: row.source,
    propertyCity: row.property_city,
    propertyState: row.property_state,
    updatedAt: row.updated_at,
    stageEnteredAt: row.stage_entered_at,
    isBidBoardOwned: row.is_bid_board_owned,
    bidBoardStageSlug: row.bid_board_stage_slug,
    bidBoardStageEnteredAt: row.bid_board_stage_entered_at,
    onHold: row.on_hold,
    onHoldStartedAt: row.on_hold_started_at,
    onHoldAccumulatedSeconds: Number(row.on_hold_accumulated_seconds ?? 0),
    onHoldAccumulatedSecondsAtStageEntry: Number(
      row.on_hold_accumulated_seconds_at_stage_entry ?? 0
    ),
    daysInStage: Number(row.days_in_stage ?? 0),
    awardedAmount: row.awarded_amount,
    bidBoardTotalSales: row.bid_board_total_sales,
    bidEstimate: row.bid_estimate,
    ddEstimate: row.dd_estimate,
  };

  return attachAtRiskResult(deal, viewerRole, fallbackStageSlug ?? row.stage_id);
}

export function buildBidBoardOwnershipState(
  deal: Pick<typeof deals.$inferSelect, "isBidBoardOwned" | "workflowRoute">
): DealBidBoardOwnershipState {
  const isOwned = deal.isBidBoardOwned;

  return {
    isOwned,
    sourceOfTruth: isOwned ? "bid_board" : "crm",
    handoffStageSlug: estimatingBoundaryStageSlugForRoute(deal.workflowRoute),
    downstreamStagesReadOnly: isOwned,
    canEditInCrm: BID_BOARD_CRM_EDITABLE_FIELDS,
    mirroredInCrm: BID_BOARD_MIRRORED_FIELDS,
    reason: isOwned
      ? "Bid Board now owns downstream progression after the deal entered estimating."
      : "CRM still owns manual stage progression before estimating handoff.",
    message: isOwned
      ? "Bid Board is now the source of truth once this deal entered estimating."
      : "CRM remains the source of truth until the deal is handed off into estimating.",
  };
}

export async function getEstimatingBoundaryStage(workflowRoute: WorkflowRoute) {
  const workflowFamily = workflowFamilyForRoute(workflowRoute);
  const canonicalBoundarySlug = estimatingBoundaryStageSlugForRoute(workflowRoute);

  return (
    (await getStageBySlug(canonicalBoundarySlug, workflowFamily)) ??
    (await getStageBySlug("estimating", workflowFamily))
  );
}

export async function getRequiredEstimatingBoundaryStage(workflowRoute: WorkflowRoute) {
  const boundaryStage = await getEstimatingBoundaryStage(workflowRoute);
  if (!boundaryStage) {
    throw new AppError(
      500,
      BID_BOARD_BOUNDARY_STAGE_MISSING_MESSAGE,
      "BID_BOARD_BOUNDARY_STAGE_MISSING"
    );
  }

  return boundaryStage;
}

export function isBidBoardOwnedDownstreamStage(
  targetStage: { slug: string; displayOrder: number; isTerminal: boolean },
  estimatingBoundary: { displayOrder: number } | null,
  workflowRoute: WorkflowRoute
) {
  if (
    targetStage.slug === "estimating" ||
    targetStage.slug === estimatingBoundaryStageSlugForRoute(workflowRoute)
  ) {
    return false;
  }

  return (
    Boolean(estimatingBoundary) &&
    targetStage.displayOrder > (estimatingBoundary?.displayOrder ?? Number.POSITIVE_INFINITY)
  );
}

async function validateDealPrimaryContact(
  tenantDb: TenantDb,
  companyId: string | null,
  primaryContactId?: string | null
) {
  if (!primaryContactId) {
    return;
  }

  if (!companyId) {
    throw new AppError(400, "Primary contact requires a company");
  }

  const [contact] = await tenantDb
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, primaryContactId), eq(contacts.isActive, true)))
    .limit(1);

  if (!contact) {
    throw new AppError(400, "Primary contact not found");
  }

  if (contact.companyId !== companyId) {
    throw new AppError(400, "Primary contact does not belong to the company");
  }
}

async function assertSourceLeadLineageAvailable(
  tenantDb: TenantDb,
  sourceLeadId: string,
  existingDealId?: string
) {
  const [existingDeal] = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.sourceLeadId, sourceLeadId))
    .limit(1);

  if (existingDeal && existingDeal.id !== existingDealId) {
    throw new AppError(409, "A deal already exists for this source lead");
  }
}

async function resolveSourceLeadLineage(
  tenantDb: TenantDb,
  input: CreateDealInput,
  options?: { existingDealId?: string }
) {
  if (!input.sourceLeadId) {
    return {
      companyId: input.companyId ?? null,
      propertyId: input.propertyId ?? null,
      primaryContactId: input.primaryContactId ?? null,
      sourceLeadId: null,
      source: input.source?.trim() || null,
    };
  }

  await assertSourceLeadLineageAvailable(tenantDb, input.sourceLeadId, options?.existingDealId);

  const [sourceLead] = await tenantDb
    .select()
    .from(leads)
    .where(eq(leads.id, input.sourceLeadId))
    .limit(1);

  if (!sourceLead) {
    throw new AppError(400, "Source lead not found");
  }

  if (input.companyId && input.companyId !== sourceLead.companyId) {
    throw new AppError(400, "companyId does not match the source lead");
  }

  if (input.propertyId && input.propertyId !== sourceLead.propertyId) {
    throw new AppError(400, "propertyId does not match the source lead");
  }

  return {
    companyId: sourceLead.companyId,
    propertyId: sourceLead.propertyId,
    primaryContactId: input.primaryContactId ?? sourceLead.primaryContactId ?? null,
    sourceLeadId: sourceLead.id,
    source: input.source?.trim() || (resolveLeadSourceDisplayValue(sourceLead) ?? null),
  };
}

/**
 * Get a paginated, filtered, sorted list of deals.
 */
export async function getDeals(
  tenantDb: TenantDb,
  filters: DealFilters,
  userRole: string,
  userId: string,
  atRiskViewerRole: string = userRole
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const offset = (page - 1) * limit;
  const scope = filters.scope ?? "mine";

  // Build conditions array
  const conditions: any[] = [];

  // Active filter defaults to true. Pipeline list/export can request mixed
  // visibility: active rows everywhere plus inactive rows only for terminal
  // stage ids in scope, matching kanban semantics. Client-supplied
  // inactiveStageIds are intersected with the server's terminal stage set
  // so a crafted request cannot widen visibility to inactive non-terminal
  // rows.
  if (filters.isActive === "pipeline") {
    let terminalInactiveStageIds: string[] = [];
    if (filters.inactiveStageIds?.length) {
      const allStages = await listDealStages();
      const terminalStageIds = new Set(
        allStages.filter((stage) => isTerminalWorkspaceStage(stage)).map((stage) => stage.id)
      );
      terminalInactiveStageIds = filters.inactiveStageIds.filter((id) => terminalStageIds.has(id));
    }
    conditions.push(
      or(
        eq(deals.isActive, true),
        terminalInactiveStageIds.length ? inArray(deals.stageId, terminalInactiveStageIds) : sql`false`
      )
    );
  } else if (filters.isActive !== "all") {
    conditions.push(eq(deals.isActive, filters.isActive ?? true));
  }

  if (filters.activeOfficeId) {
      const officeScope = await resolveActiveOfficeScope(tenantDb, filters.activeOfficeId);
      conditions.push(buildDealOfficeScopeCondition("deals", officeScope));
  }

  const mineVisibility = scope === "mine" ? await resolveMineVisibilityFeatures(tenantDb) : null;

  if (scope === "mine") {
    conditions.push(
      buildDealMineVisibilityCondition(userId, {
        includeSubscriptions: mineVisibility?.dealSubscriptions,
        includeCreatedBy: mineVisibility?.dealsCreatedByUserId,
        includeSubscriptionDeletedAt: mineVisibility?.dealSubscriptionsDeletedAt,
      })
    );
  } else if (scope === "team") {
    const teamUserIds = await resolveTeamRepIds(tenantDb, userId, filters.activeOfficeId ?? null);
    conditions.push(teamUserIds.length > 0 ? inArray(deals.assignedRepId, teamUserIds) : sql`false`);
  }

  // Filter by assigned rep (directors/admins filtering by rep)
  if (filters.assignedRepId) {
    conditions.push(eq(deals.assignedRepId, filters.assignedRepId));
  }

  // Filter by stage(s)
  if (filters.stageIds && filters.stageIds.length > 0) {
    conditions.push(inArray(deals.stageId, filters.stageIds));
  }

  // Filter by project type
  if (filters.projectTypeId) {
    conditions.push(eq(deals.projectTypeId, filters.projectTypeId));
  }

  // Filter by region
  if (filters.regionId) {
    conditions.push(eq(deals.regionId, filters.regionId));
  }

  // Filter by source
  if (filters.source) {
    conditions.push(eq(deals.source, filters.source));
  }

  // Inclusive signed-contract range. Used by the rep dashboard YTD/MTD
  // click-through to surface the deals contributing to each card.
  if (filters.contractSignedFrom) {
    conditions.push(sql`${contractSignedDateForReporting} >= ${filters.contractSignedFrom}::date`);
  }
  if (filters.contractSignedTo) {
    conditions.push(sql`${contractSignedDateForReporting} <= ${filters.contractSignedTo}::date`);
  }
  addEstimateSentDateConditions(conditions, filters);
  if (filters.createdFrom) {
    conditions.push(sql`${deals.createdAt} >= ${filters.createdFrom}::date`);
  }
  if (filters.createdTo) {
    conditions.push(sql`${deals.createdAt} < (${filters.createdTo}::date + interval '1 day')`);
  }
  if (filters.updatedFrom) {
    conditions.push(sql`${deals.updatedAt} >= ${filters.updatedFrom}::date`);
  }
  if (filters.updatedTo) {
    conditions.push(sql`${deals.updatedAt} < (${filters.updatedTo}::date + interval '1 day')`);
  }

  // Search across name, deal_number, description, property_address
  if (filters.search && filters.search.trim().length >= 2) {
    const searchTerm = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        ilike(deals.name, searchTerm),
        ilike(deals.dealNumber, searchTerm),
        ilike(deals.description, searchTerm),
        ilike(deals.propertyAddress, searchTerm),
        sql`EXISTS (
          SELECT 1
          FROM ${companies}
          WHERE ${companies.id} = ${deals.companyId}
            AND ${companies.name} ILIKE ${searchTerm}
        )`
      )
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const activeCountWhere = where
    ? and(where, sql`coalesce(${deals.onHold}, false) = false`)
    : sql`coalesce(${deals.onHold}, false) = false`;

  // Sort
  const sortOrder = buildDealListOrder(filters);

  // Sequential tenant queries required: tenantDb is a single transaction client
  // in production, so parallel reads can fail with "client already executing".
  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(deals).where(where);
  const activeCountResult = await tenantDb
    .select({ count: sql<number>`count(*)` })
    .from(deals)
    .where(activeCountWhere);
  const dealRows = await tenantDb
    .select({
      ...getTableColumns(deals),
      companyName: companies.name,
      stageSlug: pipelineStageConfig.slug,
    })
    .from(deals)
    .leftJoin(companies, eq(companies.id, deals.companyId))
    .leftJoin(pipelineStageConfig, eq(pipelineStageConfig.id, deals.stageId))
    .where(where)
    .orderBy(...sortOrder)
    .limit(limit)
    .offset(offset);

  const total = Number(countResult[0]?.count ?? 0);
  const activeCount = Number(activeCountResult[0]?.count ?? total);

  return {
    deals: dealRows.map((deal) => attachAtRiskResult(deal, atRiskViewerRole)),
    pagination: {
      page,
      limit,
      total,
      activeCount,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get a single deal by ID.
 */
export async function getDealById(
  tenantDb: TenantDb,
  dealId: string,
  userRole: string,
  userId: string,
  atRiskViewerRole: string = userRole
) {
  const result = await tenantDb
    .select({
      ...getTableColumns(deals),
      stageSlug: pipelineStageConfig.slug,
    })
    .from(deals)
    .leftJoin(pipelineStageConfig, eq(pipelineStageConfig.id, deals.stageId))
    .where(eq(deals.id, dealId))
    .limit(1);

  const deal = result[0] ?? null;
  if (!deal) return null;

  // Reps can only see their own deals
  if (userRole === "rep" && deal.assignedRepId !== userId) {
    throw new AppError(403, "You can only view your own deals");
  }

  return attachAtRiskResult(deal, atRiskViewerRole);
}

/**
 * Get deal with related data for the detail page.
 */
export async function getDealDetail(
  tenantDb: TenantDb,
  dealId: string,
  userRole: string,
  userId: string,
  atRiskViewerRole: string = userRole
) {
  const deal = await getDealById(tenantDb, dealId, userRole, userId, atRiskViewerRole);
  if (!deal) return null;

  const [detailDeal] = await tenantDb
    .select({
      ...getTableColumns(deals),
      assignedRepName: users.displayName,
      companyName: companies.name,
      companyOwnerUserId: companies.ownerId,
      companyOwnerUserName: sql<string | null>`(SELECT display_name FROM public.users WHERE id = ${companies.ownerId})`,
      primaryContactName: sql<string | null>`NULLIF(TRIM(CONCAT_WS(' ', ${contacts.firstName}, ${contacts.lastName})), '')`,
      primaryContactTitle: contacts.jobTitle,
      primaryContactOwnerUserId: contacts.ownerId,
      primaryContactOwnerUserName: sql<string | null>`(SELECT display_name FROM public.users WHERE id = ${contacts.ownerId})`,
      projectType: sql<string | null>`COALESCE(${projectTypeConfig.name}, ${deals.projectType})`,
    })
    .from(deals)
    .leftJoin(users, eq(users.id, deals.assignedRepId))
    .leftJoin(companies, eq(companies.id, deals.companyId))
    .leftJoin(contacts, eq(contacts.id, deals.primaryContactId))
    .leftJoin(projectTypeConfig, eq(projectTypeConfig.id, deals.projectTypeId))
    .where(eq(deals.id, dealId))
    .limit(1);

  const dealWithMetadata = detailDeal ?? deal;
  const currentStage = await getStageByIdForWorkflowRoute(dealWithMetadata.stageId, dealWithMetadata.workflowRoute);

  // Sequential tenant queries required: tenantDb is a single transaction client
  // in production, so parallel reads can fail with "client already executing".
  const stageHistory = await tenantDb
    .select()
    .from(dealStageHistory)
    .where(eq(dealStageHistory.dealId, dealId))
    .orderBy(desc(dealStageHistory.createdAt));
  const approvals = await tenantDb
    .select()
    .from(dealApprovals)
    .where(eq(dealApprovals.dealId, dealId))
    .orderBy(desc(dealApprovals.createdAt));
  const cos = await tenantDb
    .select()
    .from(changeOrders)
    .where(eq(changeOrders.dealId, dealId))
    .orderBy(asc(changeOrders.coNumber));

  return {
    ...dealWithMetadata,
    atRisk: attachAtRiskResult(dealWithMetadata, atRiskViewerRole, currentStage?.slug ?? null).atRisk,
    postConversionEnrichment: evaluatePostConversionEnrichment(dealWithMetadata as any, currentStage ?? { isTerminal: true }),
    bidBoardOwnership: buildBidBoardOwnershipState(dealWithMetadata),
    stageHistory,
    approvals,
    changeOrders: cos,
  };
}

/**
 * Create a new deal.
 */
export async function createDeal(tenantDb: TenantDb, input: CreateDealInput) {
  const workflowRoute = input.workflowRoute ?? "normal";
  const stage = await getStageByIdForWorkflowRoute(input.stageId, workflowRoute);
  if (!stage) {
    throw new AppError(400, "Invalid stage ID for workflow route");
  }

  const creationPolicy = resolveDealCreationPolicy(input);
  if (creationPolicy.origin !== "migration") {
    assertActiveDealStageWriteTarget(stage);
  }

  // Terminal stages cannot be initial stage
  if (stage.isTerminal) {
    throw new AppError(400, "Cannot create a deal in a terminal stage");
  }

  if (!creationPolicy.allowed) {
    throw new AppError(400, creationPolicy.reason ?? "Deal creation is not allowed");
  }

  const lineage = await resolveSourceLeadLineage(tenantDb, input);
  assertDealCreateLineageRequirements(input, lineage);

  // Validate the assigned rep exists, is active, and has office access
  await validateAssignee(tenantDb, input.assignedRepId, input.officeId);
  await validateDealPrimaryContact(tenantDb, lineage.companyId, lineage.primaryContactId);

  const officeCode = assertValidOfficeCode(input.officeCode);
  const projectType = input.projectType ? await assertValidProjectType(input.projectType) : null;
  const normalizedBidDueDate = normalizeOptionalDealBidDueDate(input.bidDueDate);
  const createdAt = new Date();
  const dealNumber = await generateDealNumberForProject(tenantDb, {
    id: "new",
    officeCode,
    projectType,
    workflowRoute,
    createdAt,
  });

  const result = await tenantDb
    .insert(deals)
    .values({
      dealNumber,
      name: input.name,
      stageId: input.stageId,
      assignedRepId: input.assignedRepId,
      primaryContactId: lineage.primaryContactId,
      companyId: lineage.companyId,
      propertyId: lineage.propertyId,
      sourceLeadId: lineage.sourceLeadId,
      ddEstimate: input.ddEstimate ?? null,
      bidEstimate: input.bidEstimate ?? null,
      awardedAmount: input.awardedAmount ?? null,
      // deals.bid_due_date is timestamptz, but the business field is date-only.
      // Persist UTC midnight so every environment resolves the same calendar day.
      bidDueDate: normalizedBidDueDate,
      description: input.description ?? null,
      propertyAddress: input.propertyAddress ?? null,
      propertyCity: input.propertyCity ?? null,
      propertyState: input.propertyState ?? null,
      propertyZip: input.propertyZip ?? null,
      officeCode,
      projectType,
      projectTypeId: input.projectTypeId ?? null,
      regionId: input.regionId ?? null,
      source: lineage.source,
      createdByUserId: input.actorUserId ?? null,
      winProbability: input.winProbability ?? null,
      expectedCloseDate: input.expectedCloseDate ?? null,
      workflowRoute,
      createdAt,
      updatedAt: createdAt,
    })
    .returning();

  const newDeal = result[0];

  if (input.auditContext) {
    await logActivity({
      tenantDb,
      actor: input.auditContext.actor,
      action: "insert",
      entity: buildDealAuditEntity(newDeal),
      fieldChanges: {
        name: { from: null, to: newDeal.name },
        stageId: { from: null, to: stage.name ?? input.stageId },
        assignedRepId: { from: null, to: newDeal.assignedRepId },
      },
      metadata: {
        creationOrigin: creationPolicy.origin,
        sourceLeadId: newDeal.sourceLeadId,
      },
      ipAddress: input.auditContext.ipAddress ?? null,
      userAgent: input.auditContext.userAgent ?? null,
    });
  } else {
    await writeAuditLog(tenantDb, {
      tableName: "deals",
      recordId: newDeal.id,
      action: "insert",
      changedBy: input.actorUserId ?? null,
      fullRow: {
        id: newDeal.id,
        dealNumber: newDeal.dealNumber,
        creationOrigin: creationPolicy.origin,
        sourceLeadId: newDeal.sourceLeadId,
      },
    });
  }

  // Queue geocode as background job (the tenantDb connection will be released after commit)
  const { propertyAddress, propertyCity, propertyState, propertyZip, officeId } = input;
  if (propertyAddress) {
    db.insert(jobQueue).values({
      jobType: "geocode_deal",
      payload: { dealId: newDeal.id, address: `${propertyAddress}, ${propertyCity || ""} ${propertyState || ""} ${propertyZip || ""}`.trim() },
      officeId: officeId ?? null,
      status: "pending",
      runAfter: new Date(),
    }).catch((err) => console.error("[Deals] Failed to queue geocode job:", err));
  }

  if (input.actorUserId) {
    await createAssignmentTaskIfNeeded(tenantDb, {
      entityType: "deal",
      entityId: newDeal.id,
      entityName: newDeal.name,
      previousAssignedRepId: null,
      nextAssignedRepId: newDeal.assignedRepId,
      actorUserId: input.actorUserId,
      officeId: input.officeId ?? null,
    });
  }

  return newDeal;
}

/**
 * Update an existing deal (field edits, not stage changes).
 */
export async function updateDeal(
  tenantDb: TenantDb,
  dealId: string,
  input: UpdateDealInput,
  userRole: string,
  userId: string,
  officeId?: string,
) {
  // Lock the deal row before deriving hold timing so stage changes and hold
  // toggles cannot race on a stale snapshot.
  const lockedDealQuery = tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1) as any;
  const lockedDeals =
    typeof lockedDealQuery.for === "function"
      ? await lockedDealQuery.for("update")
      : await lockedDealQuery;
  const existing = lockedDeals[0] ?? null;
  if (!existing) {
    throw new AppError(404, "Deal not found");
  }

  if (input.assignedRepId !== undefined && input.assignedRepId !== existing.assignedRepId) {
    const isDirectorOrAdmin = userRole === "admin" || userRole === "director";
    if (!isDirectorOrAdmin && existing.assignedRepId !== userId) {
      throw new AppError(
        403,
        "Only the assigned rep, a director, or an admin can reassign this deal",
        "DEAL_REASSIGNMENT_FORBIDDEN"
      );
    }
  }

  // Reps can only edit their own deals
  if (userRole === "rep" && existing.assignedRepId !== userId) {
    throw new AppError(403, "You can only edit your own deals");
  }

  // Validate assignee if being changed
  if (input.assignedRepId !== undefined) {
    await validateDealReassignmentAssignee(
      tenantDb,
      input.assignedRepId,
      existing.officeCode,
      existing.assignedRepId ?? null,
      officeId
    );
  }

  assertDealUpdateLineagePolicy(existing, input);

  // Build update object — only include fields that are provided
  const updates: Record<string, any> = {};
  const projectTypeChange =
    input.projectType !== undefined
      ? {
          oldValue: existing.projectType ?? null,
          newValue: input.projectType === null ? null : await assertValidProjectType(input.projectType),
        }
      : null;

  if (projectTypeChange) {
    if (projectTypeChange.newValue === null) {
      throw new AppError(400, "projectType cannot be cleared after Opportunity");
    }
    if (projectTypeChange.newValue !== projectTypeChange.oldValue) {
      Object.assign(
        updates,
        await applyProjectTypeChange(
          tenantDb,
          existing,
          existing.projectTypeId ?? null,
          { id: userId, role: userRole },
          { projectTypeValue: projectTypeChange.newValue }
        )
      );
    }
  }

  if (input.name !== undefined) updates.name = input.name;
  const assignedRepChanged =
    input.assignedRepId !== undefined && input.assignedRepId !== existing.assignedRepId;
  if (input.assignedRepId !== undefined) {
    updates.assignedRepId = input.assignedRepId;
    if (assignedRepChanged) {
      updates.ownershipSyncStatus = "manual_reassign";
      updates.unassignedReasonCode = null;
    }
  }
  if (input.primaryContactId !== undefined) updates.primaryContactId = input.primaryContactId;
  if (input.ddEstimate !== undefined) updates.ddEstimate = input.ddEstimate;
  if (input.bidEstimate !== undefined) updates.bidEstimate = input.bidEstimate;
  if (input.awardedAmount !== undefined) updates.awardedAmount = input.awardedAmount;
  if (input.description !== undefined) updates.description = input.description;
  if (input.propertyAddress !== undefined) updates.propertyAddress = input.propertyAddress;
  if (input.propertyCity !== undefined) updates.propertyCity = input.propertyCity;
  if (input.propertyState !== undefined) updates.propertyState = input.propertyState;
  if (input.propertyZip !== undefined) updates.propertyZip = input.propertyZip;
  if (input.projectTypeId !== undefined) updates.projectTypeId = input.projectTypeId;
  if (input.regionId !== undefined) updates.regionId = input.regionId;
  if (input.source !== undefined) updates.source = input.source;
  if (input.winProbability !== undefined) updates.winProbability = input.winProbability;
  if (input.expectedCloseDate !== undefined) updates.expectedCloseDate = input.expectedCloseDate;
  if (input.onHold !== undefined) {
    if (input.onHold && !existing.onHold) {
      updates.onHold = true;
      updates.onHoldStartedAt = new Date();
    } else if (!input.onHold && existing.onHold) {
      const holdStartedAt = existing.onHoldStartedAt instanceof Date
        ? existing.onHoldStartedAt
        : existing.onHoldStartedAt
          ? new Date(existing.onHoldStartedAt)
          : null;
      const elapsedHoldSeconds =
        holdStartedAt == null
          ? 0
          : Math.max(0, Math.floor((Date.now() - holdStartedAt.getTime()) / 1000));
      updates.onHold = false;
      updates.onHoldStartedAt = null;
      updates.onHoldAccumulatedSeconds =
        Math.max(0, Number(existing.onHoldAccumulatedSeconds ?? 0)) + elapsedHoldSeconds;
    }
  }
  if (input.proposalNotes !== undefined) updates.proposalNotes = input.proposalNotes;
  if (input.workflowRoute !== undefined) {
    if (existing.sourceLeadId) {
      throw new AppError(
        400,
        "workflowRoute is derived from lead routing and cannot be changed manually"
      );
    }
    const stage = await getStageByIdForWorkflowRoute(existing.stageId, input.workflowRoute);
    if (!stage) {
      throw new AppError(400, "Current stage is not valid for the requested workflow route");
    }
    updates.workflowRoute = input.workflowRoute;
  }

  if (input.sourceLeadId !== undefined) {
    const assignedRepId = input.assignedRepId ?? existing.assignedRepId;
    if (!assignedRepId) {
      throw new AppError(400, "assignedRepId is required when attaching a source lead");
    }
    const lineage = await resolveSourceLeadLineage(tenantDb, {
      name: existing.name,
      stageId: existing.stageId,
      assignedRepId,
      officeId,
      officeCode: existing.officeCode ?? "dfw",
      sourceLeadId: input.sourceLeadId as string,
      companyId: input.companyId ?? existing.companyId ?? undefined,
      propertyId: input.propertyId ?? existing.propertyId ?? undefined,
      primaryContactId:
        input.primaryContactId === undefined
          ? (existing.primaryContactId ?? undefined)
          : (input.primaryContactId ?? undefined),
      source: input.source === undefined ? (existing.source ?? undefined) : (input.source ?? undefined),
      workflowRoute: input.workflowRoute ?? existing.workflowRoute,
    }, {
      existingDealId: existing.id,
    });

    updates.sourceLeadId = lineage.sourceLeadId;
    if (!existing.companyId || input.companyId !== undefined) updates.companyId = lineage.companyId;
    if (!existing.propertyId || input.propertyId !== undefined) updates.propertyId = lineage.propertyId;
    if (input.primaryContactId === undefined && lineage.primaryContactId !== existing.primaryContactId) {
      updates.primaryContactId = lineage.primaryContactId;
    }
    if (input.source === undefined && lineage.source !== existing.source) {
      updates.source = lineage.source;
    }
  } else {
    if (input.companyId !== undefined) updates.companyId = input.companyId;
    if (input.propertyId !== undefined) updates.propertyId = input.propertyId;
  }

  if (
    input.primaryContactId !== undefined ||
    input.companyId !== undefined ||
    input.sourceLeadId !== undefined
  ) {
    await validateDealPrimaryContact(
      tenantDb,
      (updates.companyId ?? existing.companyId ?? null) as string | null,
      (updates.primaryContactId ?? existing.primaryContactId ?? null) as string | null
    );
  }

  if (existing.isBidBoardOwned) {
    for (const [field, label] of Object.entries(BID_BOARD_OWNED_UPDATE_FIELD_LABELS) as Array<
      [keyof UpdateDealInput, string]
    >) {
      if (input[field] !== undefined) {
        const message =
          field === "estimatingSubstage"
            ? "Estimating progress is mirrored from Bid Board after estimating handoff."
            : field === "proposalStatus"
              ? "Proposal status is mirrored from Bid Board after estimating handoff."
              : `${label} is mirrored from Bid Board after estimating handoff.`;
      throw new AppError(
        403,
          message,
        "BID_BOARD_OWNED_FIELD_READ_ONLY"
      );
      }
    }
  }

  // Validate and set estimating substage
  if (input.estimatingSubstage !== undefined) {
    if (
      input.estimatingSubstage !== null &&
      !VALID_ESTIMATING_SUBSTAGE_SET.has(input.estimatingSubstage)
    ) {
      throw new AppError(400, `Invalid estimating substage: ${input.estimatingSubstage}`);
    }
    updates.estimatingSubstage = input.estimatingSubstage;
  }

  // Proposal status with validation, state machine enforcement, auto-timestamps, and revision counter
  if (input.proposalStatus !== undefined) {
    if (
      input.proposalStatus !== null &&
      !VALID_PROPOSAL_STATUS_SET.has(input.proposalStatus)
    ) {
      throw new AppError(400, `Invalid proposal status: ${input.proposalStatus}`);
    }

    // Enforce valid state transitions
    const ALLOWED_TRANSITIONS: Record<string, string[]> = {
      not_started: ["drafting"],
      drafting: ["sent"],
      sent: ["under_review", "rejected"],
      under_review: ["revision_requested", "accepted", "rejected"],
      revision_requested: ["sent"],
      accepted: ["signed"],
      signed: [],
      rejected: [],
    };

    const currentStatus = existing.proposalStatus ?? "not_started";
    if (input.proposalStatus !== null) {
      const allowed = ALLOWED_TRANSITIONS[currentStatus] ?? [];
      if (!allowed.includes(input.proposalStatus)) {
        throw new AppError(400, `Cannot transition proposal from '${currentStatus}' to '${input.proposalStatus}'`);
      }
    }

    updates.proposalStatus = input.proposalStatus;
    if (input.proposalStatus === "sent") {
      updates.proposalSentAt = new Date();
    } else if (input.proposalStatus === "revision_requested") {
      updates.proposalRevisionCount = sql`coalesce(proposal_revision_count, 0) + 1`;
    } else if (input.proposalStatus === "accepted" || input.proposalStatus === "signed") {
      updates.proposalAcceptedAt = new Date();
    }
  }

  if (Object.keys(updates).length === 0) {
    return existing;
  }

  const result = await tenantDb
    .update(deals)
    .set(updates)
    .where(eq(deals.id, dealId))
    .returning();

  const updatedDeal = result[0];
  const auditFieldChanges = buildRawFieldChanges(
    existing as Record<string, unknown>,
    updatedDeal as Record<string, unknown>,
    [
      "name",
      "assignedRepId",
      "primaryContactId",
      "ddEstimate",
      "bidEstimate",
      "awardedAmount",
      "description",
      "propertyAddress",
      "propertyCity",
      "propertyState",
      "propertyZip",
      "projectType",
      "projectTypeId",
      "regionId",
      "source",
      "winProbability",
      "expectedCloseDate",
      "onHold",
      "onHoldStartedAt",
      "onHoldAccumulatedSeconds",
      "proposalStatus",
      "proposalNotes",
      "estimatingSubstage",
      "workflowRoute",
    ]
  );

  if (input.auditContext && Object.keys(auditFieldChanges).length > 0) {
    await logActivity({
      tenantDb,
      actor: input.auditContext.actor,
      action: "update",
      entity: buildDealAuditEntity(updatedDeal),
      fieldChanges: auditFieldChanges,
      ipAddress: input.auditContext.ipAddress ?? null,
      userAgent: input.auditContext.userAgent ?? null,
    });
  }

  if (assignedRepChanged && updatedDeal) {
    const changedAt = new Date();
    await writeAuditLog(tenantDb, {
      tableName: "deal_history",
      recordId: dealId,
      action: "update",
      changedBy: userId,
      changes: {
        assignedRepId: {
          from: existing.assignedRepId,
          to: input.assignedRepId ?? null,
        },
      },
      fullRow: {
        oldRepId: existing.assignedRepId,
        newRepId: input.assignedRepId ?? null,
        changedBy: userId,
        changedAt: changedAt.toISOString(),
      },
    });

    await createAssignmentTaskIfNeeded(tenantDb, {
      entityType: "deal",
      entityId: dealId,
      entityName: updatedDeal.name,
      previousAssignedRepId: existing.assignedRepId ?? null,
      nextAssignedRepId: input.assignedRepId ?? null,
      actorUserId: userId,
      officeId: officeId ?? null,
      now: changedAt,
    });

    await tenantDb.insert(jobQueue).values({
      jobType: "domain_event",
      payload: {
        eventName: "deal.assignment.changed",
        dealId,
        dealName: updatedDeal.name,
        dealNumber: updatedDeal.dealNumber,
        oldRepId: existing.assignedRepId ?? null,
        newRepId: input.assignedRepId ?? null,
        changedBy: userId,
        changedAt: changedAt.toISOString(),
        source: "crm_deal_card",
        propagationChannel: "synchub_bid_board",
      },
      officeId: officeId ?? null,
      status: "pending",
      runAfter: changedAt,
    });
  }

  // Re-geocode if address changed
  const addressChanged =
    input.propertyAddress !== undefined ||
    input.propertyCity !== undefined ||
    input.propertyState !== undefined;

  if (addressChanged) {
    const addr = input.propertyAddress ?? existing.propertyAddress;
    const city = input.propertyCity ?? existing.propertyCity;
    const state = input.propertyState ?? existing.propertyState;
    const zip = input.propertyZip ?? existing.propertyZip;

    if (addr) {
      // Queue geocode as background job (the tenantDb connection will be released after commit)
      db.insert(jobQueue).values({
        jobType: "geocode_deal",
        payload: { dealId, address: `${addr}, ${city || ""} ${state || ""} ${zip || ""}`.trim() },
        officeId: officeId ?? null,
        status: "pending",
        runAfter: new Date(),
      }).catch((err) => console.error("[Deals] Failed to queue geocode job:", err));
    }
  }

  return updatedDeal;
}

export async function startProposalDraft(
  tenantDb: TenantDb,
  dealId: string,
  userRole: string,
  userId: string,
  auditContext?: AuditContext
) {
  const existing = await getDealById(tenantDb, dealId, userRole, userId);
  if (!existing) {
    throw new AppError(404, "Deal not found");
  }

  if (userRole === "rep" && existing.assignedRepId !== userId) {
    throw new AppError(403, "You can only edit your own deals");
  }

  if (existing.isBidBoardOwned) {
    throw new AppError(
      403,
      "Proposal status is mirrored from Bid Board after estimating handoff.",
      "BID_BOARD_OWNED_FIELD_READ_ONLY"
    );
  }

  const currentStatus = existing.proposalStatus ?? "not_started";
  if (currentStatus !== "not_started" && currentStatus !== "drafting") {
    throw new AppError(400, `Cannot start proposal draft from '${currentStatus}'`);
  }

  const startedAt = existing.proposalDraftStartedAt ?? new Date();
  const [updatedDeal] = await tenantDb
    .update(deals)
    .set({
      proposalStatus: "drafting",
      proposalDraftStartedAt: startedAt,
      updatedAt: new Date(),
    })
    .where(eq(deals.id, dealId))
    .returning();

  if (auditContext) {
    await logActivity({
      tenantDb,
      actor: auditContext.actor,
      action: "update",
      entity: buildDealAuditEntity(updatedDeal),
      fieldChanges: {
        proposalStatus: {
          from: existing.proposalStatus ?? "not_started",
          to: "drafting",
        },
        proposalDraftStartedAt: {
          from: existing.proposalDraftStartedAt ? existing.proposalDraftStartedAt.toISOString() : null,
          to: startedAt.toISOString(),
        },
      },
      ipAddress: auditContext.ipAddress ?? null,
      userAgent: auditContext.userAgent ?? null,
    });
  } else {
    await writeAuditLog(tenantDb, {
      tableName: "proposal_drafts",
      recordId: dealId,
      action: "insert",
      changedBy: userId,
      changes: {
        proposalStatus: {
          from: existing.proposalStatus ?? "not_started",
          to: "drafting",
        },
        proposalDraftStartedAt: {
          from: existing.proposalDraftStartedAt ?? null,
          to: startedAt.toISOString(),
        },
      },
      fullRow: {
        dealId,
        status: "draft",
        startedAt: startedAt.toISOString(),
        createdBy: userId,
      },
    });
  }

  return updatedDeal;
}

/**
 * Soft-delete a deal.
 * Only admins can delete primary deal rows.
 */
export async function deleteDeal(tenantDb: TenantDb, dealId: string, userRole: string) {
  if (userRole !== "admin") {
    throw new AppError(403, "Only admins can delete deals");
  }

  const [existing] = await tenantDb.select().from(deals).where(eq(deals.id, dealId)).limit(1);
  if (!existing) {
    throw new AppError(404, "Deal not found");
  }

  if (!existing.isActive) {
    return null;
  }

  const result = await tenantDb
    .update(deals)
    .set({ isActive: false })
    .where(eq(deals.id, dealId))
    .returning();

  if (result.length === 0) {
    throw new AppError(404, "Deal not found");
  }

  // Auto-dismiss pending/in-progress tasks when deal is soft-deleted
  await tenantDb
    .update(tasks)
    .set({ status: "dismissed", isOverdue: false })
    .where(
      and(
        eq(tasks.dealId, dealId),
        inArray(tasks.status, ["pending", "in_progress"]),
      )
    );

  return result[0];
}

/**
 * Get deals grouped by stage for pipeline/kanban view.
 * Returns stages with their deals, ordered by display_order.
 * Excludes terminal stages from the main board (returned separately).
 */
export async function getDealsForPipeline(
  tenantDb: TenantDb,
  userRole: string,
  userId: string,
  filters?: {
    assignedRepId?: string;
    estimateSentFrom?: string;
    estimateSentTo?: string;
    includeDd?: boolean;
    previewLimit?: number;
    scope?: WorkspaceScope;
    activeOfficeId?: string | null;
  } & PipelineTerminalDateFilters,
  atRiskViewerRole: string = userRole
) {
  // Get all stages ordered
  const stages = await db
    .select()
    .from(pipelineStageConfig)
    .where(inArray(pipelineStageConfig.workflowFamily, ["standard_deal", "service_deal"]))
    .orderBy(asc(pipelineStageConfig.displayOrder));

  const terminalFilters = resolvePipelineTerminalDateFilters(filters);
  const wonPeriodRange = resolvePipelineWonPeriodRange(filters ?? {});
  const canonicalWonStageId = stages.find((stage) => stage.slug === "won" && stage.isActivePipeline)?.id ?? null;
  const canonicalLostStageId = stages.find((stage) => stage.slug === "lost" && stage.isActivePipeline)?.id ?? null;
  const wonStageIds = stages
    .filter(
      (stage) =>
        WON_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof WON_TERMINAL_STAGE_SLUGS)[number])
    )
    .map((stage) => stage.id);
  const lostStageIds = stages
    .filter(
      (stage) =>
        LOST_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof LOST_TERMINAL_STAGE_SLUGS)[number])
    )
    .map((stage) => stage.id);
  const wonSignedDateSince = toIsoDateOnly(terminalFilters.won.since);
  const wonSignedDateUntil = toIsoDateOnly(terminalFilters.won.until);
  const wonPeriodFrom = toIsoDateOnly(wonPeriodRange.from);
  const wonPeriodTo = toIsoDateOnly(wonPeriodRange.to);
  const wonWindowDate = dealWonWindowDateSql();
  const lostWindowDate = dealLostWindowDateSql();
  const pipelineCardsPerStageLimit = Math.max(
    1,
    Math.min(
      Number.isFinite(filters?.previewLimit) ? Math.floor(filters!.previewLimit as number) : DEFAULT_PIPELINE_CARDS_PER_STAGE_LIMIT,
      MAX_PIPELINE_CARDS_PER_STAGE_LIMIT
    )
  );

  const commonConditions: any[] = [];
  const mineVisibility = filters?.scope === "mine" ? await resolveMineVisibilityFeatures(tenantDb) : null;
  let assignedRepFilterHandled = false;

  if (filters?.scope === "mine") {
    commonConditions.push(
      buildDealMineVisibilityCondition(userId, {
        includeSubscriptions: mineVisibility?.dealSubscriptions,
        includeCreatedBy: mineVisibility?.dealsCreatedByUserId,
        includeSubscriptionDeletedAt: mineVisibility?.dealSubscriptionsDeletedAt,
      })
    );
  } else if (filters?.scope === "team") {
    const teamRepIds = await resolveTeamRepIds(tenantDb, userId, filters.activeOfficeId ?? null);
    if (filters?.assignedRepId) {
      commonConditions.push(
        teamRepIds.includes(filters.assignedRepId)
          ? eq(deals.assignedRepId, filters.assignedRepId)
          : sql`false`
      );
      assignedRepFilterHandled = true;
    } else {
      commonConditions.push(teamRepIds.length > 0 ? inArray(deals.assignedRepId, teamRepIds) : sql`false`);
    }
  }
  if (filters?.assignedRepId && !assignedRepFilterHandled) {
    commonConditions.push(eq(deals.assignedRepId, filters.assignedRepId));
  }
  addEstimateSentDateConditions(commonConditions, filters ?? {});

  const responseStages = stages.filter((stage) => {
    if (!stage.isTerminal) return filters?.includeDd || stage.isActivePipeline;
    if (!stage.isActivePipeline) return false;
    if (WON_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof WON_TERMINAL_STAGE_SLUGS)[number])) {
      return canonicalWonStageId == null || stage.id === canonicalWonStageId;
    }
    if (LOST_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof LOST_TERMINAL_STAGE_SLUGS)[number])) {
      return canonicalLostStageId == null || stage.id === canonicalLostStageId;
    }
    return false;
  });

  const dealsByStage = new Map<string, Array<DealRow & { companyName: string | null; assignedRepName: string | null }>>();
  const activeCountByStage = new Map<string, number>();
  const totalCountByStage = new Map<string, number>();
  const valueByStage = new Map<string, number>();

  // Sequential per-stage queries required: tenantDb is a single transaction
  // client, so parallel stage fan-out fails in production.
  for (const stage of responseStages) {
    const stageConditions: any[] = [];
    const isTerminalStage =
      stage.isTerminal ||
      stage.slug === "won" ||
      stage.slug === "lost";
    if (WON_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof WON_TERMINAL_STAGE_SLUGS)[number])) {
      stageConditions.push(canonicalWonStageId ? inArray(deals.stageId, wonStageIds) : eq(deals.stageId, stage.id));
      if (wonSignedDateSince || wonSignedDateUntil || wonPeriodFrom || wonPeriodTo) {
        stageConditions.push(dealWonWindowEligibilitySql());
      }
      if (wonSignedDateSince) {
        stageConditions.push(sql`${wonWindowDate} >= ${wonSignedDateSince}::date`);
      }
      if (wonSignedDateUntil) {
        stageConditions.push(sql`${wonWindowDate} <= ${wonSignedDateUntil}::date`);
      }
      if (wonPeriodFrom) {
        stageConditions.push(sql`${wonWindowDate} >= ${wonPeriodFrom}::date`);
      }
      if (wonPeriodTo) {
        stageConditions.push(sql`${wonWindowDate} <= ${wonPeriodTo}::date`);
      }
    } else if (LOST_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof LOST_TERMINAL_STAGE_SLUGS)[number])) {
      stageConditions.push(canonicalLostStageId ? inArray(deals.stageId, lostStageIds) : eq(deals.stageId, stage.id));
      if (terminalFilters.lost.since || terminalFilters.lost.until) {
        stageConditions.push(dealLostWindowEligibilitySql());
      }
      if (terminalFilters.lost.since) {
        stageConditions.push(sql`${lostWindowDate} >= ${terminalFilters.lost.since}`);
      }
      if (terminalFilters.lost.until) {
        stageConditions.push(sql`${lostWindowDate} < ${addUtcDays(terminalFilters.lost.until, 1)}`);
      }
    } else {
      stageConditions.push(eq(deals.isActive, true), eq(deals.stageId, stage.id));
      stageConditions.push(nonTerminalMirroredStageCondition());
    }

    const where = and(...stageConditions, ...commonConditions);
    const summaryRows = await tenantDb
      .select({
        totalCount: sql<number>`count(*)`,
        activeCount: sql<number>`count(*) filter (where ${aliasedActiveDealCountFilterSql("deals")})`,
        totalValue: sql<number>`COALESCE(SUM(${effectiveDealValueSql(isTerminalStage)}), 0)`,
      })
      .from(deals)
      .where(where);

    const stageDeals = await tenantDb
      .select({
        ...getTableColumns(deals),
        companyName: companies.name,
        assignedRepName: users.displayName,
      })
      .from(deals)
      .leftJoin(companies, eq(companies.id, deals.companyId))
      .leftJoin(users, eq(users.id, deals.assignedRepId))
      .where(where)
      .orderBy(...buildPipelineStageCardsOrder())
      .limit(pipelineCardsPerStageLimit);
    dealsByStage.set(stage.id, stageDeals);

    activeCountByStage.set(stage.id, Number(summaryRows[0]?.activeCount ?? 0));
    totalCountByStage.set(stage.id, Number(summaryRows[0]?.totalCount ?? 0));
    valueByStage.set(stage.id, Number(summaryRows[0]?.totalValue ?? 0));
  }

  // Build response: active pipeline stages + date-filtered terminal stages.
  const pipelineColumns = responseStages.map((stage) => ({
    stage,
    deals: (dealsByStage.get(stage.id) ?? []).map((deal) =>
      attachAtRiskResult(deal, atRiskViewerRole, stage.slug)
    ),
    totalValue: valueByStage.get(stage.id) ?? 0,
    count: activeCountByStage.get(stage.id) ?? 0,
    activeCount: activeCountByStage.get(stage.id) ?? 0,
    totalCount: totalCountByStage.get(stage.id) ?? 0,
  }));

  const terminalStages = responseStages
    .filter((s) => s.isTerminal)
    .map((stage) => ({
      stage,
      count: activeCountByStage.get(stage.id) ?? 0,
      activeCount: activeCountByStage.get(stage.id) ?? 0,
      totalCount: totalCountByStage.get(stage.id) ?? 0,
      totalValue: valueByStage.get(stage.id) ?? 0,
    }));

  return { pipelineColumns, terminalStages };
}

export async function listDealStagePage(tenantDb: TenantDb, input: DealStagePageInput) {
  const stages = await listDealStages();
  const [stage] = stages.filter((item) => item.id === input.stageId);
  if (!stage) throw new AppError(404, "Deal stage not found");

  const page = Math.max(1, input.page || 1);
  const pageSize = Math.max(1, Math.min(100, input.pageSize || 25));
  const offset = (page - 1) * pageSize;
  const scope = await buildDealWorkspaceScope(tenantDb, input, stage);
  const stageSlugs = WON_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof WON_TERMINAL_STAGE_SLUGS)[number])
    ? WON_TERMINAL_STAGE_SLUGS
    : LOST_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof LOST_TERMINAL_STAGE_SLUGS)[number])
      ? LOST_TERMINAL_STAGE_SLUGS
      : null;
  const stageIds =
    stageSlugs == null
      ? [input.stageId]
      : stages
          .filter((item) => (stageSlugs as readonly string[]).includes(item.slug))
          .map((item) => item.id);

  const conditions = [
    scope,
    sql`d.stage_id IN (${sqlList(stageIds)})`,
  ];

  if (input.search?.trim()) {
    const searchTerm = `%${input.search.trim()}%`;
    conditions.push(sql`(d.name ilike ${searchTerm} or d.deal_number ilike ${searchTerm})`);
  }
  if (input.assignedRepId) {
    conditions.push(sql`d.assigned_rep_id = ${input.assignedRepId}`);
  }
  if (input.regionId) {
    conditions.push(sql`d.region_id = ${input.regionId}`);
  }
  if (input.workflowRoute === "normal" || input.workflowRoute === "service") {
    conditions.push(sql`d.workflow_route = ${input.workflowRoute}`);
  }
  if (input.updatedFrom) {
    conditions.push(sql`d.updated_at::date >= ${input.updatedFrom}::date`);
  }
  if (input.updatedTo) {
    conditions.push(sql`d.updated_at::date <= ${input.updatedTo}::date`);
  }
  addWorkspaceEstimateSentDateConditions(conditions, input);
  if (typeof input.minAgeDays === "number" && Number.isFinite(input.minAgeDays)) {
    conditions.push(sql`extract(day from now() - d.stage_entered_at) >= ${input.minAgeDays}`);
  }
  if (typeof input.maxAgeDays === "number" && Number.isFinite(input.maxAgeDays)) {
    conditions.push(sql`extract(day from now() - d.stage_entered_at) <= ${input.maxAgeDays}`);
  }

  const where = sql.join(conditions, sql` and `);

  const countResult = await tenantDb.execute(sql`
    select
      count(*)::int as total_count,
      count(*) filter (where coalesce(d.on_hold, false) = false)::int as active_count,
      coalesce(sum(${workspaceEffectiveDealValueSql(stage)}), 0)::numeric as total_value,
      round(avg(extract(day from now() - d.stage_entered_at)) filter (where coalesce(d.on_hold, false) = false))::int as average_days_in_stage
    from deals d
    left join users u on u.id = d.assigned_rep_id
    where ${where}
  `);

  const rowResult = await tenantDb.execute(sql`
    select
      d.id,
      d.deal_number,
      d.project_number,
      d.name,
      d.stage_id,
      d.workflow_route,
      d.assigned_rep_id,
      u.display_name as assigned_rep_name,
      d.region_id,
      d.source,
      d.property_city,
      d.property_state,
      d.updated_at,
      d.stage_entered_at,
      d.is_bid_board_owned,
      d.bid_board_stage_slug,
      d.bid_board_stage_entered_at,
      d.on_hold,
      d.on_hold_started_at,
      d.on_hold_accumulated_seconds,
      d.on_hold_accumulated_seconds_at_stage_entry,
      d.awarded_amount,
      d.bid_board_total_sales,
      d.bid_estimate,
      d.dd_estimate,
      extract(day from now() - d.stage_entered_at)::int as days_in_stage
    from deals d
    left join users u on u.id = d.assigned_rep_id
    where ${where}
    order by ${buildStagePageOrder(input.sort, stage)}
    limit ${pageSize}
    offset ${offset}
  `);

  const summaryRow =
    (countResult.rows[0] as
      | {
          total_count?: string | number;
          active_count?: string | number;
          total_value?: string | number;
          average_days_in_stage?: string | number | null;
        }
      | undefined) ?? {};
  const total = Number(summaryRow.total_count ?? 0);
  const activeCount = Number(summaryRow.active_count ?? total);

  return {
    stage,
    scope: input.scope,
    summary: {
      count: activeCount,
      activeCount,
      totalCount: total,
      totalValue: Number(summaryRow.total_value ?? 0),
      averageDaysInStage:
        summaryRow.average_days_in_stage == null ? null : Number(summaryRow.average_days_in_stage),
    },
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
    rows: (rowResult.rows as DealStageWorkspaceRow[]).map((row) =>
      mapDealStageWorkspaceRow(row, input.atRiskViewerRole ?? input.role, stage.slug)
    ),
  };
}

/**
 * Get distinct sources used across deals (for filter dropdowns).
 */
export async function getDealSources(tenantDb: TenantDb) {
  const result = await tenantDb
    .selectDistinct({ source: deals.source })
    .from(deals)
    .where(not(isNull(deals.source)))
    .orderBy(asc(deals.source));

  return result.map((r) => r.source).filter(Boolean) as string[];
}

/**
 * Set or clear contract_signed_date on a deal. Writes an audit_log row when
 * the value actually changes. No-op (and no audit row) when the requested
 * value matches the current value.
 *
 * On a null→date transition (and ONLY then), also calculates the booked
 * commission for the assigned rep via calculateCommissionForDeal. The
 * deal update + audit insert + commission calculation all run inside a
 * single db.transaction() so a partial failure rolls back cleanly — a
 * deal can't be marked contract-signed without its commission row, and
 * the commission can't exist without the date.
 *
 * Caller is responsible for the RBAC gate. The route exposing this
 * function uses requireRole("admin", "director").
 */
export async function setDealContractSignedDate(
  tenantDb: TenantDb,
  dealId: string,
  contractSignedDate: string | null,
  userId: string,
  officeId: string | null = null,
  auditContext?: AuditContext
): Promise<typeof deals.$inferSelect | null> {
  return tenantDb.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(deals)
      .where(eq(deals.id, dealId))
      .limit(1);
    if (!existing) return null;

    const oldValue = existing.contractSignedDate ?? null;
    const newValue = contractSignedDate ?? null;
    const oldContractSignedAt = normalizeContractSignedAt(existing.contractSignedAt);
    const newContractSignedAt = contractSignedAtFromDate(newValue);
    if (
      oldValue === newValue &&
      (oldValue !== null || timestampKey(oldContractSignedAt) === timestampKey(newContractSignedAt))
    ) {
      return existing;
    }

    const isInitialContractSignedAt =
      oldValue == null && oldContractSignedAt == null && newContractSignedAt != null;
    let contractStageId: string | null = null;
    if (isInitialContractSignedAt) {
      const currentStage = await getStageByIdForWorkflowRoute(
        existing.stageId,
        existing.workflowRoute ?? "normal"
      );
      if (currentStage?.slug !== "contract") {
        throw new AppError(
          400,
          "contract_signed_at can only be set while the deal is in Contract.",
          "CONTRACT_SIGNED_STAGE_REQUIRED"
        );
      }
      contractStageId = currentStage.id;
    }

    const now = new Date();
    const [updated] = await tx
      .update(deals)
      .set({
        contractSignedDate: newValue,
        contractSignedAt: newContractSignedAt,
        updatedAt: now,
      })
      .where(eq(deals.id, dealId))
      .returning();

    if (!updated) return null;

    const contractChangeSet = {
      contractSignedDate: { from: oldValue, to: newValue },
      contractSignedAt: {
        from: oldContractSignedAt ? oldContractSignedAt.toISOString() : null,
        to: newContractSignedAt ? newContractSignedAt.toISOString() : null,
      },
    };

    if (auditContext) {
      await logActivity({
        tenantDb: tx,
        actor: auditContext.actor,
        action: "update",
        entity: buildDealAuditEntity(updated),
        fieldChanges: contractChangeSet,
        ipAddress: auditContext.ipAddress ?? null,
        userAgent: auditContext.userAgent ?? null,
      });
    } else {
      await writeAuditLog(tx, {
        tableName: "deals",
        recordId: dealId,
        action: "update",
        changedBy: userId,
        changes: contractChangeSet,
      });
    }

    // Commission fires only on null → date. Edits and clears do not
    // recalculate (per Decision 5; recalc-on-edit is a TODO follow-up).
    const isInitialSign = oldValue == null && newValue != null;
    if (isInitialSign) {
      await calculateCommissionForDeal(tx, {
        dealId,
        contractSignedDate: newValue,
        triggeredByUserId: userId,
      });
    }

    if (isInitialContractSignedAt && isContractSignedHandoffEnabled()) {
      const payload = {
        eventName: DOMAIN_EVENTS.DEAL_CONTRACT_SIGNED,
        eventId: randomUUID(),
        idempotencyKey: `deal:${dealId}:contract_signed:${newContractSignedAt.toISOString()}`,
        dealId,
        dealNumber: updated.dealNumber,
        dealName: updated.name,
        officeId,
        workflowRoute: updated.workflowRoute,
        contractSignedAt: newContractSignedAt,
        contractStageId: contractStageId ?? updated.stageId,
        signedBy: userId,
        source: "crm_contract_signed_date",
      } satisfies DealContractSignedEventPayload;

      await tx.insert(jobQueue).values({
        jobType: "domain_event",
        payload,
        officeId,
        status: "pending",
        runAfter: now,
      });
    }

    return updated;
  });
}

function contractSignedAtFromDate(value: string | null): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

function normalizeContractSignedAt(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function timestampKey(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
