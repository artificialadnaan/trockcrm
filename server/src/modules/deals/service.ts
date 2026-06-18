import { randomUUID } from "node:crypto";
import { eq, and, desc, asc, inArray, sql, or, isNull, not, getTableColumns, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
  projects,
} from "@trock-crm/shared/schema";
import {
  DOMAIN_EVENTS,
  getDealAtRiskResult,
  isGenuineWonDealStageSlug,
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
import {
  calculateCommissionForDeal,
  mintEstimatorCommissionForDeal,
  recalculateCommissionForDeal,
  removeCommissionForDeal,
  removeEstimatorCommissionForDeal,
} from "../commissions/service.js";
import { getActiveProjectTypes, getStageById, getStageBySlug, resolveActiveProjectTypeValue } from "../pipeline/service.js";
import { evaluatePostConversionEnrichment } from "./post-conversion-enrichment.js";
import { createAssignmentTaskIfNeeded } from "../assignment-tasks/service.js";
import { generateDealNumberForProject } from "../../services/projectNumber.js";
import { isContractSignedHandoffEnabled } from "../../config/feature-flags.js";
import { resolveActiveOfficeUserIds, resolveTeamRepIds } from "../shared/team-scope.js";
import {
  buildAliasedDealMineVisibilityCondition,
  buildDealMineVisibilityCondition,
  buildAliasedDealWatchedCondition,
  buildDealWatchedCondition,
  resolveMineVisibilityFeatures,
} from "../shared/mine-visibility.js";
import { resolveLeadSourceDisplayValue } from "../leads/source-control.js";
import { resolveDealCreationPolicy, type DealCreationOrigin } from "./direct-create-rules.js";
import { logActivity, type AuditContext } from "../audit/audit-logger.js";
import { listDealChangeOrders, softDeleteChangeOrderChildren, sumDealChangeOrders } from "./change-order-service.js";
import { LOST_STAGE_SLUGS, TERMINAL_STAGE_SLUGS, WON_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";
import { assertActiveDealStageWriteTarget } from "./stage-write-guard.js";
import {
  aliasedActiveDealCountFilterSql,
  aliasedActiveNonZeroDealSortTierSql,
  aliasedDealAwardedFirstWithFallbackSql,
  aliasedDealBestEstimateSql,
  aliasedWonHsClosedWonDateSql,
  dealAwardedFirstWithFallbackSql,
  dealBestEstimateSql,
} from "../shared/deal-value-sql.js";
import {
  aliasedDealDateScopeColumns,
  buildStageEntryDateWindow,
  dealDateScopeColumns,
  dealDisplayDateExpr,
} from "../shared/deal-date-scope.js";
import { resolveWonClosedDateWriteThrough } from "../shared/won-close-date.js";
import { buildDealSearchCondition } from "../search/unified-search.js";
import { isStageEntryDateFilterEnabled } from "../../config/feature-flags.js";
import {
  buildDealFilterBarConditions,
  buildInvolvedRepCondition,
  buildAliasedInvolvedRepSql,
  aliasedStageAwareEffectiveDealValueSql,
  aliasedEffectiveStageAgeDaysSql,
  UNASSIGNED_FILTER_SENTINEL,
} from "./deal-filter-predicates.js";

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

export function buildDealOfficeScopeCondition(
  _alias: string,
  _input: { activeOfficeId: string; officeCode: string | null; officeUserIds: string[] }
) {
  // office_code is a cosmetic project-number prefix, NOT an access boundary. Deals are scoped by the
  // active-office SCHEMA (search_path) alone, so the deal list/board shows every deal in the schema
  // regardless of office_code — e.g. an ATL-prefixed deal created on the Dallas schema stays visible to
  // the Dallas reps who created it. (Signature/call sites kept unchanged; the scope inputs are
  // intentionally unused now.)
  return sql`true`;
}

// Excludes seeded/demo rows from production-facing deal reads. Matches the
// `COALESCE(is_test_data, false) = false` pattern already used across the
// reports and dashboard modules.
//
// NOTE: `is_active` is deliberately NOT bundled here. Terminal (Won/Lost) stage
// queries intentionally include inactive deals, so forcing `is_active = true`
// would drop closed deals from those aggregates. Each caller keeps its own
// `is_active` handling; this only adds the uniformly-safe test-data exclusion.
function excludeTestDataCondition(alias: string) {
  const dealAlias = sql.raw(alias);
  return sql`coalesce(${dealAlias}.is_test_data, false) = false`;
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
  // Shared FilterBar dimensions, consumed by the predicate registry
  // (deal-filter-predicates.ts). workflowRoute/status are loosely typed because
  // the route passes raw query values straight through and the predicate is the
  // single validation point (recognized -> apply, unrecognized -> no-match,
  // absent/empty/all/any -> omit). assignedRepId/regionId also accept the
  // UNASSIGNED_FILTER_SENTINEL ("__unassigned__") which maps to IS NULL.
  workflowRoute?: string;
  status?: string;
  valueMin?: number;
  valueMax?: number;
  minAgeDays?: number;
  maxAgeDays?: number;
  // Unified outcome-aware date window (the canonical platform-wide date model):
  // Won rows filter on the won/signed date, Lost rows on the lost date, open rows
  // on the entered-stage date (only when FEATURE_STAGE_ENTRY_DATE is on).
  dateFrom?: string;
  dateTo?: string;
  // D-15: force the outcome-aware OPEN window (stage_entered_at) regardless of the
  // global ENABLE_STAGE_ENTRY_DATE_FILTER flag. The rep drill-down sets this so a
  // window actually bounds open rows (post-#535 stage_entered_at is reliable);
  // otherwise an explicit outcome window leaves every open deal in (flag OFF default).
  stageEntryDateWindow?: boolean;
  // Exclude on-hold (migration parking-lot) deals from rows + count, matching the Won board/summary's
  // reportable filter. The Won stage-page / drill-down list opts in so it reconciles to the Won count;
  // every other caller omits it (on-hold included, unchanged). Applied via the predicate registry.
  excludeOnHold?: boolean;
  // Inclusive YYYY-MM-DD bounds against deals.contract_signed_at::date, with
  // deals.contract_signed_date as a transition fallback. RESERVED for the
  // commissions / contracts-signed surfaces (§6.5) — do NOT use for Won-period.
  contractSignedFrom?: string;
  contractSignedTo?: string;
  // Inclusive YYYY-MM-DD bounds for the /deals?filter=won drill-down, gated on the
  // app-owned canonical close-won date (deals.won_closed_date, §6.1). When set,
  // on-hold and null-close-date deals are excluded so this drill-down matches the
  // Won card.
  wonClosedFrom?: string;
  wonClosedTo?: string;
  estimateSentFrom?: string;
  estimateSentTo?: string;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  sortBy?: "name" | "created_at" | "updated_at" | "awarded_amount" | "stage_entered_at" | "expected_close_date" | "contract_signed_date" | "display_date";
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
  scope?: WorkspaceScope;
  activeOfficeId?: string;
  /**
   * Opt-in: also compute pagination.valueTotal — the SUM of the stage-aware effective value over the
   * full filtered set (the running-total card, #4). Off by default so the extra aggregate runs ONLY
   * for the surfaces that show the card, not every /deals call. When set, the Won stage-id set is
   * resolved (see needsStageClassification) so the SUM is always awarded-first for Won rows and can
   * never disagree with the list.
   */
  includeValueTotal?: boolean;
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
  // Role of the user performing the create — gates who may set awarded_amount (admin/director only).
  // Optional with safe-fail: a missing/insufficient role is denied when awarded_amount is set.
  actorRole?: string;
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
  projectNumber?: string | null;
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
  projectNumber?: string | null;
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
// Fields that are Procore-managed and therefore read-only in CRM on bid-board-owned deals.
// awarded_amount is intentionally NOT here: admin/director may manually override it (the edit is
// gated to those roles by the AWARDED_AMOUNT_RESTRICTED check above, and a manual edit marks the deal
// awarded_amount_overridden so the mirror stops syncing it).
// dd_estimate is intentionally NOT here either (unlocked 2026-06-18): the Bid Board sync NEVER writes
// dd_estimate — it only mirrors bid_estimate from Procore "Total Sales" — so a manual DD edit cannot
// desync from the mirror. DD is editable on EVERY deal, including bid-board-owned ones. bid_estimate
// stays locked (Procore-owned).
const BID_BOARD_OWNED_UPDATE_FIELD_LABELS: Partial<Record<keyof UpdateDealInput, string>> = {
  bidEstimate: "Bid estimate",
  estimatingSubstage: "Estimating progress",
  proposalStatus: "Proposal status",
};

// Canonical comparison form for change-detecting a money input:
//  - blank/whitespace        → null
//  - parseable money         → canonical numeric string (so "37027" and "37027.00" compare equal,
//                              and a whitespace-padded value from a non-UI API client is normalized)
//  - non-blank, UNPARSABLE   → the trimmed raw text (NOT null) — so an invalid value like "abc" can
//                              never collide with a blank value and skip the awarded-amount RBAC check.
function normalizeMoneyForCompare(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? String(n) : text;
}

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

type WorkspaceScope = "mine" | "team" | "all" | "watched";

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
  source?: string;
  staleOnly?: boolean;
  workflowRoute?: string;
  status?: string;
  projectTypeId?: string;
  valueMin?: number;
  valueMax?: number;
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
  is_change_order: boolean;
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

function buildDealListOrder(
  filters: DealFilters,
  classification: { wonStageIds: string[]; lostStageIds: string[]; stageEntryDateEnabled: boolean }
) {
  // Primary tier: active, non-zero deals on top; on-hold and $0-value deals sink to
  // the bottom of the list (sort-only — the WHERE set is unchanged, so they still
  // appear, just last). Within each tier the requested column sort + id tiebreaker
  // apply. The tier reuses the SAME stage-aware effective value the list displays and
  // filters on, so sort == filter == display (D-1).
  const tier = aliasedActiveNonZeroDealSortTierSql(
    "deals",
    aliasedStageAwareEffectiveDealValueSql("deals", classification.wonStageIds)
  );
  return [asc(tier), ...buildDealListColumnOrder(filters, classification)];
}

function buildDealListColumnOrder(
  filters: DealFilters,
  classification: { wonStageIds: string[]; lostStageIds: string[]; stageEntryDateEnabled: boolean }
) {
  const { wonStageIds, lostStageIds, stageEntryDateEnabled } = classification;
  switch (filters.sortBy) {
    case "name":
      return buildSortWithIdTieBreaker(deals.name, filters.sortDir === "asc" ? "asc" : "desc");
    case "display_date":
      // D-15: order by the SAME outcome-aware expression the list DISPLAYS (and filters)
      // — Won -> won_closed_date, Lost -> lost_at, open -> stage_entered_at — so the
      // mixed-outcome window is ordered by each row's displayed date, not one raw column
      // (sort == display == filter). Built from the identical Won/Lost classification.
      return buildSortWithIdTieBreaker(
        dealDisplayDateExpr({ wonStageIds, lostStageIds, stageEntryDateEnabled, columns: dealDateScopeColumns() }),
        filters.sortDir === "asc" ? "asc" : "desc"
      );
    case "created_at":
      return buildSortWithIdTieBreaker(deals.createdAt, filters.sortDir === "asc" ? "asc" : "desc");
    case "awarded_amount":
      // Stage-aware effective value (awarded-first for Won stage ids,
      // best-estimate otherwise) — the SAME expression the value FILTER and the
      // list DISPLAY use, so sort == filter == display (D-1; Codex #546). Raw
      // awarded_amount is null for most open deals and would mis-sort them.
      return buildSortWithIdTieBreaker(
        aliasedStageAwareEffectiveDealValueSql("deals", wonStageIds),
        filters.sortDir === "asc" ? "asc" : "desc"
      );
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

function buildPipelineStageCardsOrder(valueSource: PipelineValueSource) {
  // Two-tier order: active, non-zero cards on top; on-hold / $0 cards sink to the
  // bottom of the column. This is sort-only — every card still loads (the preview
  // limit is the board's effective-all 1000), nothing is hidden. The value tier
  // uses the SAME per-stage value source the column counts/sums, so the tier
  // matches what the column displays.
  const tier = aliasedActiveNonZeroDealSortTierSql("deals", dealPipelineValueSql(valueSource));
  // Sort before preview limiting so each column shows the actual newest cards,
  // not an arbitrary subset from a tied timestamp group.
  return [asc(tier), desc(deals.createdAt), desc(deals.id)] as const;
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
      return LOST_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof LOST_TERMINAL_STAGE_SLUGS)[number])
        ? sql`${workspaceEffectiveDealValueSql(stage)} desc, d.id desc`
        : sql`${aliasedPipelineValueSql("d", pipelineValueSourceForStageSlug(stage.slug))} desc, d.id desc`;
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
      // The rep's PRIMARY office differs from the deal's office, but a multi-office
      // rep may still hold an explicit additional-office grant (user_office_access)
      // covering it. Honor that grant — but only one the rep already holds; this
      // does not widen access. Match by office CODE (dfw/atl) because several
      // office records can fold to the same code (e.g. "Dallas Office"/"DFW Office").
      const accessibleOffices = await tenantDb
        .select({ slug: offices.slug, name: offices.name })
        .from(userOfficeAccess)
        .innerJoin(offices, eq(offices.id, userOfficeAccess.officeId))
        .where(eq(userOfficeAccess.userId, assigneeId));
      const hasAdditionalOfficeGrant = accessibleOffices.some(
        (office) => resolveOfficeCodeFromOffice(office) === normalizedDealOfficeCode
      );
      if (!hasAdditionalOfficeGrant) {
        throw new AppError(
          400,
          "Deals can only be reassigned to users in the same office",
          "DEAL_REASSIGNMENT_OFFICE_MISMATCH"
        );
      }
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
    // Same fallback as the officeCode branch and validateAssignee: a rep whose
    // primary office differs may still hold an explicit additional-office grant
    // (user_office_access) to the deal's office. Honor an already-held grant.
    const [access] = await tenantDb
      .select()
      .from(userOfficeAccess)
      .where(and(eq(userOfficeAccess.userId, assigneeId), eq(userOfficeAccess.officeId, dealOfficeId)))
      .limit(1);
    if (!access) {
      throw new AppError(
        400,
        "Deals can only be reassigned to users in the same office",
        "DEAL_REASSIGNMENT_OFFICE_MISMATCH"
      );
    }
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
  return aliasedWonHsClosedWonDateSql("d");
}

function workspaceWonWindowEligibilitySql() {
  return aliasedHasUsableWonDateSql("d");
}

function workspaceLostWindowDateSql() {
  return sql`d.lost_at`;
}

function workspaceLostWindowEligibilitySql() {
  // Lost-window date is the plain d.lost_at timestamp column (no calendar guard),
  // so each interpolation just emits the column reference.
  return sql`
    ${workspaceLostWindowDateSql()} IS NOT NULL
    AND NOT (
      d.bid_board_last_updated_at IS NOT NULL
      AND ${workspaceLostWindowDateSql()}::date = d.bid_board_last_updated_at::date
    )
  `;
}

// CANONICAL Won-period date helper now lives in the shared leaf value module
// (../shared/deal-value-sql.ts) so the deals service and the shared FilterBar
// date-scope share ONE definition. Re-exported here unchanged so every existing
// importer of "../deals/service.js" (dashboard card, this module's Won drill-down)
// keeps resolving it. The live guard reads the app-owned deals.won_closed_date
// column (a compact IS NOT NULL / >= / <= predicate per site), NOT a
// try_parse_hs_close_date call. The legacy raw HubSpot-JSON parse
// (public.try_parse_hs_close_date over hubspot_extra_properties->>'hs_closed_won_date')
// is no longer read at query time and has no TS helper; it survives only inline in the
// root scripts scripts/backfill-won-closed-date.ts and
// scripts/verify-won-closed-date-parity.ts, which populate/audit won_closed_date.
export { aliasedWonHsClosedWonDateSql };

// True iff the deal carries a usable HubSpot close-won date (non-null, non-empty,
// non-"0"). Period-bounded Won queries (YTD/MTD/any date window) require this so
// deals without a trustworthy close date are excluded from period totals; all-time
// queries omit the guard so those deals still count in the all-time number (§6.1).
export function aliasedHasUsableWonDateSql(alias: string) {
  return sql`${aliasedWonHsClosedWonDateSql(alias)} IS NOT NULL`;
}

// §6.8 eligibility carve-out, narrowed. The original heuristic also dropped rows
// where the win-date equalled bid_board_last_updated_at::date (a brittle de-dup
// against bid-board mirror writes). On the hs_closed_won_date basis that
// coincidence fires on 0 rows (hs dates ≤ 2026-05-07; bid_board_last_updated_at
// sits at the reseed tail 2026-05-28) and there are 0 duplicate project_numbers
// or hubspot_deal_ids among usable-won-date rows (both verified via read-only SQL
// against office_dallas), so it could only over-drop. Eligibility is therefore
// simply "has a usable won date".
function aliasedDealWonWindowEligibilitySql(alias: string) {
  return aliasedHasUsableWonDateSql(alias);
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

type PipelineValueSource = "won" | "current";

function pipelineValueSourceForStageSlug(stageSlug: string): PipelineValueSource {
  return WON_TERMINAL_STAGE_SLUGS.includes(stageSlug as (typeof WON_TERMINAL_STAGE_SLUGS)[number])
    ? "won"
    : "current";
}

function dealPipelineValueSql(valueSource: PipelineValueSource) {
  return valueSource === "won"
    ? dealAwardedFirstWithFallbackSql(deals)
    : dealBestEstimateSql(deals);
}

function aliasedPipelineValueSql(alias: string, valueSource: PipelineValueSource) {
  return valueSource === "won"
    ? aliasedDealAwardedFirstWithFallbackSql(alias)
    : aliasedDealBestEstimateSql(alias);
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
  const rawValue = aliasedPipelineValueSql("d", pipelineValueSourceForStageSlug(stage.slug));

  return sql`CASE WHEN d.on_hold THEN 0 ELSE ${rawValue} END`;
}

function terminalWorkspaceDateConditions(stage: PipelineStageRow, input: DealStagePageInput) {
  const terminalFilters = resolvePipelineTerminalDateFilters(input);
  // Build a FRESH window-date fragment at each comparison site. Reusing one
  // sql`` fragment instance across the >= and < positions corrupts the composed
  // SQL (the production YTD 500). See getDealsForPipeline for the full note.
  if (WON_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof WON_TERMINAL_STAGE_SLUGS)[number])) {
    const conditions: any[] = [];
    if (terminalFilters.won.since || terminalFilters.won.until) {
      conditions.push(workspaceWonWindowEligibilitySql());
    }
    if (terminalFilters.won.since) {
      conditions.push(sql`${workspaceWonWindowDateSql()} >= ${terminalFilters.won.since}`);
    }
    if (terminalFilters.won.until) {
      conditions.push(sql`${workspaceWonWindowDateSql()} < ${addUtcDays(terminalFilters.won.until, 1)}`);
    }
    return conditions;
  }
  if (LOST_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof LOST_TERMINAL_STAGE_SLUGS)[number])) {
    const conditions: any[] = [];
    if (terminalFilters.lost.since || terminalFilters.lost.until) {
      conditions.push(workspaceLostWindowEligibilitySql());
    }
    if (terminalFilters.lost.since) {
      conditions.push(sql`${workspaceLostWindowDateSql()} >= ${terminalFilters.lost.since}`);
    }
    if (terminalFilters.lost.until) {
      conditions.push(sql`${workspaceLostWindowDateSql()} < ${addUtcDays(terminalFilters.lost.until, 1)}`);
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

  // An explicit Status (stage-page only) OWNS is_active/on_hold (mirrors getDeals + buildStatusPredicate):
  // skip the active-only default so a status=inactive drill-down reconciles with the list instead of being
  // forced empty by is_active=true. The board (DealBoardInput) has no status, so its default is unchanged.
  const explicitStatus =
    "stageId" in input &&
    typeof (input as DealStagePageInput).status === "string" &&
    (input as DealStagePageInput).status !== "" &&
    (input as DealStagePageInput).status !== "any";
  if (!terminalScope) {
    if (!explicitStatus) filters.unshift(sql`d.is_active = true`);
  } else {
    filters.push(...terminalDateConditions);
  }

  const mineVisibility =
    input.scope === "mine" || input.scope === "watched"
      ? await resolveMineVisibilityFeatures(tenantDb)
      : null;

  if (input.scope === "mine") {
    filters.push(
      buildAliasedDealMineVisibilityCondition("d", input.userId, {
        includeSubscriptions: mineVisibility?.dealSubscriptions,
        includeCreatedBy: mineVisibility?.dealsCreatedByUserId,
        includeSubscriptionDeletedAt: mineVisibility?.dealSubscriptionsDeletedAt,
      })
    );
  } else if (input.scope === "watched") {
    // Watched = the deal_subscriptions relation in isolation. Capability-gate: an office without the
    // table degrades to an empty result (false) — never coerced to Mine, never falling through to All.
    filters.push(
      mineVisibility?.dealSubscriptions
        ? buildAliasedDealWatchedCondition("d", input.userId, {
            includeSubscriptionDeletedAt: mineVisibility?.dealSubscriptionsDeletedAt,
          })
        : sql`false`
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
    isChangeOrder: row.is_change_order,
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
  let wonClosedStageIds: string[] | null = null;
  const resolveWonClosedStageIds = async (stages?: Awaited<ReturnType<typeof listDealStages>>) => {
    if (wonClosedStageIds) return wonClosedStageIds;
    const wonStages = stages ?? await listDealStages();
    wonClosedStageIds = wonStages
      .filter((stage) =>
        WON_TERMINAL_STAGE_SLUGS.includes(stage.slug as (typeof WON_TERMINAL_STAGE_SLUGS)[number])
      )
      .map((stage) => stage.id);
    return wonClosedStageIds;
  };

  const hasWonClosedFilter = Boolean(filters.wonClosedFrom || filters.wonClosedTo);

  // Active filter defaults to true. Pipeline list/export can request mixed
  // visibility: active rows everywhere plus inactive rows only for terminal
  // stage ids in scope, matching kanban semantics. Won-period drill-downs use
  // the same mixed visibility regardless of the incoming isActive mode so the
  // API path cannot silently drop inactive historical Won aliases counted by the
  // card (§6.7). Client-supplied inactiveStageIds are intersected with the
  // server's terminal stage set so a crafted request cannot widen visibility to
  // inactive non-terminal rows.
  // The FilterBar Status dimension (when set) owns is_active/on_hold via the
  // predicate registry below, so the legacy isActive / wonClosed visibility
  // handling runs only when Status is absent. This prevents a conflicting
  // is_active=true default from zeroing out a status=inactive request. The
  // wonClosed drill-down and the FilterBar Status control are distinct surfaces
  // and never co-occur, so guarding the whole block is byte-identical for every
  // existing caller (none pass status).
  // status=any is documented as equivalent to UNSET (param contract §3): it omits
  // the on_hold/inactive narrowing but must still keep the default active
  // visibility, so it falls through to the legacy isActive default like an absent
  // status. Only the explicit active/on_hold/inactive values take over is_active.
  if (!filters.status || filters.status === "any") {
    if (filters.isActive === "pipeline" || (hasWonClosedFilter && filters.isActive !== "all")) {
      // Pipeline board + Won-period drill-down: LIVE rows only. This branch previously re-admitted
      // inactive terminal rows via or(is_active=true, stage_id IN terminalInactive) to "keep inactive
      // historical Won aliases" aligned with the Won card. But is_active=false is the canonical
      // soft-delete marker and there is no legitimately-inactive Won population, so that arm only ever
      // re-admitted SOFT-DELETED rows. Collapsing to is_active=true hides them and stays byte-aligned
      // with the Won card (which now also requires is_active=true, §6.7). Live Won stays visible.
      conditions.push(eq(deals.isActive, true));
    } else if (filters.isActive !== "all") {
      conditions.push(eq(deals.isActive, filters.isActive ?? true));
    }
  }

  if (filters.activeOfficeId) {
      const officeScope = await resolveActiveOfficeScope(tenantDb, filters.activeOfficeId);
      conditions.push(buildDealOfficeScopeCondition("deals", officeScope));
  }

  conditions.push(excludeTestDataCondition("deals"));

  const mineVisibility =
    scope === "mine" || scope === "watched" ? await resolveMineVisibilityFeatures(tenantDb) : null;

  if (scope === "mine") {
    conditions.push(
      buildDealMineVisibilityCondition(userId, {
        includeSubscriptions: mineVisibility?.dealSubscriptions,
        includeCreatedBy: mineVisibility?.dealsCreatedByUserId,
        includeSubscriptionDeletedAt: mineVisibility?.dealSubscriptionsDeletedAt,
      })
    );
  } else if (scope === "watched") {
    // Watched = the deal_subscriptions relation in isolation; capability-gate to empty when absent.
    conditions.push(
      mineVisibility?.dealSubscriptions
        ? buildDealWatchedCondition(userId, {
            includeSubscriptionDeletedAt: mineVisibility?.dealSubscriptionsDeletedAt,
          })
        : sql`false`
    );
  } else if (scope === "team") {
    const teamUserIds = await resolveTeamRepIds(tenantDb, userId, filters.activeOfficeId ?? null);
    conditions.push(teamUserIds.length > 0 ? inArray(deals.assignedRepId, teamUserIds) : sql`false`);
  }

  // Filter by stage(s)
  if (filters.stageIds && filters.stageIds.length > 0) {
    conditions.push(inArray(deals.stageId, filters.stageIds));
  }

  // Filter by source
  if (filters.source) {
    conditions.push(eq(deals.source, filters.source));
  }

  // FilterBar predicate registry: assigned rep (+Unassigned), region
  // (+Unassigned), project type, workflow, status, value range, stalled (gated),
  // and the outcome-aware date window. Each predicate is omitted when unset, so
  // this only narrows for dimensions the caller set. The won/lost stage-id sets
  // are resolved once (only when a date window is requested) so the date
  // predicate can classify rows without joining pipeline_stage_config — the
  // count queries below select from `deals` alone.
  // D-15: a surface that explicitly asks for the outcome window on open rows
  // (stageEntryDateWindow — the rep drill-down) forces stage_entered_at bounding even
  // when the global flag is OFF (its prod default), so the window is not silently inert
  // for open deals. post-#535 stage_entered_at is reliable.
  const stageEntryDateEnabled = isStageEntryDateFilterEnabled() || Boolean(filters.stageEntryDateWindow);
  let wonStageIds: string[] = [];
  let lostStageIds: string[] = [];
  // Resolve Won/Lost stage-id sets once when any stage-classified dimension is in
  // play: the outcome-aware date window (Won+Lost), and the stage-aware value
  // filter/sort (Won — awarded-first for Won stages). Done here so those
  // predicates classify rows without a pipeline_stage_config join (the count
  // queries below select from `deals` alone).
  const valueFilterRequested = Number.isFinite(filters.valueMin) || Number.isFinite(filters.valueMax);
  const needsStageClassification =
    Boolean(filters.dateFrom || filters.dateTo) ||
    valueFilterRequested ||
    filters.sortBy === "awarded_amount" ||
    filters.sortBy === "display_date" ||
    // The running-total SUM (#4) is stage-aware (awarded-first for Won stages), so it needs the Won
    // set resolved even when no date/value/sort dimension is active — otherwise a Won row would be
    // summed by the best-estimate chain and diverge from the awarded-first value the list displays.
    Boolean(filters.includeValueTotal);
  if (needsStageClassification) {
    const stages = await listDealStages();
    const wonSlugs = WON_STAGE_SLUGS as readonly string[];
    const lostSlugs = LOST_STAGE_SLUGS as readonly string[];
    wonStageIds = stages.filter((stage) => wonSlugs.includes(stage.slug)).map((stage) => stage.id);
    lostStageIds = stages.filter((stage) => lostSlugs.includes(stage.slug)).map((stage) => stage.id);
  }
  conditions.push(
    ...buildDealFilterBarConditions(filters, { wonStageIds, lostStageIds, stageEntryDateEnabled })
  );

  // Inclusive signed-contract range. Used by the rep dashboard YTD/MTD
  // click-through to surface the deals contributing to each card.
  if (filters.contractSignedFrom) {
    conditions.push(sql`${contractSignedDateForReporting} >= ${filters.contractSignedFrom}::date`);
  }
  if (filters.contractSignedTo) {
    conditions.push(sql`${contractSignedDateForReporting} <= ${filters.contractSignedTo}::date`);
  }
  // Won-period drill-down (§6.1/§6.3). Gate on the true HubSpot close-won date and,
  // for this drill-down only, exclude on-hold + null-close-date deals so the list
  // mirrors the Won card and the Director closed-period card for the same window.
  if (filters.wonClosedFrom || filters.wonClosedTo) {
    // Constrain to the canonical Won-family stages the card aggregates over, so a
    // deal that was Won (has won_closed_date) but later moved to a non-Won active
    // stage is NOT counted here. Without this, the drill-down over-counts vs the card
    // (the 1-deal residual seen in round-1). AND-ed with any caller-supplied stageIds
    // above, so an explicit non-Won stageIds + wonClosedFrom/To intersects to none.
    const wonStageIds = await resolveWonClosedStageIds();
    conditions.push(wonStageIds.length > 0 ? inArray(deals.stageId, wonStageIds) : sql`false`);
    conditions.push(aliasedHasUsableWonDateSql("deals"));
    conditions.push(aliasedActiveDealCountFilterSql("deals"));
    if (filters.wonClosedFrom) {
      conditions.push(sql`${aliasedWonHsClosedWonDateSql("deals")} >= ${filters.wonClosedFrom}::date`);
    }
    if (filters.wonClosedTo) {
      conditions.push(sql`${aliasedWonHsClosedWonDateSql("deals")} <= ${filters.wonClosedTo}::date`);
    }
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

  // Substring search across the deal's text fields plus its company (account),
  // primary contact (customer), and owner (assigned rep). Single source of truth:
  // search/unified-search.buildDealSearchCondition (see .audit/unified-search-design.md).
  // Scope/pagination/office visibility below are unchanged — this only widens which
  // FIELDS a term matches, not which deals the caller may see.
  if (filters.search && filters.search.trim().length >= 2) {
    conditions.push(buildDealSearchCondition(filters.search));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const activeCountWhere = where
    ? and(where, sql`coalesce(${deals.onHold}, false) = false`)
    : sql`coalesce(${deals.onHold}, false) = false`;

  // Sort
  const sortOrder = buildDealListOrder(filters, { wonStageIds, lostStageIds, stageEntryDateEnabled });

  // Sequential tenant queries required: tenantDb is a single transaction client
  // in production, so parallel reads can fail with "client already executing".
  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(deals).where(where);
  const activeCountResult = await tenantDb
    .select({ count: sql<number>`count(*)` })
    .from(deals)
    .where(activeCountWhere);
  // Running-total card (#4): the summed effective value of the ENTIRE filtered set (all pages,
  // not just the visible one), over the SAME `where` as the count(*) total — so the total can
  // never disagree with the list. Uses the stage-aware effective value (awarded-first for Won
  // stage ids, best-estimate otherwise) — the IDENTICAL expression the value sort/filter and the
  // client's per-row getEffectiveDealValue DISPLAY use, so sort == filter == display == total
  // (D-1; Codex #546). on_hold rows are summed as 0 (the expression zeroes them, matching the
  // list's $0 display), test data is already excluded by `where`, and $0 deals contribute 0.
  // Opt-in (includeValueTotal): runs ONLY for the surfaces that show the card; wonStageIds is
  // resolved above whenever the total is requested, so the SUM is always awarded-first for Won.
  const valueTotalResult = filters.includeValueTotal
    ? await tenantDb
        .select({
          total: sql<number>`coalesce(sum(${aliasedStageAwareEffectiveDealValueSql("deals", wonStageIds)}), 0)`,
        })
        .from(deals)
        .where(where)
    : null;
  const dealRows = await tenantDb
    .select({
      ...getTableColumns(deals),
      companyName: companies.name,
      stageSlug: pipelineStageConfig.slug,
      // Outcome-aware display date (filter-axis == display-axis): when an
      // outcome dimension is in play we've already resolved the Won/Lost stage
      // sets (needsStageClassification above), so each row's displayed date is
      // the SAME axis the date filter windows on — Won -> won_closed_date,
      // Lost -> lost_at, open -> stage_entered_at — built from the IDENTICAL
      // classification, so the displayed and filtered axes cannot diverge.
      // When no outcome dimension is set the ids are empty, so we emit NULL
      // rather than a misclassifying CASE (every row would resolve to the open
      // axis); the client (#554 getDealDisplayDate) then falls back to its
      // close-date chain. This also keeps a plain list free of the extra
      // listDealStages() resolution cost.
      displayDate: needsStageClassification
        ? dealDisplayDateExpr({
            wonStageIds,
            lostStageIds,
            stageEntryDateEnabled,
            columns: dealDateScopeColumns(),
          })
        : sql<string | null>`NULL`,
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
  const valueTotal = valueTotalResult ? Number(valueTotalResult[0]?.total ?? 0) : undefined;

  return {
    deals: dealRows.map((deal) => attachAtRiskResult(deal, atRiskViewerRole)),
    pagination: {
      page,
      limit,
      total,
      activeCount,
      totalPages: Math.ceil(total / limit),
      // The summed effective value of the full filtered set (#4) — surfaced on pagination
      // alongside the other set-wide aggregates (total / activeCount). Only present when the
      // caller opted in via includeValueTotal.
      ...(valueTotal !== undefined ? { valueTotal } : {}),
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
  atRiskViewerRole: string = userRole,
  // Soft-deleted deals (is_active=false is the canonical delete marker) are hidden by default.
  // getDealById is the de-facto access gate for the detail page, the edit (PATCH) baseline, and the
  // per-deal action routes — so a deleted deal must 404 there (otherwise a soft-deleted Won deal
  // stays openable AND editable, the data-integrity hole this guards). Opt in only for a future
  // restore/admin view; no production caller passes true today.
  includeInactive: boolean = false
) {
  // estimatorUserId already comes through getTableColumns(deals); join users to surface the estimator's
  // display name for the PR3 estimator picker (mirrors the assignedRep name join in getDealDetail).
  const result = await tenantDb
    .select({
      ...getTableColumns(deals),
      stageSlug: pipelineStageConfig.slug,
      estimatorUserName: users.displayName,
    })
    .from(deals)
    .leftJoin(pipelineStageConfig, eq(pipelineStageConfig.id, deals.stageId))
    .leftJoin(users, eq(users.id, deals.estimatorUserId))
    .where(includeInactive ? eq(deals.id, dealId) : and(eq(deals.id, dealId), eq(deals.isActive, true)))
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

  // Second users alias so the estimator name can be joined alongside the assigned-rep name.
  const estimatorUser = alias(users, "estimator_user");
  const [detailDeal] = await tenantDb
    .select({
      ...getTableColumns(deals),
      assignedRepName: users.displayName,
      estimatorUserName: estimatorUser.displayName,
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
    .leftJoin(estimatorUser, eq(estimatorUser.id, deals.estimatorUserId))
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

  // CRM-native change orders (the dedicated deal_change_orders table) — distinct from the
  // Procore-synced `changeOrders` above. Their sum adds to the displayed Current Contract Value.
  const dealChangeOrderRows = await listDealChangeOrders(tenantDb, dealId);
  const dealChangeOrderTotal = await sumDealChangeOrders(tenantDb, dealId);

  return {
    ...dealWithMetadata,
    atRisk: attachAtRiskResult(dealWithMetadata, atRiskViewerRole, currentStage?.slug ?? null).atRisk,
    postConversionEnrichment: evaluatePostConversionEnrichment(dealWithMetadata as any, currentStage ?? { isTerminal: true }),
    bidBoardOwnership: buildBidBoardOwnershipState(dealWithMetadata),
    stageHistory,
    approvals,
    changeOrders: cos,
    dealChangeOrders: dealChangeOrderRows,
    dealChangeOrderTotal,
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

  // Only admins and directors may set the awarded amount — keep reps from hand-entering a Won value at
  // creation (the seed-on-win path is system-initiated and never flows through this user input). No prior
  // value exists on create, so any non-blank awarded amount requires the elevated role.
  const setsAwarded =
    input.awardedAmount != null && String(input.awardedAmount).trim() !== "";
  if (setsAwarded && !(input.actorRole === "admin" || input.actorRole === "director")) {
    throw new AppError(
      403,
      "Only admins and directors can set the awarded amount",
      "AWARDED_AMOUNT_RESTRICTED"
    );
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
      // A non-blank awarded set at creation by an admin/director (reps are rejected by the guard above)
      // is a manual override — protects it if this deal is later bid-board-matched and synced.
      awardedAmountOverridden: setsAwarded,
      // deals.bid_due_date is timestamptz, but the business field is date-only.
      // Persist UTC midnight so every environment resolves the same calendar day.
      bidDueDate: normalizedBidDueDate,
      description: input.description ?? null,
      propertyAddress: input.propertyAddress ?? null,
      propertyCity: input.propertyCity ?? null,
      propertyState: input.propertyState ?? null,
      propertyZip: input.propertyZip ?? null,
      officeCode,
      projectNumber: input.projectNumber ?? null,
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

  // A change-order child deal is managed only through the change-order endpoints. Block the report-affecting
  // mutations here — its awarded amount (which also drives commission, recomputed only on the CO endpoint),
  // its hold state (on-hold zeroes a deal's effective Won value), and its rep (reassignment would move Won
  // credit but leave the commission under the original rep) — so a CO can never be edited out of its
  // Won-total membership or its commission attribution via the normal deal-update path. A CO's rep is
  // inherited from the parent at creation and is not reassignable here. Other fields stay editable.
  if (existing.isChangeOrder === true) {
    const touchesAmount =
      input.awardedAmount !== undefined &&
      String(input.awardedAmount ?? "") !== String(existing.awardedAmount ?? "");
    const touchesHold =
      input.onHold !== undefined && Boolean(input.onHold) !== Boolean(existing.onHold);
    const touchesRep =
      input.assignedRepId !== undefined && input.assignedRepId !== existing.assignedRepId;
    // Lock the workflow route too: a CO child inherits the parent's route, and changing it would move the CO
    // between service/normal buckets that filters + reports key on (buildWorkflowRouteCondition / pipeline
    // type) without going through the change-order endpoint.
    const touchesRoute =
      input.workflowRoute !== undefined && input.workflowRoute !== existing.workflowRoute;
    // Lock the inherited reporting dimensions too (project type + region): reports group/filter directly on
    // d.project_type_id / d.region_id, so editing them here would move ONLY the CO's revenue into a different
    // bucket, breaking the parent-inherited classification without going through the change-order workflow.
    const touchesProjectType =
      (input.projectType !== undefined && input.projectType !== existing.projectType) ||
      (input.projectTypeId !== undefined && input.projectTypeId !== existing.projectTypeId);
    const touchesRegion =
      input.regionId !== undefined && input.regionId !== existing.regionId;
    if (touchesAmount || touchesHold || touchesRep || touchesRoute || touchesProjectType || touchesRegion) {
      throw new AppError(
        409,
        "A change order's amount, hold state, rep, workflow route, project type, and region are managed through the change-order endpoints, not the normal deal edit.",
        "CHANGE_ORDER_FIELD_LOCKED"
      );
    }
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
  // Only admins and directors may edit the awarded amount. Change-detecting so a rep re-submitting the
  // deal form with awarded_amount UNCHANGED (the partial-save flow) is not falsely blocked — only an
  // actual change is gated. The system seed-on-win path does not flow through input.awardedAmount.
  const touchesAwarded =
    input.awardedAmount !== undefined &&
    normalizeMoneyForCompare(input.awardedAmount) !== normalizeMoneyForCompare(existing.awardedAmount);
  if (touchesAwarded) {
    const isDirectorOrAdmin = userRole === "admin" || userRole === "director";
    if (!isDirectorOrAdmin) {
      throw new AppError(
        403,
        "Only admins and directors can edit the awarded amount",
        "AWARDED_AMOUNT_RESTRICTED"
      );
    }
  }
  if (input.awardedAmount !== undefined) updates.awardedAmount = input.awardedAmount;
  // A genuine admin/director change to awarded_amount is a permanent manual override: mark it so the
  // Procore mirror never overwrites it. Gated on touchesAwarded (the change-detected edit) — a no-op
  // re-save of the same value does NOT freeze sync, and the automatic seed never reaches this path.
  if (touchesAwarded) updates.awardedAmountOverridden = true;
  if (input.description !== undefined) updates.description = input.description;
  if (input.propertyAddress !== undefined) updates.propertyAddress = input.propertyAddress;
  if (input.propertyCity !== undefined) updates.propertyCity = input.propertyCity;
  if (input.propertyState !== undefined) updates.propertyState = input.propertyState;
  if (input.propertyZip !== undefined) updates.propertyZip = input.propertyZip;
  if (input.projectNumber !== undefined) updates.projectNumber = input.projectNumber;
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
      "projectNumber",
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
export async function deleteDeal(tenantDb: TenantDb, dealId: string, userRole: string, userId?: string | null) {
  if (userRole !== "admin") {
    throw new AppError(403, "Only admins can delete deals");
  }

  // Lock the deal row FOR UPDATE so a concurrent change-order create on this parent serializes against the
  // delete (loadParentForChildCreate takes the same lock) — otherwise a CO create could insert an active
  // Won child AFTER this delete's cascade runs but before the child exists, orphaning it under a deleted parent.
  const [existing] = await tenantDb.select().from(deals).where(eq(deals.id, dealId)).limit(1).for("update");
  if (!existing) {
    throw new AppError(404, "Deal not found");
  }

  if (!existing.isActive) {
    return null;
  }

  // If the deleted deal is itself a CO child, apply the same on_hold TOMBSTONE the change-order delete path
  // uses: several Won rollups filter on_hold but not is_active, so without it a CO child voided via this
  // deep-linked deal route would keep inflating Won value/count. (is_active=false stays the canonical marker.)
  const softDeleteValues: { isActive: boolean; onHold?: boolean } = { isActive: false };
  if (existing.isChangeOrder === true) {
    softDeleteValues.onHold = true;
  }

  const result = await tenantDb
    .update(deals)
    .set(softDeleteValues)
    .where(eq(deals.id, dealId))
    .returning();

  if (result.length === 0) {
    throw new AppError(404, "Deal not found");
  }

  // Cascade the soft-delete to this deal's change-order children: they are real Won child deals, so leaving
  // them active after the parent is voided would orphan their value in Won reports. The DB self-FK ON DELETE
  // CASCADE only fires on a hard row delete, not this is_active=false soft-delete, so cascade it explicitly.
  const childCoIds = await softDeleteChangeOrderChildren(tenantDb, dealId, userId ?? null);

  // Auto-dismiss pending/in-progress tasks for the deal AND its now-voided CO children.
  await tenantDb
    .update(tasks)
    .set({ status: "dismissed", isOverdue: false })
    .where(
      and(
        inArray(tasks.dealId, [dealId, ...childCoIds]),
        inArray(tasks.status, ["pending", "in_progress"]),
      )
    );

  // Cascade the soft-delete to this deal's (and ALL its CO children's) Procore project mirror rows.
  // projects.source_deal_id references deals(id), but the FK's ON DELETE action only fires on a hard
  // row delete — not this is_active=false soft-delete — so an active project row would otherwise
  // dangle pointing at a deleted deal and keep re-surfacing it on project/bid-board-keyed lists.
  // Collect ALL CO child ids (not just the ones voided in THIS call): a child soft-deleted in a prior
  // CO-delete still has an active project mirror that softDeleteChangeOrderChildren (active-only)
  // wouldn't return in childCoIds, so cascade over every child to deactivate those too.
  const allCoChildIds = (
    await tenantDb
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.parentDealId, dealId), eq(deals.isChangeOrder, true)))
  ).map((row) => row.id);
  await tenantDb
    .update(projects)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        inArray(projects.sourceDealId, [dealId, ...allCoChildIds]),
        eq(projects.isActive, true),
      )
    );

  // If the deleted deal is ITSELF a change-order child (deletable via this route now that COs are real,
  // deep-linkable deals), remove its own commission — the cascade above only covers descendants, and
  // earned-commission report queries don't all filter is_active, so a voided CO's commission would linger.
  if (existing.isChangeOrder === true) {
    await removeCommissionForDeal(tenantDb, dealId, userId ?? null);
  }

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
  // D-11: gates whether a board-wide dashboard period also bounds the OPEN columns
  // on the entered-current-stage axis (see the open ELSE branch below). OFF in prod
  // until stage_entered_at is trusted everywhere (post-#535); OFF => open columns
  // stay current-state and the drill-down labels them "(now)" honestly.
  const stageEntryDateEnabled = isStageEntryDateFilterEnabled();
  // The won-date guard below reads the app-owned deals.won_closed_date column via
  // aliasedWonHsClosedWonDateSql (a compact IS NOT NULL / >= / <= predicate per
  // site), NOT a try_parse_hs_close_date call. Each site still builds its own
  // fragment via the helper (cheap; no shared mutable state).
  const pipelineCardsPerStageLimit = Math.max(
    1,
    Math.min(
      Number.isFinite(filters?.previewLimit) ? Math.floor(filters!.previewLimit as number) : DEFAULT_PIPELINE_CARDS_PER_STAGE_LIMIT,
      MAX_PIPELINE_CARDS_PER_STAGE_LIMIT
    )
  );

  const commonConditions: any[] = [];
  const mineVisibility =
    filters?.scope === "mine" || filters?.scope === "watched"
      ? await resolveMineVisibilityFeatures(tenantDb)
      : null;
  let assignedRepFilterHandled = false;

  if (filters?.scope === "mine") {
    commonConditions.push(
      buildDealMineVisibilityCondition(userId, {
        includeSubscriptions: mineVisibility?.dealSubscriptions,
        includeCreatedBy: mineVisibility?.dealsCreatedByUserId,
        includeSubscriptionDeletedAt: mineVisibility?.dealSubscriptionsDeletedAt,
      })
    );
  } else if (filters?.scope === "watched") {
    // Watched = the deal_subscriptions relation in isolation; capability-gate to empty when absent.
    // Do NOT set assignedRepFilterHandled (mirrors Mine) so a per-stage assignedRep narrowing applies.
    commonConditions.push(
      mineVisibility?.dealSubscriptions
        ? buildDealWatchedCondition(userId, {
            includeSubscriptionDeletedAt: mineVisibility?.dealSubscriptionsDeletedAt,
          })
        : sql`false`
    );
  } else if (filters?.scope === "team") {
    const teamRepIds = await resolveTeamRepIds(tenantDb, userId, filters.activeOfficeId ?? null);
    if (filters?.assignedRepId) {
      // Team scope, filtered to one person: bound by team membership (assigned_rep IN teamRepIds)
      // AND match rep-OR-estimator, so the estimator clause can't surface deals assigned OUTSIDE
      // the team — the same bounded pattern the deals list and stage drill-down use.
      commonConditions.push(
        teamRepIds.length > 0
          ? and(inArray(deals.assignedRepId, teamRepIds), buildInvolvedRepCondition(filters.assignedRepId))!
          : sql`false`
      );
      assignedRepFilterHandled = true;
    } else {
      commonConditions.push(teamRepIds.length > 0 ? inArray(deals.assignedRepId, teamRepIds) : sql`false`);
    }
  }
  if (filters?.assignedRepId && !assignedRepFilterHandled) {
    commonConditions.push(buildInvolvedRepCondition(filters.assignedRepId));
  }

  // Office scope: mirror getDeals so the kanban board and the drill-down list
  // resolve the same set of deals for a multi-office viewer.
  if (filters?.activeOfficeId) {
    const officeScope = await resolveActiveOfficeScope(tenantDb, filters.activeOfficeId);
    commonConditions.push(buildDealOfficeScopeCondition("deals", officeScope));
  }

  commonConditions.push(excludeTestDataCondition("deals"));

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
    const isWonTerminalStage = WON_TERMINAL_STAGE_SLUGS.includes(
      stage.slug as (typeof WON_TERMINAL_STAGE_SLUGS)[number]
    );
    const isLostTerminalStage = LOST_TERMINAL_STAGE_SLUGS.includes(
      stage.slug as (typeof LOST_TERMINAL_STAGE_SLUGS)[number]
    );
    const isEstimateSentStage = ESTIMATE_SENT_STAGE_SLUGS.includes(
      stage.slug as (typeof ESTIMATE_SENT_STAGE_SLUGS)[number]
    );
    if (isWonTerminalStage) {
      stageConditions.push(canonicalWonStageId ? inArray(deals.stageId, wonStageIds) : eq(deals.stageId, stage.id));
      // §6.3: exclude on-hold deals entirely from the Won column — count, value,
      // AND the returned cards. (The summary value/activeCount already filter
      // on-hold via FILTER; adding it to the WHERE also drops on-hold from
      // totalCount and the card list, so on-hold is excluded everywhere.)
      stageConditions.push(aliasedActiveDealCountFilterSql("deals"));
      // Also require is_active=true so a soft-deleted (is_active=false) Won deal is NOT shown on the
      // Won card. The on_hold reportable filter above does not catch a plain (non-CO) soft-deleted Won
      // deal — deleteDeal sets only is_active=false on it, never on_hold — so this explicit guard is
      // needed. LIVE Won deals (is_active=true) stay counted/visible (the field #695 Won-browse set).
      // (The §6.7 "terminal Won deals are legitimately inactive and stay counted" note predated the
      // soft-delete-hides-Won requirement; the only is_active=false Won deals are soft-deleted ones,
      // so this changes no legitimate Won count.)
      stageConditions.push(eq(deals.isActive, true));
      // §6.1: when a period window is requested, require a usable won_closed_date
      // (this is what aliasedDealWonWindowEligibilitySql now returns — a
      // deals.won_closed_date IS NOT NULL guard). All-time (no window) omits the
      // guard, so null-date Won deals remain in the all-time total.
      if (wonSignedDateSince || wonSignedDateUntil || wonPeriodFrom || wonPeriodTo) {
        stageConditions.push(aliasedDealWonWindowEligibilitySql("deals"));
      }
      if (wonSignedDateSince) {
        stageConditions.push(sql`${aliasedWonHsClosedWonDateSql("deals")} >= ${wonSignedDateSince}::date`);
      }
      if (wonSignedDateUntil) {
        stageConditions.push(sql`${aliasedWonHsClosedWonDateSql("deals")} <= ${wonSignedDateUntil}::date`);
      }
      if (wonPeriodFrom) {
        stageConditions.push(sql`${aliasedWonHsClosedWonDateSql("deals")} >= ${wonPeriodFrom}::date`);
      }
      if (wonPeriodTo) {
        stageConditions.push(sql`${aliasedWonHsClosedWonDateSql("deals")} <= ${wonPeriodTo}::date`);
      }
    } else if (isLostTerminalStage) {
      stageConditions.push(canonicalLostStageId ? inArray(deals.stageId, lostStageIds) : eq(deals.stageId, stage.id));
      if (terminalFilters.lost.since || terminalFilters.lost.until) {
        stageConditions.push(dealLostWindowEligibilitySql());
      }
      if (terminalFilters.lost.since) {
        stageConditions.push(sql`${dealLostWindowDateSql()} >= ${terminalFilters.lost.since}`);
      }
      if (terminalFilters.lost.until) {
        stageConditions.push(sql`${dealLostWindowDateSql()} < ${addUtcDays(terminalFilters.lost.until, 1)}`);
      }
    } else {
      stageConditions.push(eq(deals.isActive, true), eq(deals.stageId, stage.id));
      stageConditions.push(nonTerminalMirroredStageCondition());
      // D-11 / canonical date model (§6 Phase 4): a board-wide dashboard period
      // (won_period_from/to) must window the OPEN columns on the entered-current-
      // stage axis, not be a no-op ("Open-stage deals for MTD" showing every open
      // deal). Flag-gated on stageEntryDateEnabled (reliable stage_entered_at);
      // when OFF the open columns stay current-state (byte-identical SQL). Mirrors
      // deal-date-scope's open axis + window convention (>= from::date,
      // < to::date + 1 day, via the shared buildStageEntryDateWindow). The main
      // kanban sends no period (won_all_time) so this only affects the dashboard
      // drill-down. Won/Lost columns are unaffected.
      if (stageEntryDateEnabled) {
        const openWindow = buildStageEntryDateWindow(
          { from: wonPeriodFrom ?? undefined, to: wonPeriodTo ?? undefined },
          aliasedDealDateScopeColumns("deals")
        );
        if (openWindow) stageConditions.push(openWindow);
      }
    }
    if (isEstimateSentStage) {
      // Estimate Sent has its own column date window. Keep that filter local to
      // the Estimate Sent column so selecting it cannot shrink Won/Lost totals.
      addEstimateSentDateConditions(stageConditions, filters ?? {});
    }

    const where = and(...stageConditions, ...commonConditions);
    const countedDealFilter = aliasedActiveDealCountFilterSql("deals");
    const valueSource = pipelineValueSourceForStageSlug(stage.slug);
    const summaryRows = await tenantDb
      .select({
        totalCount: sql<number>`count(*)`,
        activeCount: sql<number>`count(*) filter (where ${countedDealFilter})`,
        totalValue: sql<number>`COALESCE(SUM(${dealPipelineValueSql(valueSource)}) FILTER (WHERE ${countedDealFilter}), 0)`,
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
      .orderBy(...buildPipelineStageCardsOrder(valueSource))
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
  const isWonTerminalStage = WON_TERMINAL_STAGE_SLUGS.includes(
    stage.slug as (typeof WON_TERMINAL_STAGE_SLUGS)[number]
  );
  const stageSlugs = isWonTerminalStage
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
    excludeTestDataCondition("d"),
  ];

  if (isWonTerminalStage) {
    // Match the Won board/card row set: on-hold Won deals are excluded from
    // Won reporting entirely, including the stage-page rows and pagination.
    conditions.push(aliasedActiveDealCountFilterSql("d"));
  }

  // Search must match the LIST exactly: reuse the unified buildDealSearchCondition (name/number/project/
  // address/city/state/company/contact/owner) with the same >=2-char guard getDeals applies — not the
  // legacy name/number-only ILIKE — so the header total reconciles with the searched list (Codex P2).
  // `alias(deals, "d")` renders the predicate against this query's `from deals d`.
  if (input.search && input.search.trim().length >= 2) {
    // alias(deals, "d") is column-compatible with `deals` at runtime; Drizzle's aliased-table wrapper type
    // doesn't structurally overlap, so go through `unknown` (the only column access is the shared columns).
    conditions.push(buildDealSearchCondition(input.search, alias(deals, "d") as unknown as typeof deals));
  }
  if (input.assignedRepId) {
    // The Unassigned FilterBar option sends the sentinel; map it to IS NULL like the list (getDeals /
    // buildAssignedRepPredicate), not a literal equality that would error on the UUID column (Codex P2).
    conditions.push(buildAliasedInvolvedRepSql("d", input.assignedRepId));
  }
  if (input.regionId) {
    conditions.push(
      input.regionId === UNASSIGNED_FILTER_SENTINEL
        ? sql`d.region_id is null`
        : sql`d.region_id = ${input.regionId}`
    );
  }
  if (input.source) {
    conditions.push(sql`d.source = ${input.source}`);
  }
  if (input.workflowRoute === "normal" || input.workflowRoute === "service") {
    conditions.push(sql`d.workflow_route = ${input.workflowRoute}`);
  }
  // Status (lifecycle) — mirror buildStatusPredicate so the summary narrows the SAME way the list does
  // (is_active + on_hold are orthogonal; on_hold is a subset of active). GREEN #616 follow-up.
  if (input.status === "active") {
    conditions.push(sql`d.is_active = true and coalesce(d.on_hold, false) = false`);
  } else if (input.status === "on_hold") {
    conditions.push(sql`d.is_active = true and coalesce(d.on_hold, false) = true`);
  } else if (input.status === "inactive") {
    conditions.push(sql`d.is_active = false`);
  } else if (input.status && input.status !== "any") {
    conditions.push(sql`false`); // unrecognized status → no-match, mirroring buildStatusPredicate
  }
  if (input.projectTypeId) {
    conditions.push(sql`d.project_type_id = ${input.projectTypeId}`);
  }
  // A present-but-malformed numeric bound (e.g. a hand-crafted/duplicated ?valueMin=abc, arriving as NaN)
  // no-matches like the list (buildValueRangePredicate / buildStalledPredicate → sql`false`) rather than
  // being silently dropped — so the header total can't stay unfiltered while the list is empty (Codex P2).
  const presentButMalformed = (v: number | undefined) => v !== undefined && !Number.isFinite(v);
  // Value range — BETWEEN on the stage-aware effective value (awarded-first for Won stages, best-estimate
  // otherwise): the SAME number the list filters/sorts/displays by (buildValueRangePredicate), so the
  // top "Stage Value" total reconciles with the value-filtered list.
  if (presentButMalformed(input.valueMin) || presentButMalformed(input.valueMax)) {
    conditions.push(sql`false`);
  } else if (input.valueMin !== undefined || input.valueMax !== undefined) {
    const valueExpr = aliasedStageAwareEffectiveDealValueSql("d", isWonTerminalStage ? stageIds : []);
    if (input.valueMin !== undefined && input.valueMax !== undefined) {
      conditions.push(sql`${valueExpr} between ${input.valueMin} and ${input.valueMax}`);
    } else if (input.valueMin !== undefined) {
      conditions.push(sql`${valueExpr} >= ${input.valueMin}`);
    } else {
      conditions.push(sql`${valueExpr} <= ${input.valueMax}`);
    }
  }
  if (input.staleOnly) {
    conditions.push(
      sql`(d.last_activity_at is null or d.last_activity_at < now() - interval '14 days')`
    );
  }
  if (input.updatedFrom) {
    conditions.push(sql`d.updated_at::date >= ${input.updatedFrom}::date`);
  }
  if (input.updatedTo) {
    conditions.push(sql`d.updated_at::date <= ${input.updatedTo}::date`);
  }
  addWorkspaceEstimateSentDateConditions(conditions, input);
  // Stalled / days-in-stage — measured on the HOLD-AWARE effective stage age (the SAME measure the list
  // filters by, aliasedEffectiveStageAgeDaysSql), not raw wall-clock, so an on-hold deal is in/out of the
  // summary the same way as the list. NOT gated on the global ENABLE_STAGE_ENTRY_DATE_FILTER flag: the
  // stage page's list always enables stalled (DealsListSection sends stageEntryDateWindow=true, and getDeals
  // treats that as flag-OR-window), so the summary must apply it whenever a bound is present to reconcile
  // even when the global flag is off (Codex P2).
  if (presentButMalformed(input.minAgeDays) || presentButMalformed(input.maxAgeDays)) {
    conditions.push(sql`false`);
  } else if (input.minAgeDays !== undefined || input.maxAgeDays !== undefined) {
    const stageAgeDays = aliasedEffectiveStageAgeDaysSql("d");
    if (input.minAgeDays !== undefined) {
      conditions.push(sql`${stageAgeDays} >= ${input.minAgeDays}`);
    }
    if (input.maxAgeDays !== undefined) {
      conditions.push(sql`${stageAgeDays} <= ${input.maxAgeDays}`);
    }
  }

  const where = sql.join(conditions, sql` and `);

  // active_count requires is_active ONLY on the explicit inactive-status path (so status=inactive doesn't
  // render inactive deals as "active"). For terminal Won/Lost pages WITHOUT a status, the inactive terminal
  // deals ARE the reportable population the board/list counts (non-on-hold), so don't is_active-gate them
  // there (Codex P2: keep terminal reportable rows in the active count).
  const activeCountFilter =
    input.status === "inactive"
      ? sql`d.is_active and coalesce(d.on_hold, false) = false`
      : sql`coalesce(d.on_hold, false) = false`;

  const countResult = await tenantDb.execute(sql`
    select
      count(*)::int as total_count,
      count(*) filter (where ${activeCountFilter})::int as active_count,
      coalesce(sum(${workspaceEffectiveDealValueSql(stage)}), 0)::numeric as total_value,
      round(coalesce(
        avg(extract(day from now() - d.stage_entered_at)) filter (where coalesce(d.on_hold, false) = false),
        avg(extract(day from now() - d.stage_entered_at))
      ))::int as average_days_in_stage
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
      d.is_change_order,
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
 * The deal's stage-entry date as YYYY-MM-DD (UTC) — matching the won_closed_date date-only
 * convention used by changeDealStage and the Bid-Board mirror. This is the stage-driven won
 * date that stands when a Won-family deal's contract-signed date is cleared (revert basis).
 */
function stageEnteredAtDateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().split("T")[0] ?? null;
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
    // Lock the deal row FOR UPDATE (same as changeDealStage) so a concurrent stage change can't
    // race between the Won-family classification below and the won_closed_date write/omit — the
    // stored Won date must match the deal's FINAL stage.
    const [existing] = await tx
      .select()
      .from(deals)
      .where(eq(deals.id, dealId))
      .limit(1)
      .for("update");
    if (!existing) return null;

    // A change order's signed/won date is managed only via the change-order endpoint (updateDealChangeOrder,
    // which also recomputes commission). Editing it here would move won_closed_date/attribution WITHOUT the
    // commission recompute and could enqueue the contract-signed Procore handoff for a CRM-only child.
    if (existing.isChangeOrder === true) {
      throw new AppError(
        409,
        "A change order's signed date is managed through the change-order endpoints, not the contract-signed-date path.",
        "CHANGE_ORDER_FIELD_LOCKED"
      );
    }

    const oldValue = existing.contractSignedDate ?? null;
    const newValue = contractSignedDate ?? null;
    const oldContractSignedAt = normalizeContractSignedAt(existing.contractSignedAt);
    const newContractSignedAt = contractSignedAtFromDate(newValue);

    // UNGATED: the contract-signed date is editable at ANY stage (accounting's correction lever;
    // previously this threw CONTRACT_SIGNED_STAGE_REQUIRED unless slug === "contract"). Resolve the
    // current (locked) stage once — its slug decides the Won-family WRITE-THROUGH below and whether
    // to suppress the Procore handoff (already-Won deals already have a project).
    const currentStage = await getStageByIdForWorkflowRoute(
      existing.stageId,
      existing.workflowRoute ?? "normal"
    );
    const contractStageId: string | null = currentStage?.id ?? null;
    const isWonFamilyDeal = isGenuineWonDealStageSlug(
      currentStage?.slug,
      existing.workflowRoute ?? "normal"
    );

    // WRITE-THROUGH (Won-family only, always-when-present): the authoritative stored Won date —
    // contract-signed wins when present; when cleared, the stage-driven won date
    // (stage_entered_at::date) stands. A non-Won deal's won_closed_date is NEVER written (no
    // promotion; membership stays gated by stage). Every Won read surface inherits this via the
    // stored deals.won_closed_date column — no read-path change.
    const oldWonClosedDate = existing.wonClosedDate ?? null;
    const newWonClosedDate = isWonFamilyDeal
      ? resolveWonClosedDateWriteThrough({
          contractSignedDate: newValue,
          stageDrivenWonDate: stageEnteredAtDateOnly(existing.stageEnteredAt),
        })
      : oldWonClosedDate;
    const wonClosedDateChanged = isWonFamilyDeal && newWonClosedDate !== oldWonClosedDate;

    // A same-value re-save normally short-circuits as a no-op — but if the contract date is PRESENT
    // and the stored Won date is stale relative to it (e.g. a pre-write-through Won-entry stamp),
    // the stored basis must still be reconciled. Scoped to a PRESENT contract date only: when it is
    // absent there is no authoritative source, so we must NOT recompute from stage_entered_at on a
    // no-op (that would overwrite the real Won-entry/backfill stamp).
    const reconcileStaleWonDate = isWonFamilyDeal && newValue != null && wonClosedDateChanged;

    if (
      oldValue === newValue &&
      (oldValue !== null || timestampKey(oldContractSignedAt) === timestampKey(newContractSignedAt)) &&
      !reconcileStaleWonDate
    ) {
      return existing;
    }

    const isInitialContractSignedAt =
      oldValue == null && oldContractSignedAt == null && newContractSignedAt != null;

    const now = new Date();
    const [updated] = await tx
      .update(deals)
      .set({
        contractSignedDate: newValue,
        contractSignedAt: newContractSignedAt,
        updatedAt: now,
        ...(isWonFamilyDeal ? { wonClosedDate: newWonClosedDate } : {}),
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
      // When the write-through moves the canonical Won close date, record it so the accounting
      // re-bucketing of a closed deal is traceable in the audit trail.
      ...(wonClosedDateChanged
        ? { wonClosedDate: { from: oldWonClosedDate, to: newWonClosedDate } }
        : {}),
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

    // Commission re-fires on every contract-date TRANSITION (recalc-on-edit), all inside this
    // transaction so the stored commission can never disagree with the stored signed date:
    //   null → date   : initial sign → calculate
    //   date → date'  : correction   → recalculate (remove the stale row, recompute from the deal's
    //                                  CURRENT source value/rate, re-stamp contract_signed_date_at_signing)
    //   date → null   : clear        → remove (no signed date ⇒ no commission; a lingering row is a
    //                                  PHANTOM payout — worse than a missing one)
    // The transition is keyed on the EFFECTIVE signed date — contract_signed_at::date FIRST, then
    // contract_signed_date (canonical precedence, below). The reseed/import path can populate
    // contract_signed_at WITHOUT contract_signed_date, and the app treats _at as the canonical signed-date
    // source; keying off contract_signed_date alone would (a) miss the clear on an _at-only row (commission
    // left orphaned) and (b) misroute a correction on an _at-only row as an initial calc that skips the row.
    // A same-value re-save already short-circuited above UNLESS it reached here only to reconcile a stale
    // won_closed_date (same effective date) — then the date is unchanged, so commission must NOT be churned.
    // CANONICAL precedence: contract_signed_at::date FIRST, then contract_signed_date — matching this
    // service's read/reporting paths (contractSignedDateForReporting = COALESCE(contract_signed_at::date,
    // contract_signed_date)). So on a row where the two diverge, normalizing contract_signed_date to the
    // existing _at value leaves the canonical effective date unchanged and does NOT churn the commission.
    const oldEffectiveSignedDate = dateStringFromTimestamp(oldContractSignedAt) ?? oldValue;
    const newEffectiveSignedDate = dateStringFromTimestamp(newContractSignedAt) ?? newValue;
    if (oldEffectiveSignedDate !== newEffectiveSignedDate) {
      if (oldEffectiveSignedDate == null) {
        // null → signed: initial commission calc.
        await calculateCommissionForDeal(tx, {
          dealId,
          contractSignedDate: newEffectiveSignedDate as string,
          triggeredByUserId: userId,
        });
      } else if (newEffectiveSignedDate == null) {
        // signed → cleared: remove the row (no signed date ⇒ no commission; a lingering row is a phantom payout).
        await removeCommissionForDeal(tx, dealId, userId);
      } else {
        // corrected: recompute IN PLACE — attribution-preserving + all-or-nothing (never deletes to $0).
        await recalculateCommissionForDeal(tx, {
          dealId,
          contractSignedDate: newEffectiveSignedDate,
          triggeredByUserId: userId,
        });
      }
    } else if (newEffectiveSignedDate != null && oldValue == null && newValue != null) {
      // The effective date is UNCHANGED, but the contract_signed_date COLUMN was just normalized from null
      // to its existing contract_signed_at value (an imported/reseeded _at-only row). Such a deal may have
      // been signed but never calculated (no commission row), and the pre-effective-date logic created it
      // on this null→date column transition — preserve that: ensure the commission exists.
      // calculateCommissionForDeal is idempotent (skips when a row already exists), so a never-calculated
      // import deal finally gets its commission while an already-paid one is untouched.
      await calculateCommissionForDeal(tx, {
        dealId,
        contractSignedDate: newEffectiveSignedDate,
        triggeredByUserId: userId,
      });
    }

    // The Procore create-project handoff fires on an initial sign, but is suppressed when the deal
    // ALREADY has a Procore project (procoreProjectId): ungating lets accounting set/correct the
    // contract-signed date on an already-in-production deal, which would otherwise re-enqueue a
    // create_project job. Gating on the actual project link (not the Won stage) means a Won deal
    // that has NO project yet still gets its only project-creation trigger — the create_project job
    // is itself idempotent on procoreProjectId, so this is a precise optimization, not the backstop.
    if (
      isInitialContractSignedAt &&
      isContractSignedHandoffEnabled() &&
      existing.procoreProjectId == null
    ) {
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

/**
 * Set (or clear) a deal's estimator and re-attribute the ADDITIVE estimator commission in the same
 * transaction. The estimator earns an EXTRA deal_signed_commissions row at the estimator's OWN rate, on
 * top of the owner's full cut — so this only ever adds/removes the estimator's row, NEVER the owner's.
 *
 * Transitions (oldEstimator → newEstimator), all atomic with the deal write:
 *   • unchanged → no-op short-circuit (PRESERVES the existing row even if the rate later vanished)
 *   • null → B  → mint B only
 *   • A → B     → scoped-remove A, mint B (if B is rateless: A removed, nothing minted → net $0)
 *   • B → null  → scoped-remove B only
 *   • estimator == owner → mint is skipped_existing (owner row covers it); a clear is hard-guarded to 0
 *
 * A change order is base-deal-only (its estimator is inherited from the parent) → 409. NEVER calls
 * removeCommissionForDeal (that deletes the owner's row too) — only the (deal_id, estimator) scoped helper.
 *
 * NOTE: this is intentionally NOT wired to a route in this PR (the estimator picker + route land in PR3);
 * it is the tested service spine for that follow-up.
 */
export async function setDealEstimator(
  tenantDb: TenantDb,
  dealId: string,
  newEstimatorUserId: string | null,
  userId: string,
  officeId: string | null = null
): Promise<typeof deals.$inferSelect | null> {
  return tenantDb.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(deals)
      // FINDING 2 (Codex): require is_active=true. Without it, a soft-deleted (is_active=false) deal id
      // supplied directly to PATCH /deals/:id/estimator would let an admin mutate a deal the detail/edit
      // flows hide. Filtering here makes a soft-deleted deal return null so the route 404s BEFORE any
      // estimator change — mirrors getDealById's default-active behavior. The FOR UPDATE lock is kept.
      .where(and(eq(deals.id, dealId), eq(deals.isActive, true)))
      .limit(1)
      .for("update");
    if (!existing) return null;

    // A change order inherits its estimator from the parent deal; editing it here would mint/strip an
    // estimator commission row on a CRM-only child.
    if (existing.isChangeOrder === true) {
      throw new AppError(
        409,
        "A change order's estimator is inherited from the parent deal, not editable here.",
        "CHANGE_ORDER_FIELD_LOCKED"
      );
    }

    const oldEstimator = existing.estimatorUserId ?? null;
    const newEstimator = newEstimatorUserId ?? null;
    const owner = existing.assignedRepId ?? null;

    // No-op short-circuit — the load-bearing PRESERVE: an unchanged estimator's commission row is never
    // re-evaluated, so it stands even if that estimator's rate was later deactivated.
    if (oldEstimator === newEstimator) {
      return existing;
    }

    // P1 — Bid-Board-owned estimator policy, NARROWED to FIRST-FILL only (money-attribution decision).
    // The Bid Board sync OWNS the INITIAL estimator on a BB-owned deal: it stamps estimator_user_id from
    // the Procore/Bid Board mirror. #741 made that sync EMPTIES-ONLY, so it NEVER clobbers a non-null
    // estimator_user_id — which means a human CORRECTION sticks and the dsc row stays consistent (the old
    // desync risk only existed when the sync could overwrite a manual value, which it no longer can).
    // So a blanket lock is now both REDUNDANT (the sync can't revert a non-null correction) and HARMFUL
    // (it would also forbid the human from ever fixing a wrong estimator). Block ONLY the first fill:
    // sync owns the initial value, humans own corrections. We're past the no-op short-circuit here, so
    // oldEstimator === null guarantees this is a null -> non-null first fill (a null -> null no-op already
    // returned above; an existing non-null estimator — a correction or a clear — is allowed through).
    if (existing.isBidBoardOwned === true && oldEstimator === null) {
      throw new AppError(
        409,
        "The first estimator on a Bid Board-owned deal is set by the Bid Board sync; you can correct it once it's set, but not assign the initial value here.",
        "BID_BOARD_OWNED_ESTIMATOR_LOCKED"
      );
    }

    // A NEW estimator must be an active user with access to the ACTIVE SELECTED office (x-office-id, which
    // the route threads in as officeId) — NOT the deal's cosmetic project-number PREFIX and NOT the current
    // owner's office. validateAssignee is the right helper here: it checks the assignee against the active
    // office AND honors `user_office_access` grants (a multi-office user whose PRIMARY users.officeId differs
    // but who holds a grant to the active office is accepted), so a Dallas+Atlanta estimator can be picked on
    // either office's deals. We deliberately do NOT use validateDealReassignmentAssignee: its fallback path
    // compares only the target's primary officeId and would wrongly reject a grant-only estimator — and it's
    // self-contained here, not dependent on which office-validation refactor (#748) is present in the tree.
    if (newEstimator != null) {
      await validateAssignee(tx, newEstimator, officeId ?? undefined);
    }

    const now = new Date();
    const [updated] = await tx
      .update(deals)
      .set({ estimatorUserId: newEstimator, updatedAt: now })
      .where(eq(deals.id, dealId))
      .returning();
    if (!updated) return null;

    await writeAuditLog(tx, {
      tableName: "deals",
      recordId: dealId,
      action: "update",
      changedBy: userId,
      changes: {
        estimatorUserId: { from: oldEstimator, to: newEstimator },
      },
    });

    // A change order's estimator is INHERITED from its parent (it is base-deal-only for commission), so
    // propagate the new estimator to every ACTIVE change-order child in the same transaction. This is
    // MONEY-NEUTRAL: CO children never mint or remove an estimator commission row (only the base deal
    // does) — we only keep the inherited estimator_user_id in sync for display/attribution.
    await tx
      .update(deals)
      .set({ estimatorUserId: newEstimator, updatedAt: now })
      .where(
        and(
          eq(deals.parentDealId, dealId),
          eq(deals.isChangeOrder, true),
          eq(deals.isActive, true)
        )
      );

    // Re-attribute the additive estimator commission on the BASE deal. A departing estimator has their
    // scoped, role-filtered row removed (removeEstimatorCommissionForDeal can NEVER touch the owner row —
    // it deletes only attribution_role='estimator'), so it is safe to call whenever the estimator changes
    // away; the oldEstimator===newEstimator no-op short-circuit above already excludes the unchanged case.
    if (oldEstimator != null) {
      await removeEstimatorCommissionForDeal(tx, {
        dealId,
        estimatorUserId: oldEstimator,
        ownerUserId: owner,
        triggeredByUserId: userId,
      });
    }
    if (newEstimator != null) {
      await mintEstimatorCommissionForDeal(tx, {
        dealId,
        estimatorUserId: newEstimator,
        triggeredByUserId: userId,
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

// The date-only (YYYY-MM-DD, UTC) of a contract_signed_at timestamp — the fallback signed-date source
// when contract_signed_date is null (reseed/import _at-only rows). contractSignedAtFromDate stores _at at
// UTC midnight of the date, so this round-trips cleanly for app-set rows.
function dateStringFromTimestamp(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}
