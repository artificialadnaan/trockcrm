import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq, desc, isNotNull, isNull, or, sql } from "drizzle-orm";
import { companies, dealApprovals, dealHistory, dealScopingIntake, deals, dealSubscriptions, jobQueue, properties } from "@trock-crm/shared/schema";
import { requireRole, requireRfpReviewer } from "../../middleware/rbac.js";
import { isRfpVoterEmail } from "@trock-crm/shared/lib/rfpVoterEmails";
import {
  addDealChangeOrder,
  deleteDealChangeOrder,
  getDealChangeOrderById,
  listDealChangeOrders,
  sumDealChangeOrders,
  updateDealChangeOrder,
} from "./change-order-service.js";
import { AppError } from "../../middleware/error-handler.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import { assertOptionalIsoDateQueryParam } from "../../lib/date-query.js";
import { eventBus } from "../../events/bus.js";
import { DOMAIN_EVENTS } from "../../events/types.js";
import {
  BID_BOARD_STAGE_READ_ONLY_MESSAGE,
  buildBidBoardOwnershipState,
  getDeals,
  getDealById,
  getDealDetail,
  getEstimatingBoundaryStage,
  getRequiredEstimatingBoundaryStage,
  isBidBoardOwnedDownstreamStage,
  createDeal,
  updateDeal,
  startProposalDraft,
  deleteDeal,
  getDealsForPipeline,
  listDealStagePage,
  getDealSources,
  setDealContractSignedDate,
  setDealEstimator,
} from "./service.js";
import { listDealDescriptionHistory } from "./deal-description-history.js";
import { toJsonSafe } from "../../lib/json-safe.js";
import { redactDealList, redactDealResponse, shouldIncludeHubspotId, stripPrivateDealFieldsForViewer } from "./redact.js";
import { activateServiceHandoff, changeDealStage } from "./stage-change.js";
import { validateOptionalExpectedCloseDateInput } from "./expected-close-date-input.js";
import { stripBlankUuidPatchFields } from "./uuid-patch-coercion.js";
import { resolveMineVisibilityFeatures } from "../shared/mine-visibility.js";
import { preflightStageCheck } from "./stage-gate.js";
import { getContactsForDeal } from "../contacts/association-service.js";
import {
  getTeamMembers,
  addTeamMember,
  updateTeamMember,
  removeTeamMember,
} from "./team-service.js";
import { listUsers } from "../admin/users-service.js";
import {
  getEstimate,
  createSection,
  updateSection,
  deleteSection,
  createLineItem,
  updateLineItem,
  deleteLineItem,
} from "./estimate-service.js";
import { buildAuditActorFromUser, logActivity } from "../audit/audit-logger.js";
import {
  getRfpReviewDetail,
  reconfirmRfpDecline,
  requestOverrideApproval,
  type RfpOverrideApprovalResult,
} from "./rfp-override-service.js";
import {
  getPunchList,
  createPunchListItem,
  updatePunchListItem,
  completePunchListItem,
} from "./punch-list-service.js";
import {
  getTimers,
  createTimer,
  completeTimer,
  cancelTimer,
} from "./timer-service.js";
import {
  getCloseoutChecklist,
  initializeCloseoutChecklist,
  toggleChecklistItem,
  updateChecklistItem,
} from "./closeout-service.js";
import {
  DEAL_TEAM_ROLES,
  SCOPE_LOCKED_DEAL_PATCH_FIELDS,
  SCOPE_LOCKED_RESOLVED_FIELDS,
  PUNCH_LIST_TYPES,
  WORKFLOW_TIMER_TYPES,
  getScopeLockedDealPatchFields,
  getScopeLockedResolvedFields,
  normalizeStagePageSort,
  pendingRfpSubStateForStatus,
  toCanonicalDealStageSlug,
  type DealOpportunityEnteredEventPayload,
  type RfpRequestDeliveryPayload,
} from "@trock-crm/shared/types";
import {
  assertDealScopingWriteAllowed,
  evaluateDealScopingReadiness,
  getOrCreateDealScopingIntake,
  linkDealFileToScopingRequirement,
  routeRevisionToEstimating,
  upsertDealScopingIntake,
} from "./scoping-service.js";
import { getResolvedDeal, writeResolvedDealFields } from "./lineage-resolver.js";
import { inferDealBidBoardOwnership } from "./workflow-backfill.js";
import { getPendingRfpDeals, cancelPendingRfp } from "./pending-rfp-service.js";
import { confirmUpload, getFileById, getFileDownloadUrl, getPendingUploadMetadata } from "../files/service.js";
import { listDealScorecards, getDealScorecardDetail, getDealScorecardPdfDownload } from "./scorecards-service.js";
import {
  createEstimateSourceDocument,
  enqueueEstimateDocumentOcrJob,
  reprocessEstimateSourceDocument,
} from "../estimating/document-service.js";
import {
  listApprovedRecommendationIdsForRun,
  promoteApprovedRecommendationsToEstimate,
} from "../estimating/draft-estimate-service.js";
import {
  updateEstimatePricingRecommendationReviewState,
} from "../estimating/workbench-service.js";

function buildRouteAuditContext(req: { user?: any; headers: Record<string, unknown>; ip?: string | undefined }) {
  const actor = buildAuditActorFromUser({
    userId: req.user!.id,
    name: req.user!.displayName ?? req.user!.email ?? req.user!.id,
    role: req.user!.role,
  });
  const userAgentHeader = (req as { headers?: Record<string, unknown> }).headers?.["user-agent"];
  return {
    actor,
    ipAddress: req.ip ?? null,
    userAgent:
      Array.isArray(userAgentHeader)
        ? userAgentHeader.join(", ")
        : typeof userAgentHeader === "string"
          ? userAgentHeader
          : null,
  };
}
import {
  createManualEstimateRow,
  updateManualEstimateRow,
} from "../estimating/manual-row-service.js";
import {
  promoteManualRowToLocalCatalog,
} from "../estimating/local-catalog-service.js";
import {
  answerEstimatingCopilotQuestion,
  buildEstimatingCopilotContext,
  getEstimatingWorkflowState,
} from "../estimating/copilot-service.js";
import {
  approveEstimateExtraction,
  rejectEstimateExtraction,
  updateEstimateExtraction,
} from "../estimating/extraction-review-service.js";
import {
  approveEstimatePricingRecommendation,
  rejectEstimatePricingRecommendation,
  overrideEstimatePricingRecommendation,
} from "../estimating/pricing-review-service.js";
import {
  rejectEstimateExtractionMatch,
  selectEstimateExtractionMatch,
} from "../estimating/match-review-service.js";
import {
  clearDealMarketOverride,
  getDealEffectiveMarketContext,
  listEstimateMarkets,
  setDealMarketOverride,
} from "../estimating/deal-market-override-service.js";
import { resolveSyncHubRfpRequestUrl } from "./rfp-payload.js";
import { enqueueRfpBidBoardCreate, enqueueRfpVoteInvitation, insertOpportunityRfpRequestJob, loadRfpAttachmentsForDeal } from "./rfp-enqueue.js";
import { isOpportunityRfpEventEnabled, isRfpVotingEnabled } from "../../config/feature-flags.js";
import { castRfpVote, hasSufficientRfpVoters, isServiceRfp, openRfpVoteRound, rfpVotesTableExists } from "./rfp-vote-service.js";
import { getActiveProjectTypes, getAllStages, getStageBySlug } from "../pipeline/service.js";
import { resolveDealCreateOfficeCode } from "./create-context.js";
import {
  normalizeProjectNumberInput,
  ProjectNumberValidationError,
} from "./project-number-validation.js";
import {
  assertDealCollaboratorAccess,
  assertDealOwnerAccess,
  getCollaborativeReadRole,
  normalizeCollaborativeScope,
} from "../../lib/collaboration-access.js";

const router = Router();

async function assertDealRouteAccess(req: any, dealId: string) {
  return assertDealCollaboratorAccess(req.tenantDb!, dealId, req.user!);
}

async function assertDealOwnerRouteAccess(
  req: any,
  dealId: string,
  options: { allowAdmin?: boolean; allowDirector?: boolean; message?: string } = {}
) {
  return assertDealOwnerAccess(req.tenantDb!, dealId, req.user!, options);
}

async function isDealWatchedByUser(tenantDb: any, dealId: string, userId: string) {
  const features = await resolveMineVisibilityFeatures(tenantDb);
  if (!features.dealSubscriptions) {
    return false;
  }

  const [row] = await tenantDb
    .select({ id: dealSubscriptions.id })
    .from(dealSubscriptions)
    .where(
      and(
        eq(dealSubscriptions.dealId, dealId),
        eq(dealSubscriptions.userId, userId),
        isNull(dealSubscriptions.deletedAt)
      )
    )
    .limit(1);

  return Boolean(row);
}

async function lockScopeComparisonRows(tenantDb: any, dealId: string) {
  await tenantDb.execute(sql`SELECT id FROM deals WHERE id = ${dealId} FOR UPDATE`);
  await tenantDb.execute(sql`SELECT id FROM deal_scoping_intake WHERE deal_id = ${dealId} FOR UPDATE`);
}

function readScopeLockedResolvedBaseline(sectionData: unknown) {
  const sectionRecord =
    typeof sectionData === "object" && sectionData !== null && !Array.isArray(sectionData)
      ? sectionData as Record<string, unknown>
      : {};
  const opportunity =
    typeof sectionRecord.opportunity === "object" &&
    sectionRecord.opportunity !== null &&
    !Array.isArray(sectionRecord.opportunity)
      ? sectionRecord.opportunity as Record<string, unknown>
      : {};

  return {
    preBidMeetingCompleted: opportunity.preBidMeetingCompleted,
    siteVisitDecision: opportunity.siteVisitDecision,
    siteVisitCompleted: opportunity.siteVisitCompleted,
    estimatorConsultationNotes: opportunity.estimatorConsultationNotes,
  };
}

function normalizeRelationshipId(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRelationshipFillIn(field: string, patch: Record<string, unknown>, existing: Record<string, unknown>) {
  if (field !== "companyId" && field !== "propertyId") {
    return false;
  }

  return normalizeRelationshipId(existing[field]) == null && normalizeRelationshipId(patch[field]) != null;
}

function getLockedResolvedFieldsRequiringScopeGuard(
  patch: Record<string, unknown>,
  existing: Record<string, unknown>
) {
  return getScopeLockedResolvedFields(patch, existing).filter(
    (field) => !isRelationshipFillIn(field, patch, existing)
  );
}

function assertResolvedRelationshipLineagePolicy(
  patch: Record<string, unknown>,
  existing: Record<string, unknown>
) {
  const existingCompanyId = normalizeRelationshipId(existing.companyId);
  const requestedCompanyId = normalizeRelationshipId(patch.companyId);
  if (existingCompanyId && patch.companyId !== undefined && requestedCompanyId !== existingCompanyId) {
    throw new AppError(400, "companyId is immutable once established");
  }

  const existingPropertyId = normalizeRelationshipId(existing.propertyId);
  const requestedPropertyId = normalizeRelationshipId(patch.propertyId);
  if (existingPropertyId && patch.propertyId !== undefined && requestedPropertyId !== existingPropertyId) {
    throw new AppError(400, "propertyId is immutable once established");
  }
}

async function loadLockedDealPatchComparisonBaseline(
  tenantDb: any,
  dealId: string,
  role: string,
  userId: string,
) {
  await lockScopeComparisonRows(tenantDb, dealId);
  const deal = await getDealById(tenantDb, dealId, role, userId);
  if (!deal) {
    throw new AppError(403, "Forbidden");
  }
  return deal as Record<string, unknown>;
}

async function loadLockedResolvedFieldComparisonBaseline(tenantDb: any, dealId: string) {
  await lockScopeComparisonRows(tenantDb, dealId);
  const resolvedDeal = await getResolvedDeal(tenantDb, dealId);
  const [intake] = await tenantDb
    .select({ sectionData: dealScopingIntake.sectionData })
    .from(dealScopingIntake)
    .where(eq(dealScopingIntake.dealId, dealId))
    .limit(1);

  return {
    ...resolvedDeal.resolved,
    ...readScopeLockedResolvedBaseline(intake?.sectionData),
  } as Record<string, unknown>;
}

const DEAL_LOCATION_FIELDS = [
  "propertyAddress",
  "propertyCity",
  "propertyState",
  "propertyZip",
] as const;

function removeDealLocationFields(body: Record<string, unknown>) {
  for (const field of DEAL_LOCATION_FIELDS) {
    delete body[field];
  }
}

function hasDealLocationFields(body: Record<string, unknown>) {
  return DEAL_LOCATION_FIELDS.some((field) => body[field] !== undefined);
}

async function loadDealLocationFromProperty(tenantDb: any, propertyId: string) {
  const [property] = await tenantDb
    .select({
      companyId: properties.companyId,
      address: properties.address,
      city: properties.city,
      state: properties.state,
      zip: properties.zip,
    })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .limit(1);

  if (!property) {
    throw new AppError(400, "Selected property was not found.");
  }

  return {
    companyId: property.companyId ?? null,
    dealLocation: {
      propertyAddress: property.address ?? null,
      propertyCity: property.city ?? null,
      propertyState: property.state ?? null,
      propertyZip: property.zip ?? null,
    },
  };
}

async function assertResolvedRelationshipConsistency(
  tenantDb: any,
  patch: Record<string, unknown>,
  existing: Record<string, unknown>
) {
  const requestedPropertyId = normalizeRelationshipId(patch.propertyId);
  const requestedCompanyId = normalizeRelationshipId(patch.companyId);
  const existingPropertyId = normalizeRelationshipId(existing.propertyId);
  const existingCompanyId = normalizeRelationshipId(existing.companyId);
  const effectivePropertyId = requestedPropertyId ?? existingPropertyId;
  const effectiveCompanyId = requestedCompanyId ?? existingCompanyId;
  const propertyRelationshipChanged = requestedPropertyId != null && requestedPropertyId !== existingPropertyId;
  const companyRelationshipChanged = requestedCompanyId != null && requestedCompanyId !== existingCompanyId;

  if (effectivePropertyId && (propertyRelationshipChanged || companyRelationshipChanged)) {
    const property = await loadDealLocationFromProperty(tenantDb, effectivePropertyId);
    if (effectiveCompanyId && property.companyId !== effectiveCompanyId) {
      throw new AppError(400, "Property does not belong to the company");
    }
  }
}

const LEGACY_CLEANUP_SCOPE_AUDIT_FIELDS = new Set([
  "name",
  "description",
  "projectType",
  "projectTypeId",
  "regionId",
  "workflowRoute",
  "propertyName",
  ...SCOPE_LOCKED_RESOLVED_FIELDS,
]);

function isLegacyCleanupEligibleRole(role: string) {
  return role === "admin" || role === "director" || role === "rep";
}

function normalizeComparableValue(value: unknown): unknown {
  if (value == null) return null;

  if (typeof value === "string") {
    return value.trim().length === 0 ? null : value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeComparableValue(entry))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalizeComparableValue(entryValue)])
    );
  }

  return value;
}

function comparableValuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(normalizeComparableValue(left)) === JSON.stringify(normalizeComparableValue(right));
}

function isLegacyCleanupRepairTrigger(body: Record<string, unknown>, deal: Record<string, unknown>) {
  const missingCompany = normalizeRelationshipId(deal.companyId) == null;
  const missingProperty = normalizeRelationshipId(deal.propertyId) == null;

  if (!missingCompany && !missingProperty) {
    return false;
  }

  const repairsMissingCompany =
    missingCompany &&
    body.companyId !== undefined &&
    normalizeRelationshipId(body.companyId) != null;
  const repairsMissingProperty =
    missingProperty &&
    body.propertyId !== undefined &&
    normalizeRelationshipId(body.propertyId) != null;

  return repairsMissingCompany || repairsMissingProperty;
}

function hasCompleteLegacyCleanupRelationships(
  patch: Record<string, unknown>,
  existing: Record<string, unknown> | null | undefined
) {
  const baseline = (existing ?? {}) as Record<string, unknown>;
  const effectiveCompanyId =
    patch.companyId !== undefined
      ? normalizeRelationshipId(patch.companyId)
      : normalizeRelationshipId(baseline.companyId);
  const effectivePropertyId =
    patch.propertyId !== undefined
      ? normalizeRelationshipId(patch.propertyId)
      : normalizeRelationshipId(baseline.propertyId);

  return effectiveCompanyId != null && effectivePropertyId != null;
}

function getLegacyCleanupScopeFieldChanges(
  patch: Record<string, unknown>,
  existing: Record<string, unknown> | null | undefined
) {
  const baseline = (existing ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(patch)
      .filter(
        (field) =>
          LEGACY_CLEANUP_SCOPE_AUDIT_FIELDS.has(field) &&
          !comparableValuesEqual(patch[field], baseline[field])
      )
      .map((field) => [
        field,
        {
          from: baseline[field] ?? null,
          to: patch[field] ?? null,
        },
      ])
  );
}

async function writeLegacyCleanupScopeAuditLog(
  req: any,
  route: "deals" | "resolved-fields",
  dealBaseline: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>
) {
  const changes = getLegacyCleanupScopeFieldChanges(patch, dealBaseline);
  if (Object.keys(changes).length === 0) {
    return;
  }

  await writeAuditLog(req.tenantDb!, {
    tableName: "deals",
    recordId: req.params.id,
    action: "legacy_cleanup_scope_change",
    changedBy: req.user!.id,
    actorName: req.user!.displayName ?? req.user!.email ?? req.user!.id,
    actorRole: req.user!.role,
    entityType: "deal",
    changes,
    fullRow: {
      route,
      cleanupMode: true,
      sourceLeadId: dealBaseline?.sourceLeadId ?? null,
    },
    ipAddress: req.ip ?? null,
    userAgent: buildRouteAuditContext(req).userAgent,
  });
}

function shouldTreatPatchAsLegacyCleanup(
  body: Record<string, unknown>,
  role: string,
  deal: Record<string, unknown> | null
) {
  if (
    !deal ||
    !isLegacyCleanupEligibleRole(role)
  ) {
    return false;
  }

  if (deal.sourceLeadId != null) {
    return false;
  }

  return isLegacyCleanupRepairTrigger(body, deal);
}

function isEstimatingBoundaryStageSlug(stageSlug: string, workflowRoute: "normal" | "service") {
  return (
    stageSlug === "estimating" ||
    stageSlug === (workflowRoute === "service" ? "service_estimating" : "estimate_in_progress")
  );
}

function readBoardInput(req: Parameters<typeof router.get>[1] extends never ? never : any) {
  const scope = normalizeCollaborativeScope(
    req.user!.role,
    req.query.scope as "mine" | "team" | "all" | "watched" | "on_hold" | undefined
  );
  return {
    role: getCollaborativeReadRole(req.user!.role, scope),
    atRiskViewerRole: req.user!.role,
    userId: req.user!.id,
    activeOfficeId: req.user!.activeOfficeId ?? req.user!.officeId,
    scope,
    includeDd: req.query.includeDd === "true",
  };
}

// Exported for the watched-scope test. The server runtime whitelist for GET /api/deals — an unknown
// scope coerces to "mine" (NOT silent ALL); the deals-only "watched"/"on_hold" must survive here or the
// filter silently shows Mine.
export function readListScope(
  value: unknown,
  role: string
): "mine" | "team" | "all" | "watched" | "on_hold" {
  void role;
  return value === "mine" ||
    value === "team" ||
    value === "all" ||
    value === "watched" ||
    value === "on_hold"
    ? value
    : "mine";
}

// Query params arrive as `string | string[] | undefined`. Reject the array form
// (e.g. `?source=a&source=b`) with a 400 so a malformed request never reaches the
// parameterized SQL and surfaces as a 500.
function readOptionalStringParam(value: unknown, fieldName: string): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new AppError(400, `${fieldName} must be a single value`);
  }
  return value;
}

function readStageInput(req: Parameters<typeof router.get>[1] extends never ? never : any) {
  const parseNumber = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  // Filter bounds (value/age) PRESERVE a present-but-malformed value as NaN (absent → undefined), so the
  // summary no-matches it exactly like the list (buildValueRangePredicate/buildStalledPredicate turn a
  // present NaN into sql`false`) instead of silently dropping the filter (Codex P2). Pagination keeps the
  // default-on-malformed parseNumber.
  const parseFilterNumber = (value: unknown) => (value === undefined ? undefined : Number(value));

  return {
    ...readBoardInput(req),
    stageId: req.params.stageId,
    page: parseNumber(req.query.page) ?? 1,
    pageSize: parseNumber(req.query.pageSize) ?? 25,
    sort: normalizeStagePageSort(req.query.sort as string | undefined),
    search: req.query.search as string | undefined,
    assignedRepId: req.query.assignedRepId as string | undefined,
    estimateSentFrom: assertOptionalIsoDateQueryParam(
      (req.query.estimateSentFrom as string | undefined) ?? (req.query.estimate_sent_since as string | undefined),
      "estimateSentFrom"
    ),
    estimateSentTo: assertOptionalIsoDateQueryParam(
      (req.query.estimateSentTo as string | undefined) ?? (req.query.estimate_sent_until as string | undefined),
      "estimateSentTo"
    ),
    regionId: req.query.regionId as string | undefined,
    source: readOptionalStringParam(req.query.source, "source"),
    staleOnly: req.query.staleOnly === "true",
    workflowRoute: req.query.workflowRoute as string | undefined,
    status: req.query.status as string | undefined,
    // Single-value reader (like source): a duplicated ?projectTypeId=a&projectTypeId=b arrives as an
    // array; reject it with a 400 instead of letting it reach `d.project_type_id = ${array}` and 500 (P3).
    projectTypeId: readOptionalStringParam(req.query.projectTypeId, "projectTypeId"),
    valueMin: parseFilterNumber(req.query.valueMin),
    valueMax: parseFilterNumber(req.query.valueMax),
    updatedFrom: (req.query.updatedAfter as string | undefined) ?? (req.query.updatedFrom as string | undefined),
    updatedTo: (req.query.updatedBefore as string | undefined) ?? (req.query.updatedTo as string | undefined),
    minAgeDays: parseFilterNumber(req.query.minAgeDays),
    maxAgeDays: parseFilterNumber(req.query.maxAgeDays),
    wonSince: req.query.won_since as string | undefined,
    wonUntil: req.query.won_until as string | undefined,
    wonAllTime: req.query.won_all_time === "true",
    lostSince: req.query.lost_since as string | undefined,
    lostUntil: req.query.lost_until as string | undefined,
    lostAllTime: req.query.lost_all_time === "true",
  };
}

async function queueDomainEvent(
  tenantDb: any,
  officeId: string | null,
  eventName: string,
  payload: Record<string, unknown>
) {
  await tenantDb.insert(jobQueue).values({
    jobType: "domain_event",
    payload: {
      eventName,
      ...payload,
    },
    officeId,
    status: "pending",
    runAfter: new Date(),
  });
}

async function loadDealStageSlug(tenantDb: any, stageId: string): Promise<string | null> {
  const result = await tenantDb.execute(sql`
    SELECT slug
      FROM pipeline_stage_config
     WHERE id = ${stageId}
     LIMIT 1
  `);
  const rows = Array.isArray(result) ? result : result.rows ?? [];
  const row = rows[0] as { slug?: string | null } | undefined;
  return row?.slug ?? null;
}

async function loadTriggerRfpDeal(tenantDb: any, dealId: string) {
  const [deal] = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);
  return deal ?? null;
}

async function buildTriggerRfpConflict(
  tenantDb: any,
  dealId: string,
  input: {
    userRole: string;
    userId: string;
    expectedOpportunityStageId: string;
  }
) {
  const latest = await loadTriggerRfpDeal(tenantDb, dealId);
  if (!latest) {
    return new AppError(404, "Deal not found");
  }

  const latestStageSlug = await loadDealStageSlug(tenantDb, latest.stageId);
  const canonicalStageSlug = latestStageSlug
    ? toCanonicalDealStageSlug(latestStageSlug, latest.workflowRoute)
    : null;
  if (latest.stageId !== input.expectedOpportunityStageId || canonicalStageSlug !== "opportunity") {
    return new AppError(
      409,
      "RFP review can only be triggered while the deal is still in Opportunity stage.",
      "RFP_STAGE_MISMATCH"
    );
  }

  if (latest.rfpApprovalRequestedAt || latest.rfpApprovalStatus) {
    return new AppError(
      409,
      "RFP review has already been triggered for this deal.",
      "RFP_ALREADY_TRIGGERED"
    );
  }

  const inferredOwnership = inferDealBidBoardOwnership({
    id: latest.id,
    stageSlug: latestStageSlug ?? "opportunity",
    stageEnteredAt: latest.stageEnteredAt,
    workflowRoute: latest.workflowRoute,
    pipelineTypeSnapshot: latest.pipelineTypeSnapshot,
    ddEstimate: latest.ddEstimate,
    bidEstimate: latest.bidEstimate,
    awardedAmount: latest.awardedAmount,
    sourceLeadId: latest.sourceLeadId,
    isBidBoardOwned: latest.isBidBoardOwned,
    bidBoardStageSlug: latest.bidBoardStageSlug,
    bidBoardStageEnteredAt: latest.bidBoardStageEnteredAt,
    bidBoardMirrorSourceEnteredAt: latest.bidBoardMirrorSourceEnteredAt,
    isReadOnlyMirror: latest.isReadOnlyMirror,
    readOnlySyncedAt: latest.readOnlySyncedAt,
  });
  if (latest.isBidBoardOwned || inferredOwnership.isBidBoardOwned) {
    return new AppError(
      409,
      "RFP review cannot be triggered after Bid Board owns this deal.",
      "RFP_ALREADY_HANDED_OFF"
    );
  }

  if (input.userRole === "rep" && latest.assignedRepId !== input.userId) {
    return new AppError(
      409,
      "This deal is no longer assigned to you.",
      "RFP_OWNERSHIP_CHANGED"
    );
  }

  return new AppError(
    409,
    "RFP review could not be triggered because the deal changed. Refresh and try again.",
    "RFP_TRIGGER_CONFLICT"
  );
}

function buildScopeIncompleteError(readiness: Awaited<ReturnType<typeof evaluateDealScopingReadiness>>) {
  const missingSections = Object.keys(readiness.errors.sections ?? {});
  return new AppError(
    400,
    [
      "Complete Opportunity Scope before triggering RFP review.",
      missingSections.length > 0 ? `Missing sections: ${missingSections.join(", ")}` : null,
    ].filter(Boolean).join(" "),
    "RFP_SCOPE_INCOMPLETE"
  );
}

function hasBlockingScopingReadinessErrors(
  readiness: Awaited<ReturnType<typeof evaluateDealScopingReadiness>>
) {
  return Object.values(readiness.errors.sections ?? {}).some((fields) => fields.length > 0);
}

async function queueAiEstimateRefresh(
  tenantDb: any,
  officeId: string,
  dealId: string,
  reason: string,
  requestedBy: string
) {
  await tenantDb.insert(jobQueue).values([
    {
      jobType: "ai_index_document",
      payload: {
        sourceType: "estimate_snapshot",
        sourceId: dealId,
        dealId,
        reason,
      },
      officeId,
      status: "pending",
      runAfter: new Date(),
    },
    {
      jobType: "ai_refresh_copilot",
      payload: {
        dealId,
        reason,
        requestedBy,
      },
      officeId,
      status: "pending",
      runAfter: new Date(),
    },
  ]);
}

function emitLocalDealEvents(
  events: Array<{ name: string; payload: any }>,
  input: { officeId: string; userId: string }
) {
  for (const event of events) {
    try {
      eventBus.emitLocal({
        name: event.name as any,
        payload: event.payload,
        officeId: input.officeId,
        userId: input.userId,
        timestamp: new Date(),
      });
    } catch (eventErr) {
      console.error(`[Deals] Failed to emit local event ${event.name}:`, eventErr);
    }
  }
}

function isProposalDraftingEnabled() {
  return process.env.PROPOSAL_DRAFTING_ENABLED === "true";
}

// GET /api/deals — list deals (paginated, filtered, sorted)
router.get("/", async (req, res, next) => {
  try {
    const createdFrom = assertOptionalIsoDateQueryParam(req.query.createdFrom, "createdFrom");
    const createdTo = assertOptionalIsoDateQueryParam(req.query.createdTo, "createdTo");
    const estimateSentFrom = assertOptionalIsoDateQueryParam(req.query.estimateSentFrom, "estimateSentFrom");
    const estimateSentTo = assertOptionalIsoDateQueryParam(req.query.estimateSentTo, "estimateSentTo");
    const wonClosedFrom = assertOptionalIsoDateQueryParam(req.query.wonClosedFrom, "wonClosedFrom");
    const wonClosedTo = assertOptionalIsoDateQueryParam(req.query.wonClosedTo, "wonClosedTo");
    // FilterBar: one canonical outcome-aware window (the server routes it per
    // outcome). Accept both snake_case (URL contract) and camelCase.
    const dateFrom = assertOptionalIsoDateQueryParam(
      (req.query.date_from as string | undefined) ?? (req.query.dateFrom as string | undefined),
      "date_from"
    );
    const dateTo = assertOptionalIsoDateQueryParam(
      (req.query.date_to as string | undefined) ?? (req.query.dateTo as string | undefined),
      "date_to"
    );
    const toOptionalNumber = (value: unknown): number | undefined => {
      if (value === undefined || value === null || value === "") return undefined;
      const parsed = Number(value);
      // Present-but-malformed (e.g. ?valueMin=abc / ?minAgeDays=abc) → NaN
      // sentinel, NOT undefined, so the predicate registry no-matches it instead
      // of treating a bad URL like an unset filter and silently widening to the
      // unfiltered active list (Codex #546). Absent/empty stays undefined.
      return Number.isFinite(parsed) ? parsed : NaN;
    };
    // Pass workflowRoute/status through RAW so the predicate registry is the
    // single validation point: a recognized value applies its predicate, an
    // unrecognized one becomes a no-match (sql`false`), and absent/empty/all/any
    // omits. Normalizing bad values to undefined here would defeat the no-match
    // and silently widen results (param contract §3; Codex #546).
    const workflowRoute = req.query.workflowRoute as string | undefined;
    const status = req.query.status as string | undefined;
    const isActiveFilter =
      req.query.isActive === "all"
        ? ("all" as const)
        : req.query.isActive === "pipeline"
          ? ("pipeline" as const)
          : req.query.isActive === "false"
            ? false
            : true;
    const filters = {
      search: req.query.search as string | undefined,
      stageIds: req.query.stageIds
        ? (req.query.stageIds as string).split(",")
        : undefined,
      inactiveStageIds: req.query.inactiveStageIds
        ? (req.query.inactiveStageIds as string).split(",")
        : undefined,
      assignedRepId: req.query.assignedRepId as string | undefined,
      projectTypeId: req.query.projectTypeId as string | undefined,
      regionId: req.query.regionId as string | undefined,
      source: req.query.source as string | undefined,
      contractSignedFrom: req.query.contractSignedFrom as string | undefined,
      contractSignedTo: req.query.contractSignedTo as string | undefined,
      wonClosedFrom,
      wonClosedTo,
      estimateSentFrom,
      estimateSentTo,
      createdFrom,
      createdTo,
      updatedFrom: req.query.updatedFrom as string | undefined,
      updatedTo: req.query.updatedTo as string | undefined,
      isActive: isActiveFilter,
      workflowRoute,
      status,
      valueMin: toOptionalNumber(req.query.valueMin),
      valueMax: toOptionalNumber(req.query.valueMax),
      minAgeDays: toOptionalNumber(req.query.minAgeDays),
      maxAgeDays: toOptionalNumber(req.query.maxAgeDays),
      dateFrom,
      dateTo,
      stageEntryDateWindow:
        req.query.stage_entry_window === "true" || req.query.stageEntryDateWindow === "true",
      excludeOnHold: req.query.exclude_on_hold === "true" || req.query.excludeOnHold === "true",
      sortBy: req.query.sortBy as any,
      sortDir: req.query.sortDir as "asc" | "desc" | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      scope: normalizeCollaborativeScope(req.user!.role, readListScope(req.query.scope, req.user!.role)),
      activeOfficeId: req.user!.activeOfficeId ?? req.user!.officeId,
      // Opt-in running-total aggregate (#4): only surfaces showing the Total card request it.
      includeValueTotal: req.query.includeValueTotal === "true",
    };

    const result = await getDeals(
      req.tenantDb!,
      filters,
      getCollaborativeReadRole(req.user!.role, filters.scope),
      req.user!.id,
      req.user!.role
    );
    await req.commitTransaction!();
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.json({
      ...result,
      deals: redactDealList(result.deals, { includeHubspotId }).map((deal) =>
        stripPrivateDealFieldsForViewer(deal as Record<string, unknown>, {
          isOwner: (deal as { assignedRepId?: string | null }).assignedRepId === req.user!.id,
        })
      ),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/pending-rfp — all deals in the Pending-RFP bucket (office-scoped via tenant schema).
// Sales-role gated: this is a cross-rep read, so keep non-sales CRM roles (e.g. construction) out.
router.get("/pending-rfp", requireRole("admin", "director", "rep"), async (req, res, next) => {
  try {
    const deals = await getPendingRfpDeals(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ deals });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/sources — distinct deal sources for filter dropdown
router.get("/sources", async (req, res, next) => {
  try {
    const sources = await getDealSources(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ sources });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/pipeline — deals grouped by stage for kanban
router.get("/pipeline", async (req, res, next) => {
  try {
    const rawPreviewLimit = req.query.previewLimit as string | undefined;
    const parsedPreviewLimit = rawPreviewLimit ? parseInt(rawPreviewLimit, 10) : undefined;
    const estimateSentFrom = assertOptionalIsoDateQueryParam(req.query.estimateSentFrom, "estimateSentFrom");
    const estimateSentTo = assertOptionalIsoDateQueryParam(req.query.estimateSentTo, "estimateSentTo");
    const scope = normalizeCollaborativeScope(
      req.user!.role,
      req.query.scope as "mine" | "team" | "all" | "watched" | "on_hold" | undefined
    );
    const filters = {
      assignedRepId: req.query.assignedRepId as string | undefined,
      estimateSentFrom,
      estimateSentTo,
      scope,
      activeOfficeId: req.user!.activeOfficeId ?? req.user!.officeId,
      includeDd: req.query.includeDd === "true",
      previewLimit: Number.isFinite(parsedPreviewLimit) ? parsedPreviewLimit : undefined,
      wonSince: req.query.won_since as string | undefined,
      wonUntil: req.query.won_until as string | undefined,
      wonAllTime: req.query.won_all_time === "true",
      wonPeriodFrom: req.query.won_period_from as string | undefined,
      wonPeriodTo: req.query.won_period_to as string | undefined,
      lostSince: req.query.lost_since as string | undefined,
      lostUntil: req.query.lost_until as string | undefined,
      lostAllTime: req.query.lost_all_time === "true",
    };
    const result = await getDealsForPipeline(
      req.tenantDb!,
      getCollaborativeReadRole(req.user!.role, scope),
      req.user!.id,
      filters,
      req.user!.role
    );
    await req.commitTransaction!();
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.json({
      ...result,
      pipelineColumns: result.pipelineColumns.map((column) => ({
        ...column,
        deals: redactDealList(column.deals, { includeHubspotId }).map((deal) =>
          stripPrivateDealFieldsForViewer(deal as Record<string, unknown>, {
            isOwner: (deal as { assignedRepId?: string | null }).assignedRepId === req.user!.id,
          })
        ),
      })),
      terminalStages: result.terminalStages,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/stages", async (req, res, next) => {
  try {
    const stages = await getAllStages("deal");
    await req.commitTransaction!();
    res.json({ stages });
  } catch (err) {
    next(err);
  }
});

router.get("/stages/:stageId", async (req, res, next) => {
  try {
    // listDealStagePage returns `rows` from a hand-written SELECT that never
    // includes hubspot_deal_id — no redaction needed here.
    const result = await listDealStagePage(req.tenantDb!, readStageInput(req));
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/nearby?lat=X&lng=Y — Find nearest deals by GPS coordinates
router.get("/nearby", async (req, res, next) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new AppError(400, "Valid lat and lng query parameters are required.");
    }

    // Haversine distance in miles — filter out NULL coords first to avoid NaN
    const haversine = sql`
      3959 * acos(
        LEAST(1.0, GREATEST(-1.0,
          cos(radians(${lat})) * cos(radians(CAST(${deals.propertyLat} AS DOUBLE PRECISION)))
          * cos(radians(CAST(${deals.propertyLng} AS DOUBLE PRECISION)) - radians(${lng}))
          + sin(radians(${lat})) * sin(radians(CAST(${deals.propertyLat} AS DOUBLE PRECISION)))
        ))
      )
    `;

    // All users can see all deals — no rep filtering
    const conditions = [
      eq(deals.isActive, true),
      isNotNull(deals.propertyLat),
      isNotNull(deals.propertyLng),
    ];

    const nearbyDeals = await req.tenantDb!
      .select({
        id: deals.id,
        dealNumber: deals.dealNumber,
        name: deals.name,
        propertyCity: deals.propertyCity,
        distance: haversine.as("distance"),
      })
      .from(deals)
      .where(and(...conditions))
      .orderBy(haversine)
      .limit(20);

    await req.commitTransaction!();
    res.json({ deals: nearbyDeals });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id — single deal (basic)
router.get("/:id", async (req, res, next) => {
  try {
    const dealAccess = await assertDealCollaboratorAccess(req.tenantDb!, req.params.id, req.user!);
    const deal = await getDealById(
      req.tenantDb!,
      req.params.id,
      getCollaborativeReadRole(req.user!.role, dealAccess.assignedRepId === req.user!.id ? "mine" : "all"),
      req.user!.id,
      req.user!.role
    );
    if (!deal) throw new AppError(404, "Deal not found");
    const isWatching = await isDealWatchedByUser(req.tenantDb!, req.params.id, req.user!.id);
    await req.commitTransaction!();
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.json(toJsonSafe({
      deal: {
        ...stripPrivateDealFieldsForViewer(
          redactDealResponse(deal, { includeHubspotId }) as Record<string, unknown>,
          { isOwner: deal.assignedRepId === req.user!.id }
        ),
        isWatching,
      },
    }));
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/detail — deal with stage history, approvals, change orders
router.get("/:id/detail", async (req, res, next) => {
  try {
    const dealAccess = await assertDealCollaboratorAccess(req.tenantDb!, req.params.id, req.user!);
    const detail = await getDealDetail(
      req.tenantDb!,
      req.params.id,
      getCollaborativeReadRole(req.user!.role, dealAccess.assignedRepId === req.user!.id ? "mine" : "all"),
      req.user!.id,
      req.user!.role
    );
    if (!detail) throw new AppError(404, "Deal not found");
    const isWatching = await isDealWatchedByUser(req.tenantDb!, req.params.id, req.user!.id);
    await req.commitTransaction!();
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.json(toJsonSafe({
      deal: {
        ...stripPrivateDealFieldsForViewer(
          redactDealResponse(detail, { includeHubspotId }) as Record<string, unknown>,
          { isOwner: detail.assignedRepId === req.user!.id }
        ),
        isWatching,
        isRfpTriggerEnabled: isOpportunityRfpEventEnabled(),
      },
    }));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/watch", async (req, res, next) => {
  try {
    await assertDealCollaboratorAccess(req.tenantDb!, req.params.id, req.user!);
    const features = await resolveMineVisibilityFeatures(req.tenantDb!);
    if (!features.dealSubscriptions) {
      throw new AppError(503, "Deal watching is temporarily unavailable for this office.");
    }
    await req.tenantDb!
      .insert(dealSubscriptions)
      .values({
        dealId: req.params.id,
        userId: req.user!.id,
        createdAt: new Date(),
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: [dealSubscriptions.dealId, dealSubscriptions.userId],
        set: {
          deletedAt: null,
        },
      });
    await req.commitTransaction!();
    res.status(200).json({ watching: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/watch", async (req, res, next) => {
  try {
    await assertDealCollaboratorAccess(req.tenantDb!, req.params.id, req.user!);
    const features = await resolveMineVisibilityFeatures(req.tenantDb!);
    if (!features.dealSubscriptions) {
      throw new AppError(503, "Deal watching is temporarily unavailable for this office.");
    }
    await req.tenantDb!
      .update(dealSubscriptions)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(dealSubscriptions.dealId, req.params.id),
          eq(dealSubscriptions.userId, req.user!.id),
          isNull(dealSubscriptions.deletedAt)
        )
      );
    await req.commitTransaction!();
    res.status(200).json({ watching: false });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/trigger-rfp — manually enqueue an Opportunity RFP request after scope is ready.
router.post("/:id/trigger-rfp", async (req, res, next) => {
  try {
    if (!isOpportunityRfpEventEnabled()) {
      throw new AppError(503, "Opportunity RFP delivery is disabled.", "RFP_EVENT_DISABLED");
    }

    const userRole = req.user!.role;
    const userId = req.user!.id;
    const deal = await loadTriggerRfpDeal(req.tenantDb!, req.params.id);
    if (!deal) throw new AppError(404, "Deal not found");

    // Directors trigger RFP office-wide (like admins) — the route runs against the active office's
    // tenantDb, so a director can only reach deals in the office they're acting in. The rep-only branch
    // still owner-scopes reps to their own deals (see updateConditions below). Who triggered is recorded
    // via rfpApprovalRequestedBy, so a director acting on another rep's deal is audited on the deal.
    const canTriggerRfp =
      userRole === "admin" ||
      userRole === "director" ||
      (userRole === "rep" && deal.assignedRepId === userId);
    if (!canTriggerRfp) {
      throw new AppError(403, "Only the assigned rep, a director, or an admin can trigger RFP review.", "RFP_UNAUTHORIZED");
    }

    const stageSlug = await loadDealStageSlug(req.tenantDb!, deal.stageId);
    const canonicalStageSlug = stageSlug
      ? toCanonicalDealStageSlug(stageSlug, deal.workflowRoute)
      : null;
    if (canonicalStageSlug !== "opportunity") {
      throw new AppError(400, "RFP review can only be triggered from Opportunity stage.", "RFP_WRONG_STAGE");
    }

    const inferredOwnership = inferDealBidBoardOwnership({
      id: deal.id,
      stageSlug: stageSlug ?? "opportunity",
      stageEnteredAt: deal.stageEnteredAt,
      workflowRoute: deal.workflowRoute,
      pipelineTypeSnapshot: deal.pipelineTypeSnapshot,
      ddEstimate: deal.ddEstimate,
      bidEstimate: deal.bidEstimate,
      awardedAmount: deal.awardedAmount,
      sourceLeadId: deal.sourceLeadId,
      isBidBoardOwned: deal.isBidBoardOwned,
      bidBoardStageSlug: deal.bidBoardStageSlug,
      bidBoardStageEnteredAt: deal.bidBoardStageEnteredAt,
      bidBoardMirrorSourceEnteredAt: deal.bidBoardMirrorSourceEnteredAt,
      isReadOnlyMirror: deal.isReadOnlyMirror,
      readOnlySyncedAt: deal.readOnlySyncedAt,
    });
    if (deal.isBidBoardOwned || inferredOwnership.isBidBoardOwned) {
      throw new AppError(
        409,
        "RFP review cannot be triggered after Bid Board owns this deal.",
        "RFP_ALREADY_HANDED_OFF"
      );
    }

    if (deal.rfpApprovalRequestedAt || deal.rfpApprovalStatus) {
      throw new AppError(409, "RFP review has already been triggered for this deal.", "RFP_ALREADY_TRIGGERED");
    }

    const readiness = await evaluateDealScopingReadiness(req.tenantDb!, deal.id);
    if (hasBlockingScopingReadinessErrors(readiness)) {
      throw buildScopeIncompleteError(readiness);
    }

    const officeId = req.user!.activeOfficeId ?? req.user!.officeId ?? null;

    // Non-service deals with voting ENABLED open a three-voter round instead of the SyncHub email path.
    // Service / type-4 (and voting-disabled) deals fall through to the unchanged SyncHub delivery below.
    // Guard: only take the voting branch when the full RFP_VOTER_COUNT trio is configured. A partial/empty
    // RFP_VOTER_EMAILS (unset, or a typo that drops a voter) can never reach the 2-of-3 tally — isRfpVoter is
    // false for the missing voters, nobody can push it to a decision, and the still-'pending' round can't be
    // returned to Opportunity (cancel only clears an attention-state RFP). A misconfigured flag must degrade
    // safely, so fall back to the existing SyncHub delivery path below instead. (See hasSufficientRfpVoters.)
    // Also require the rfp_votes table to exist for THIS office (finding G1): if the flag is on but migration
    // 0175 hasn't run here, opening a round would let voters reach a form whose first cast 500s on the missing
    // table, leaving the deal stranded 'pending'. Probe with to_regclass and fall back to SyncHub if absent.
    if (
      !isServiceRfp(deal) &&
      isRfpVotingEnabled() &&
      hasSufficientRfpVoters(process.env) &&
      (await rfpVotesTableExists(req.tenantDb!))
    ) {
      await openRfpVoteRound({
        tenantDb: req.tenantDb!,
        officeId,
        deal,
        requestedByUserId: userId,
        // Re-bind rep ownership in the atomic reservation, mirroring the SyncHub path below: if the deal is
        // reassigned between the read above and the reserve, a former owner's trigger must match nothing (409)
        // rather than opening a round + emailing voters for another rep's deal.
        enforceAssignedRepId: userRole === "rep" ? userId : null,
      });
      // Post-reservation scope recheck, mirroring the SyncHub path: a file/scoping field removed between the
      // initial readiness check above and the reserve must abort the round (throw rolls back the still-open
      // transaction — the round + invitation enqueue) rather than inviting voters to an incomplete RFP.
      const votingReadiness = await evaluateDealScopingReadiness(req.tenantDb!, deal.id);
      if (hasBlockingScopingReadinessErrors(votingReadiness)) {
        throw buildScopeIncompleteError(votingReadiness);
      }
      const [voted] = await req.tenantDb!
        .select({ status: deals.rfpApprovalStatus, eventId: deals.rfpApprovalRequestEventId })
        .from(deals)
        .where(eq(deals.id, deal.id))
        .limit(1);
      await req.commitTransaction!();
      res.json(toJsonSafe({
        success: true,
        mode: "vote",
        status: voted?.status ?? "pending",
        eventId: voted?.eventId ?? null,
      }));
      return;
    }

    const requestedAt = new Date();
    const eventId = randomUUID();
    const updateConditions = [
      eq(deals.id, deal.id),
      eq(deals.stageId, deal.stageId),
      isNull(deals.rfpApprovalStatus),
      isNull(deals.rfpApprovalRequestedAt),
      eq(deals.isBidBoardOwned, false),
      or(isNull(deals.bidBoardStageSlug), eq(deals.bidBoardStageSlug, ""))!,
      eq(deals.isReadOnlyMirror, false),
      isNull(deals.readOnlySyncedAt),
      isNull(deals.bidBoardStageEnteredAt),
      isNull(deals.bidBoardMirrorSourceEnteredAt),
    ];
    if (userRole === "rep") {
      updateConditions.push(eq(deals.assignedRepId, userId));
    }

    const [reservedDeal] = await req.tenantDb!
      .update(deals)
      .set({
        rfpApprovalRequestedAt: requestedAt,
        rfpApprovalRequestEventId: eventId,
        rfpApprovalRequestedBy: userId,
        rfpApprovalStatus: "pending_outbox",
      })
      .where(and(...updateConditions))
      .returning();

    if (!reservedDeal) {
      throw await buildTriggerRfpConflict(req.tenantDb!, deal.id, {
        userRole,
        userId,
        expectedOpportunityStageId: deal.stageId,
      });
    }

    const reservedReadiness = await evaluateDealScopingReadiness(req.tenantDb!, reservedDeal.id);
    if (hasBlockingScopingReadinessErrors(reservedReadiness)) {
      throw buildScopeIncompleteError(reservedReadiness);
    }

    const { jobId } = await insertOpportunityRfpRequestJob({
      tenantDb: req.tenantDb!,
      deal: reservedDeal,
      officeId,
      eventId,
    });

    const eventsToEmit: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const opportunityPayload = {
      eventName: DOMAIN_EVENTS.DEAL_OPPORTUNITY_ENTERED,
      eventId,
      idempotencyKey: `deal:${deal.id}:rfp_approval:lifetime`,
      dealId: deal.id,
      dealNumber: reservedDeal.dealNumber,
      dealName: reservedDeal.name,
      officeId,
      workflowRoute: reservedDeal.workflowRoute,
      fromStageId: deal.stageId,
      toStageId: reservedDeal.stageId,
      toStageSlug: "opportunity",
      enteredAt: requestedAt,
      requestedBy: userId,
      source: "manual_trigger",
    } satisfies DealOpportunityEnteredEventPayload;
    await queueDomainEvent(req.tenantDb!, officeId, DOMAIN_EVENTS.DEAL_OPPORTUNITY_ENTERED, opportunityPayload);
    eventsToEmit.push({
      name: DOMAIN_EVENTS.DEAL_OPPORTUNITY_ENTERED,
      payload: opportunityPayload,
    });

    await req.commitTransaction!();
    emitLocalDealEvents(eventsToEmit, { officeId: officeId ?? "", userId });
    res.json(toJsonSafe({
      success: true,
      status: reservedDeal.rfpApprovalStatus ?? "pending_outbox",
      eventId,
      jobId,
    }));
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/cancel-rfp — escape hatch: clear all RFP request fields so the deal returns to plain Opportunity.
router.post("/:id/cancel-rfp", async (req, res, next) => {
  try {
    const dealId = req.params.id;
    const userRole = req.user!.role;
    const userId = req.user!.id;
    // Active-only, like other per-deal actions: a soft-deleted (is_active=false) deal must read as
    // not-found rather than letting cancel clear a deleted record's RFP fields + write a spurious audit.
    const [deal] = await req.tenantDb!
      .select()
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.isActive, true)))
      .limit(1);
    if (!deal) throw new AppError(404, "Deal not found.");

    const canCancel =
      userRole === "admin" || userRole === "director" ||
      (userRole === "rep" && deal.assignedRepId === userId);
    if (!canCancel) {
      throw new AppError(403, "Only the assigned rep, a director, or an admin can cancel a pending RFP.", "RFP_CANCEL_UNAUTHORIZED");
    }

    const stageSlug = await loadDealStageSlug(req.tenantDb!, deal.stageId);
    const canonicalStage = stageSlug ? toCanonicalDealStageSlug(stageSlug, deal.workflowRoute) : null;
    if (canonicalStage !== "opportunity" || deal.isBidBoardOwned) {
      throw new AppError(409, "This deal is no longer a pending RFP.", "RFP_CANCEL_WRONG_STATE");
    }
    if (
      pendingRfpSubStateForStatus(deal.rfpApprovalStatus) !== "attention" ||
      deal.rfpOverrideDecision === "denial_reconfirmed" ||
      deal.rfpOverrideState === "approving"
    ) {
      throw new AppError(409, "Only a declined, failed, or conflicting RFP can be returned to Opportunity.", "RFP_CANCEL_NOT_CANCELLABLE");
    }

    const previousStatus = deal.rfpApprovalStatus;
    // Re-bind the rep ownership in the atomic update: if the deal is reassigned between the check above and
    // here, a former-owner rep's cancel matches nothing and 409s instead of clearing another rep's RFP.
    const updated = await cancelPendingRfp(req.tenantDb!, deal.id, userRole === "rep" ? userId : undefined);
    if (!updated) {
      throw new AppError(409, "This deal's RFP state changed; nothing was cancelled.", "RFP_CANCEL_STALE");
    }

    await writeAuditLog(req.tenantDb!, {
      tableName: "deals",
      recordId: deal.id,
      action: "update",
      changedBy: userId,
      actorName: req.user!.displayName ?? req.user!.email ?? userId,
      actorRole: userRole,
      entityType: "deal",
      changes: { rfpApprovalStatus: { from: previousStatus, to: null } },
    });

    // Also record it on the deal's History/Timeline (deal_history) like the RFP decline + stage-change
    // flows, so the surface explains why the pending RFP disappeared (audit_log alone doesn't feed it).
    await req.tenantDb!.insert(dealHistory).values({
      dealId: deal.id,
      fieldName: "rfp_approval_status",
      oldValue: previousStatus ?? null,
      newValue: null,
      changedBy: userId,
      source: "rfp_cancel",
      reason: "Returned to Opportunity",
      changedAt: new Date(),
    });

    await req.commitTransaction!();
    res.json(toJsonSafe({ success: true, dealId: updated?.id ?? dealId }));
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/rfp-retry — enqueue a fresh RFP delivery job from the latest dead row.
router.post("/:id/rfp-retry", async (req, res, next) => {
  try {
    // A director can trigger an RFP office-wide, so they must also be able to retry one that lands in
    // send_failed — otherwise a director-triggered request on another rep's deal is unrecoverable (the
    // Retry button shows but 403s). Mirrors the trigger-rfp allowance; reps still need to own the deal.
    await assertDealOwnerRouteAccess(req, req.params.id, {
      allowAdmin: true,
      allowDirector: true,
      message: "Only the assigned rep, a director, or an admin can retry this RFP delivery",
    });
    const deal = await getDealById(
      req.tenantDb!,
      req.params.id,
      getCollaborativeReadRole(req.user!.role, "all"),
      req.user!.id
    );
    if (!deal) throw new AppError(404, "Deal not found");

    // Retry is a send-failed-only action; require the current state up front so a stale Retry click
    // (e.g. from another tab after the RFP was cancelled via Return to Opportunity) is rejected before
    // any work, instead of resurrecting a cleared RFP from its still-present dead job.
    if (deal.rfpApprovalStatus !== "send_failed") {
      throw new AppError(409, "This RFP is not in a failed state and cannot be retried.", "RFP_RETRY_WRONG_STATE");
    }

    // Voting-path deals (a 2/3-approved non-service RFP that has NO SyncHub request) fail on the
    // rfp_bidboard_create job, not the SyncHub rfp_request_delivery job — so their retry must re-enqueue the
    // Bid Board create (mirroring castRfpVote's approve path), never a SyncHub delivery. Their send_failed is
    // stamped with rfp_override_state='failed' (by both the bid-board-created failure callback and the create
    // dead-letter sweep, each scoped to rfp_approval_request_id IS NULL) — that pair (request_id NULL + a failed
    // override state) is what distinguishes a decided-vote create failure from a legacy delivery send_failed
    // (which leaves rfp_override_state NULL) and from an override-approve failure (which keeps a non-null id).
    const isVotingCreateFailure =
      deal.rfpApprovalRequestId == null && deal.rfpOverrideState === "failed";
    if (isVotingCreateFailure) {
      const officeId = req.user!.activeOfficeId ?? req.user!.officeId ?? null;
      // Atomically re-claim the failed state — clearing the failure markers back to the create-in-flight
      // 'pending' state castRfpVote's approve leaves (the same state the create dead-letter sweep re-catches on
      // a second failure) — BEFORE enqueuing, so a concurrent Return to Opportunity that clears the RFP fields
      // between the read and here (status no longer 'send_failed') matches nothing and 409s without resurrecting
      // it. Same transaction, so a later enqueue failure rolls the status back.
      const [reclaimed] = await req.tenantDb!
        .update(deals)
        .set({
          rfpApprovalStatus: "pending",
          rfpOverrideState: null,
          rfpOverrideError: null,
          // Stamp THIS retry as the current attempt (finding F4/F5). The failed callback + dead-letter sweep
          // ignore any 'failed'/dead signal older than this, so a late duplicate from the prior attempt can't
          // flip this fresh in-flight retry back to send_failed.
          // finding BC5: stamp with the transaction's now() (NOT a JS `new Date()`). The replacement
          // rfp_bidboard_create job is INSERTed in this same transaction with created_at = now() (its column
          // default), and the dead-letter sweep compares that created_at to this marker. A JS Date is computed
          // mid-transaction and is a few ms LATER than now() (the transaction-start timestamp), so created_at <
          // marker would make the sweep treat the retry's OWN dead job as stale and never surface send_failed.
          // Using now() makes the marker EQUAL the job's created_at, so the current attempt passes (>=) while a
          // prior attempt's older dead job is still correctly skipped.
          rfpBidboardAttemptAt: sql`now()`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(deals.id, deal.id),
            eq(deals.rfpApprovalStatus, "send_failed"),
            isNull(deals.rfpApprovalRequestId),
            eq(deals.rfpOverrideState, "failed"),
          )
        )
        .returning({ id: deals.id });
      if (!reclaimed) {
        throw new AppError(409, "This RFP is not in a failed state and cannot be retried.", "RFP_RETRY_WRONG_STATE");
      }
      await enqueueRfpBidBoardCreate({
        tenantDb: req.tenantDb!,
        deal: { id: deal.id },
        officeId,
      });
      await req.commitTransaction!();
      res.status(202).json({ success: true, status: "pending" });
      return;
    }

    // Voting INVITATION failure (finding H2): openRfpVoteRound reserved the round but the rfp_vote_invitation
    // email job dead-lettered, so runRfpVoteInvitationDeadLetterSweep stamped send_failed with rfp_override_state
    // NULL (distinct from a create failure's 'failed') + left the round event id. Distinguish it from a legacy
    // rfp_request_delivery failure by the dead job TYPE, then re-enqueue a fresh invitation for the SAME round —
    // no attempt marker (this isn't a Bid Board create). Without this the request-less send_failed would fall
    // through to the legacy path, find no rfp_request_delivery dead job, and 409 — the visible Retry would break.
    if (
      deal.rfpApprovalRequestId == null &&
      deal.rfpOverrideState == null &&
      deal.rfpApprovalRequestEventId != null
    ) {
      // finding W5: match the dead invitation to the deal's CURRENT round (payload roundEventId ==
      // rfpApprovalRequestEventId). Otherwise, after an OLD invitation failure was surfaced and the deal was
      // returned + re-triggered through the LEGACY delivery path, retrying that legacy send_failed could match
      // the stale dead invitation and misroute into re-enqueuing a vote invitation for a non-voting round.
      const deadInvite = await req.tenantDb!.execute(sql`
        SELECT id, payload->'recipients' AS recipients FROM public.job_queue
         WHERE job_type = 'rfp_vote_invitation' AND status = 'dead'
           AND payload->>'dealId' = ${deal.id}
           AND payload->>'roundEventId' = ${deal.rfpApprovalRequestEventId}
         ORDER BY id DESC
         LIMIT 1`);
      const deadInviteRows = (Array.isArray(deadInvite) ? deadInvite : (deadInvite as { rows?: unknown[] }).rows ?? []) as Array<{ recipients?: unknown }>;
      if (deadInviteRows.length > 0) {
        // finding: re-invite the ORIGINAL round's snapshotted voter set (the dead invitation's recipients), NOT a
        // re-resolution of the current RFP_VOTER_EMAILS. Since the invitation snapshot is what the cast route
        // authorizes against (BC2), re-deriving from a since-drifted env could make the round 2-of-4 or strand it.
        const originalRecipients = deadInviteRows[0]?.recipients;
        const retryRecipients = Array.isArray(originalRecipients)
          ? originalRecipients.map((e) => String(e)).filter((e) => e.length > 0)
          : undefined;
        const officeId = req.user!.activeOfficeId ?? req.user!.officeId ?? null;
        // Atomically re-claim send_failed -> the open 'pending' round state, clearing the surfaced error, BEFORE
        // re-enqueuing (so a concurrent Return to Opportunity that cleared the fields matches nothing and 409s).
        const [reclaimed] = await req.tenantDb!
          .update(deals)
          .set({ rfpApprovalStatus: "pending", rfpLastAttemptError: null, updatedAt: new Date() })
          .where(
            and(
              eq(deals.id, deal.id),
              eq(deals.rfpApprovalStatus, "send_failed"),
              isNull(deals.rfpApprovalRequestId),
              isNull(deals.rfpOverrideState),
              // finding: bind the reclaim to the CURRENT round event id. Otherwise a stale Retry racing with a
              // Return-to-Opportunity + a fresh round that ALSO surfaced send_failed could reclaim the NEW round and
              // re-enqueue an invitation stamped with the OLD roundEventId (which the dead-letter sweep then ignores
              // as stale), leaving the current round stranded. deal.rfpApprovalRequestEventId is non-null here.
              eq(deals.rfpApprovalRequestEventId, deal.rfpApprovalRequestEventId!),
            )
          )
          .returning({ id: deals.id });
        if (!reclaimed) {
          throw new AppError(409, "This RFP is not in a failed state and cannot be retried.", "RFP_RETRY_WRONG_STATE");
        }
        await enqueueRfpVoteInvitation({
          tenantDb: req.tenantDb!,
          deal: {
            id: deal.id,
            dealNumber: deal.dealNumber ?? null,
            name: deal.name ?? null,
            rfpApprovalRequestEventId: deal.rfpApprovalRequestEventId,
          },
          officeId,
          recipients: retryRecipients,
        });
        await req.commitTransaction!();
        res.status(202).json({ success: true, status: "pending" });
        return;
      }
    }

    const deadJobResult = await req.tenantDb!.execute(sql`
      SELECT id, payload
        FROM public.job_queue
       WHERE job_type = 'rfp_request_delivery'
         AND status = 'dead'
         AND payload->>'dealId' = ${deal.id}
       ORDER BY created_at DESC
       LIMIT 1
    `);
    const rows = Array.isArray(deadJobResult) ? deadJobResult : deadJobResult.rows ?? [];
    const deadJob = rows[0] as { id: number; payload: RfpRequestDeliveryPayload } | undefined;
    if (!deadJob) {
      throw new AppError(404, "No failed RFP delivery job found for this deal");
    }

    // A dead job has exhausted all auto-retries, so a manual retry can land
    // well past the attachments' presigned-URL TTL. Re-mint the URLs here (the
    // retry is effectively a re-enqueue) so the job doesn't carry dead links.
    const freshAttachments = await loadRfpAttachmentsForDeal(req.tenantDb!, deal.id);
    const payload: RfpRequestDeliveryPayload = {
      ...deadJob.payload,
      syncHubUrl: resolveSyncHubRfpRequestUrl(),
      body: { ...deadJob.payload.body, attachments: freshAttachments },
    };
    delete payload.dealHandled;
    // Atomically re-claim the send-failed state BEFORE enqueuing, so a Return to Opportunity that lands
    // between the read above and here (clearing the RFP fields but leaving the dead job) can't have this
    // retry resurrect the cancelled RFP: if the status already changed, nothing matches and we 409
    // without enqueuing. Same transaction, so a later insert failure rolls the status back.
    const [reclaimed] = await req.tenantDb!
      .update(deals)
      .set({
        rfpApprovalStatus: "pending_outbox",
        rfpLastAttemptError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(deals.id, deal.id), eq(deals.rfpApprovalStatus, "send_failed")))
      .returning({ id: deals.id });
    if (!reclaimed) {
      throw new AppError(409, "This RFP is not in a failed state and cannot be retried.", "RFP_RETRY_WRONG_STATE");
    }
    await req.tenantDb!.insert(jobQueue).values({
      jobType: "rfp_request_delivery",
      payload,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      status: "pending",
      attempts: 0,
      runAfter: new Date(),
      maxAttempts: 8,
    });

    await req.commitTransaction!();
    res.status(202).json({ success: true, status: "pending_outbox" });
  } catch (err) {
    next(err);
  }
});

// Optional reviewer note: trim, treat blank as absent, cap length so it fits the history/audit columns.
function normalizeRfpOverrideNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 2000);
}

// Map an override-approval failure to an AppError. Thrown by the route so the tenant transaction rolls back the
// 'approving' write — leaving the deal declined + retryable — and surfaces a clear reason to the reviewer.
function mapOverrideApprovalFailure(result: Extract<RfpOverrideApprovalResult, { ok: false }>): AppError {
  switch (result.reason) {
    case "not_actionable":
      return new AppError(
        409,
        "This RFP is no longer awaiting review (it was already approved, is being approved, or was re-confirmed).",
        "RFP_OVERRIDE_NOT_ACTIONABLE"
      );
    case "missing_request_id":
      return new AppError(
        409,
        "No SyncHub RFP request is linked to this deal, so it can't be override-approved.",
        "RFP_OVERRIDE_NO_REQUEST"
      );
    case "synchub_rejected":
      return new AppError(
        result.syncHubStatus === 404 ? 409 : result.syncHubStatus === 409 ? 409 : 502,
        `SyncHub could not approve this RFP: ${result.message}. The deal's state may have changed (e.g. no longer in Opportunity, or already linked).`,
        "RFP_OVERRIDE_SYNCHUB_REJECTED"
      );
    case "synchub_unavailable":
      return new AppError(
        502,
        "Couldn't reach SyncHub to start the Bid Board project. Please retry.",
        "RFP_OVERRIDE_SYNCHUB_UNAVAILABLE"
      );
  }
}

// --- RFP override second-look review (gated to the designated reviewers: Takashi + Adam) ---
// These three routes are reached from the "Review & Decide" link in the RFP-decline email. requireRfpReviewer
// restricts them to the RFP_REJECTION_EMAIL_RECIPIENTS allowlist; a regular admin/director gets 403.

// GET /api/deals/:id/rfp-review — page data for the override-review surface.
router.get("/:id/rfp-review", requireRfpReviewer, async (req, res, next) => {
  try {
    const detail = await getRfpReviewDetail(req.tenantDb!, req.params.id as string);
    if (!detail) throw new AppError(404, "Deal not found");
    await req.commitTransaction!();
    res.json({ review: detail });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/rfp-vote — cast a three-voter RFP vote (Sidney / Tim / James). 2-of-3 decides. Reject
// requires a reason; approve ignores it. Voter authorization is done IN-HANDLER (finding BC2), NOT via the
// requireRfpVoter middleware: for an open round the round's invitation SNAPSHOT is authoritative, so a voter who
// was invited when the round opened can still cast even if RFP_VOTER_EMAILS changed since. The env allowlist is
// the fallback only when no snapshot exists (legacy round / pruned job).
router.post("/:id/rfp-vote", async (req, res, next) => {
  try {
    const decision = req.body?.decision;
    if (decision !== "approve" && decision !== "reject") {
      throw new AppError(400, "decision must be 'approve' or 'reject'.", "RFP_VOTE_DECISION_INVALID");
    }
    const rawReason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (decision === "reject" && rawReason.length === 0) {
      throw new AppError(400, "A reason is required to reject an RFP.", "RFP_VOTE_REASON_REQUIRED");
    }
    const deal = await loadTriggerRfpDeal(req.tenantDb!, req.params.id as string);
    // Treat a soft-deleted (is_active=false) deal as not-found: loadTriggerRfpDeal has no is_active filter, so
    // without this a deleted CRM deal could still be voted on → an approve enqueues rfp_bidboard_create, and the
    // bid-board-created callback (findDeal filters is_active=true) can never reconcile it, spawning a Bid Board
    // project for a deal that no longer exists. loadTriggerRfpDeal selects the full row, so isActive is present.
    if (!deal || deal.isActive === false) throw new AppError(404, "Deal not found");
    if (isServiceRfp(deal)) {
      throw new AppError(409, "Service RFPs are not decided by vote.", "RFP_VOTE_NOT_APPLICABLE");
    }
    const isOpenVoteRound =
      deal.rfpApprovalRequestEventId != null &&
      deal.rfpApprovalStatus === "pending" &&
      deal.rfpApprovalRequestId == null;
    // Flag-gate the cast, but ONLY for a deal that is NOT already in an open vote round (finding W7). The gate
    // exists so a voter can't cast on a legacy non-service deal during the rollout window (RFP_VOTER_EMAILS set,
    // ENABLE_RFP_VOTING off) — firing a double escalation + premature create. An ALREADY-open round was opened
    // while the flag was on, so keep it votable even after the flag is flipped off as the rollback lever;
    // otherwise those in-flight rounds strand ('pending' isn't a cancellable attention state).
    if (!isRfpVotingEnabled() && !isOpenVoteRound) {
      throw new AppError(503, "RFP voting is not enabled.", "RFP_VOTING_DISABLED");
    }
    if (!isOpenVoteRound) {
      throw new AppError(409, "This deal is not in an open RFP vote round.", "RFP_NO_VOTE_ROUND");
    }
    // finding Y8: authorize the cast against the round's INVITED voter set (snapshotted into the
    // rfp_vote_invitation job when the round opened), not the current mutable RFP_VOTER_EMAILS the requireRfpVoter
    // middleware checks. If the env changed while the round was pending, a newly-added 4th address must not cast a
    // deciding 2-of-3 vote for a round it was never invited to. Falls back to the env gate (already passed) only
    // if no snapshot is found (a legacy round or a pruned job).
    const inviteSnap = await req.tenantDb!.execute(sql`
      SELECT payload->'recipients' AS recipients
        FROM public.job_queue
       WHERE job_type = 'rfp_vote_invitation'
         AND payload->>'dealId' = ${deal.id}
         AND payload->>'roundEventId' = ${deal.rfpApprovalRequestEventId}
       ORDER BY id DESC
       LIMIT 1`);
    const inviteRows = Array.isArray(inviteSnap) ? inviteSnap : (inviteSnap as { rows?: any[] }).rows ?? [];
    const snapshot = inviteRows[0]?.recipients;
    if (Array.isArray(snapshot) && snapshot.length > 0) {
      // Snapshot-backed round: the round's OWN invited set is authoritative — a voter invited when the round
      // opened can still cast even after RFP_VOTER_EMAILS changed (finding BC2), and a since-added address that was
      // never invited cannot cast a deciding 2-of-3. This supersedes the env allowlist for open rounds.
      const invited = snapshot.map((e: unknown) => String(e).trim().toLowerCase());
      if (!invited.includes((req.user!.email ?? "").trim().toLowerCase())) {
        throw new AppError(403, "You were not one of the invited voters for this RFP round.", "RFP_VOTE_NOT_INVITED");
      }
    } else if (!isRfpVoterEmail(req.user!.email, process.env)) {
      // No snapshot (a legacy round or a pruned invitation job): fall back to the current env allowlist — the same
      // gate the removed requireRfpVoter middleware enforced, replicated here so the snapshot can take precedence.
      throw new AppError(403, "Only the designated RFP voters can vote on RFPs.", "RFP_VOTER_ONLY");
    }
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId ?? null;
    const result = await castRfpVote({
      tenantDb: req.tenantDb!,
      officeId,
      deal,
      voter: { userId: req.user!.id, email: req.user!.email },
      decision,
      reason: decision === "reject" ? rawReason : null,
    });
    await req.commitTransaction!();
    res.json(toJsonSafe({ success: true, outcome: result.outcome, votes: result.votes }));
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/rfp-override/approve — override the no-go: ask SyncHub to authoritatively approve the
// declined RFP, which creates the Bid Board project (Playwright) and calls back bid-board-created. The deal is
// parked in rfp_override_state='approving' until that callback lands.
router.post("/:id/rfp-override/approve", requireRfpReviewer, async (req, res, next) => {
  try {
    // Gated on the same flag as the initial RFP trigger: if the RFP pipeline is disabled there is no SyncHub
    // integration to approve through.
    if (!isOpportunityRfpEventEnabled()) {
      throw new AppError(503, "Opportunity RFP delivery is disabled.", "RFP_EVENT_DISABLED");
    }
    const result = await requestOverrideApproval({
      tenantDb: req.tenantDb!,
      dealId: req.params.id as string,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId ?? null,
      actor: { userId: req.user!.id, name: req.user!.displayName, role: req.user!.role },
      approverEmail: req.user!.email, // named accountability — the reviewer's real email is the SyncHub approver
      note: normalizeRfpOverrideNote(req.body?.note),
    });
    if (!result.ok) {
      // Nothing should persist on failure — throw so the tenant transaction rolls back the 'approving' write.
      throw mapOverrideApprovalFailure(result);
    }
    await req.commitTransaction!();
    res.json({ success: true, status: result.status, requestId: result.requestId, unconfirmed: result.unconfirmed ?? false });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/rfp-override/reconfirm-decline — uphold the no-go (stays declined, marked reviewed).
router.post("/:id/rfp-override/reconfirm-decline", requireRfpReviewer, async (req, res, next) => {
  try {
    const result = await reconfirmRfpDecline({
      tenantDb: req.tenantDb!,
      dealId: req.params.id as string,
      actor: { userId: req.user!.id, name: req.user!.displayName, role: req.user!.role },
      note: normalizeRfpOverrideNote(req.body?.note),
    });
    if (!result.ok) {
      throw new AppError(
        409,
        "This RFP is no longer awaiting review (it was already approved, re-submitted, or re-confirmed).",
        "RFP_OVERRIDE_NOT_ACTIONABLE"
      );
    }
    await req.commitTransaction!();
    res.json({ success: true, status: result.status, decision: result.decision });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/scoping-intake — load or initialize scoping intake
router.get("/:id/scoping-intake", async (req, res, next) => {
  try {
    await assertDealOwnerRouteAccess(req, req.params.id);
    const result = await getOrCreateDealScopingIntake(req.tenantDb!, req.params.id, req.user!.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/scoping-intake — autosave scoping intake
router.patch("/:id/scoping-intake", async (req, res, next) => {
  try {
    await assertDealOwnerRouteAccess(req, req.params.id);
    const patch = { ...req.body };
    delete patch.workflowRoute;

    const result = await upsertDealScopingIntake(req.tenantDb!, req.params.id, patch, req.user!.id);
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    const eventsToEmit: Array<{ name: string; payload: Record<string, unknown> }> = [];

    if (result.previousStatus !== result.readiness.status) {
      const payload = {
        dealId: req.params.id,
        intakeId: result.intake.id,
        workflowRoute: result.intake.workflowRouteSnapshot,
        status: result.readiness.status,
        editedBy: req.user!.id,
      };

      if (result.readiness.status === "ready") {
        await queueDomainEvent(req.tenantDb! as any, officeId, "scoping_intake.ready", payload);
        eventsToEmit.push({ name: "scoping_intake.ready", payload });
      }

      if (result.previousStatus === "activated" && result.readiness.status === "draft") {
        await queueDomainEvent(req.tenantDb! as any, officeId, "scoping_intake.reopened", payload);
        eventsToEmit.push({ name: "scoping_intake.reopened", payload });
      }
    }

    await req.commitTransaction!();
    emitLocalDealEvents(eventsToEmit, {
      officeId,
      userId: req.user!.id,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/resolved-fields — write lineage-routed deal fields
router.patch("/:id/resolved-fields", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);
    const patch = { ...(req.body ?? {}) };
    const forceEditAfterRfp = patch.forceEditAfterRfp === true;
    delete patch.forceEditAfterRfp;

    const dealBaseline =
      Object.keys(patch).length > 0
        ? await getDealById(req.tenantDb!, req.params.id, getCollaborativeReadRole(req.user!.role, "mine"), req.user!.id)
        : null;
    const hasLockedResolvedFieldCandidates = Object.keys(patch).some((field) =>
      SCOPE_LOCKED_RESOLVED_FIELDS.has(field)
    );
    const existingResolved = hasLockedResolvedFieldCandidates
      ? await loadLockedResolvedFieldComparisonBaseline(req.tenantDb!, req.params.id)
      : {};
    const cleanupBaseline = {
      ...((dealBaseline ?? {}) as Record<string, unknown>),
      ...existingResolved,
    };
    const isLegacyCleanupPatch =
      shouldTreatPatchAsLegacyCleanup(
        patch,
        req.user!.role,
        cleanupBaseline
      ) &&
      hasCompleteLegacyCleanupRelationships(patch, cleanupBaseline);
    const scopeLockedFields = getLockedResolvedFieldsRequiringScopeGuard(patch, existingResolved);
    const writePolicy = scopeLockedFields.length > 0
      ? await assertDealScopingWriteAllowed(req.tenantDb!, req.params.id, {
          role: req.user!.role,
          forceEditAfterRfp,
          ...(isLegacyCleanupPatch ? { cleanupMode: true } : {}),
        })
      : null;

    assertResolvedRelationshipLineagePolicy(patch, existingResolved);
    await assertResolvedRelationshipConsistency(req.tenantDb!, patch, existingResolved);

    const resolved = await writeResolvedDealFields(req.tenantDb!, req.params.id, patch, {
      userId: req.user!.id,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      role: req.user!.role,
    });
    if (isLegacyCleanupPatch) {
      await writeLegacyCleanupScopeAuditLog(req, "resolved-fields", cleanupBaseline, patch);
    }
    if (writePolicy?.adminOverride) {
      await writeAuditLog(req.tenantDb!, {
        tableName: "deal_scoping_intake",
        recordId: req.params.id,
        action: "update",
        changedBy: req.user!.id,
        changes: Object.fromEntries(
          scopeLockedFields.map((field) => [
            field,
            { from: null, to: "[admin override]" },
          ])
        ),
        fullRow: {
          override: "admin_force_edit_after_rfp",
          route: "resolved-fields",
          fields: scopeLockedFields,
          reason: writePolicy.lockState.reason,
          submittedAt: writePolicy.lockState.submittedAt instanceof Date
            ? writePolicy.lockState.submittedAt.toISOString()
            : writePolicy.lockState.submittedAt,
        },
      });
    }
    await req.commitTransaction!();
    res.json({ resolved });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/scoping-intake/readiness — evaluate current readiness
router.get("/:id/scoping-intake/readiness", async (req, res, next) => {
  try {
    // Readiness gate for the Trigger RFP button. Admins and directors observe it office-wide (mirroring
    // who can trigger the RFP); reps still need to own the deal. Without the director allowance the new
    // director button would render but stay permanently disabled (this GET would 403 → draft).
    const dealAccess = await assertDealOwnerRouteAccess(req, req.params.id, { allowAdmin: true, allowDirector: true });
    // evaluateDealScopingReadiness writes by default (auto-links attachments, persists readiness). A
    // non-owner (elevated director/admin) is only OBSERVING the gate, so force read-only — a passive
    // page-load must never mutate the owning rep's scoping intake. The owner keeps the persist behavior.
    const viewerOwnsDeal = dealAccess.assignedRepId === req.user!.id;
    const readiness = await evaluateDealScopingReadiness(req.tenantDb!, req.params.id, {
      readOnly: !viewerOwnsDeal,
    });
    await req.commitTransaction!();
    res.json({ readiness });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/scoping-intake/attachments/link-existing — reuse an existing deal file
router.post("/:id/scoping-intake/attachments/link-existing", async (req, res, next) => {
  try {
    await assertDealCollaboratorAccess(req.tenantDb!, req.params.id, req.user!);
    const { fileId, intakeSection, intakeRequirementKey } = req.body;

    if (!fileId || !intakeSection || !intakeRequirementKey) {
      throw new AppError(400, "fileId, intakeSection, and intakeRequirementKey are required");
    }

    const file = await linkDealFileToScopingRequirement(
      req.tenantDb!,
      req.params.id,
      {
        fileId,
        intakeSection,
        intakeRequirementKey,
        forceEditAfterRfp: req.body?.forceEditAfterRfp === true,
      },
      req.user!.id
    );
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    const payload = {
      dealId: req.params.id,
      fileId: file.id,
      intakeSection: file.intakeSection,
      intakeRequirementKey: file.intakeRequirementKey,
      linkedBy: req.user!.id,
    };
    await queueDomainEvent(
      req.tenantDb! as any,
      officeId,
      "scoping_intake.attachment.added",
      payload
    );

    await req.commitTransaction!();
    emitLocalDealEvents(
      [{ name: "scoping_intake.attachment.added", payload }],
      { officeId, userId: req.user!.id }
    );
    res.json({ file });
  } catch (err) {
    next(err);
  }
});

function validateDealPayload(body: Record<string, unknown>): void {
  const MAX_MONEY = 999999999;
  for (const field of ["ddEstimate", "bidEstimate", "awardedAmount"] as const) {
    const val = body[field];
    if (val != null && val !== "") {
      const n = Number(val);
      if (isNaN(n) || n < 0) throw new AppError(400, `${field} must be >= 0`);
      if (n > MAX_MONEY) throw new AppError(400, `${field} must not exceed ${MAX_MONEY}`);
    }
  }
  if (body.winProbability != null && body.winProbability !== "") {
    const wp = Number(body.winProbability);
    if (isNaN(wp) || wp < 0 || wp > 100) {
      throw new AppError(400, "winProbability must be between 0 and 100");
    }
  }
  if (body.onHold !== undefined && typeof body.onHold !== "boolean") {
    throw new AppError(400, "onHold must be a boolean");
  }
  if (body.bidDueDate != null && body.bidDueDate !== "") {
    if (typeof body.bidDueDate !== "string") {
      throw new AppError(400, "bidDueDate must be an ISO date in YYYY-MM-DD format");
    }

    const trimmed = body.bidDueDate.trim();
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
  }
  validateProjectNumberPayload(body);
}

function validateProjectNumberPayload(body: Record<string, unknown>): void {
  if (!Object.prototype.hasOwnProperty.call(body, "projectNumber")) return;

  try {
    body.projectNumber = normalizeProjectNumberInput(body.projectNumber);
  } catch (err) {
    if (err instanceof ProjectNumberValidationError) {
      throw new AppError(400, err.message, err.code);
    }
    throw err;
  }
}

function assertProjectNumberMutationAllowed(body: Record<string, unknown>, role: string): void {
  if (!Object.prototype.hasOwnProperty.call(body, "projectNumber")) return;
  if (role === "admin" || role === "director") return;
  throw new AppError(
    403,
    "Only admins or directors can set or clear project numbers.",
    "PROJECT_NUMBER_UPDATE_FORBIDDEN"
  );
}

function normalizeServiceCandidate(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

async function resolveServiceProjectType(projectTypeId: unknown, projectType: unknown) {
  const projectTypes = await getActiveProjectTypes();
  const serviceType = projectTypes.find((entry) => normalizeServiceCandidate(entry.slug) === "service") ??
    projectTypes.find((entry) => normalizeServiceCandidate(entry.name) === "service");

  if (!serviceType) {
    throw new AppError(500, "Service project type is not configured.");
  }

  if (projectTypeId != null && projectTypeId !== "") {
    const selected = projectTypes.find((entry) => entry.id === projectTypeId);
    if (!selected || normalizeServiceCandidate(selected.slug || selected.name) !== "service") {
      throw new AppError(400, "Direct-create is only available for Service projects.");
    }
  }

  if (projectType != null && projectType !== "" && normalizeServiceCandidate(projectType) !== "service") {
    throw new AppError(400, "Direct-create is only available for Service projects.");
  }

  return serviceType;
}

async function assertServiceOpportunityHierarchy(
  tenantDb: Parameters<typeof createDeal>[0],
  input: { companyId: string; propertyId: string }
) {
  const companyRows = await tenantDb
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, input.companyId), eq(companies.isActive, true)))
    .limit(1);
  const propertyRows = await tenantDb
    .select({ id: properties.id, companyId: properties.companyId })
    .from(properties)
    .where(and(eq(properties.id, input.propertyId), eq(properties.isActive, true)))
    .limit(1);

  const company = companyRows[0] ?? null;
  if (!company) {
    throw new AppError(400, "Company not found");
  }

  const property = propertyRows[0] ?? null;
  if (!property) {
    throw new AppError(400, "Property not found");
  }

  if (property.companyId !== input.companyId) {
    throw new AppError(400, "Property does not belong to the company");
  }
}

// POST /api/deals/service-opportunity — direct-create a Service-only Opportunity.
router.post("/service-opportunity", async (req, res, next) => {
  try {
    const body = { ...req.body };
    validateDealPayload(body);
    assertProjectNumberMutationAllowed(body, req.user!.role);

    const {
      name,
      assignedRepId,
      companyId,
      propertyId,
      primaryContactId,
      description,
      source,
      winProbability,
      regionId,
      expectedCloseDate,
      bidDueDate,
      projectTypeId,
      projectType,
      officeCode,
      projectNumber,
    } = body;
    if (!name) {
      throw new AppError(400, "Name is required");
    }
    if (!companyId || !propertyId) {
      throw new AppError(400, "Company and property are required");
    }
    await assertServiceOpportunityHierarchy(req.tenantDb!, { companyId, propertyId });

    const serviceProjectType = await resolveServiceProjectType(projectTypeId, projectType);
    const opportunityStage = await getStageBySlug("opportunity", "standard_deal");
    if (!opportunityStage) {
      throw new AppError(500, "Canonical opportunity stage config is incomplete");
    }

    let repId: string;
    if (req.user!.role === "rep") {
      repId = req.user!.id;
    } else {
      repId = assignedRepId || req.user!.id;
    }

    const officeCodeResolution = resolveDealCreateOfficeCode({
      requestedOfficeCode: officeCode,
      officeSlug: req.officeSlug,
    });
    if ("error" in officeCodeResolution) {
      throw new AppError(400, officeCodeResolution.error);
    }

    const deal = await createDeal(req.tenantDb!, {
      name,
      assignedRepId: repId,
      actorUserId: req.user!.id,
      actorRole: req.user!.role,
      officeId: req.user!.activeOfficeId,
      creationContext: "direct",
      // RFP eligibility for direct-created Service opportunities depends on
      // the service workflow route. The RFP request/status fields intentionally
      // remain null until the normal Trigger RFP path reserves the request.
      stageId: opportunityStage.id,
      primaryContactId,
      companyId,
      propertyId,
      description,
      source,
      winProbability,
      regionId,
      bidDueDate,
      expectedCloseDate,
      workflowRoute: "service",
      projectType: "service",
      projectTypeId: serviceProjectType.id,
      projectNumber,
      officeCode: officeCodeResolution.officeCode,
      auditContext: buildRouteAuditContext(req),
    });
    await req.commitTransaction!();
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.status(201).json({ deal: redactDealResponse(deal, { includeHubspotId }) });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals — create a new deal
router.post("/", async (req, res, next) => {
  try {
    const body = { ...req.body };
    validateDealPayload(body);
    assertProjectNumberMutationAllowed(body, req.user!.role);

    const {
      name,
      stageId,
      assignedRepId,
      creationContext: _creationContext,
      sourceLeadWriteMode: _sourceLeadWriteMode,
      migrationMode: _migrationMode,
      // Estimator is a commission-attribution field that may ONLY be set through the dedicated,
      // leadership-gated PATCH /:id/estimator route (which audits the change and re-attributes the
      // estimator commission row). Pull it out of `...rest` so a create payload can never smuggle it
      // in — the server createDeal insert already ignores it, but this keeps create a strict no-write
      // path for estimator even if that insert ever changes (matches updateDeal's allowlist exclusion
      // and the client-side WritableDealFields Omit). estimatorUserName is a read-only display alias.
      estimatorUserId: _estimatorUserId,
      estimatorUserName: _estimatorUserName,
      ...rest
    } = body;
    if (!name || !stageId) {
      throw new AppError(400, "Name and stageId are required");
    }

    // Rep ownership enforcement:
    // - Reps: force assignedRepId to their own ID (ignore request body value)
    // - Directors/admins: can assign to any user
    let repId: string;
    if (req.user!.role === "rep") {
      repId = req.user!.id; // reps always own their own deals
    } else {
      repId = assignedRepId || req.user!.id;
    }

    const officeCodeResolution = resolveDealCreateOfficeCode({
      requestedOfficeCode: rest.officeCode,
      officeSlug: req.officeSlug,
    });
    if ("error" in officeCodeResolution) {
      throw new AppError(400, officeCodeResolution.error);
    }

    const deal = await createDeal(req.tenantDb!, {
      name,
      stageId,
      assignedRepId: repId,
      actorUserId: req.user!.id,
      actorRole: req.user!.role,
      officeId: req.user!.activeOfficeId,
      creationContext: "direct",
      ...rest,
      officeCode: officeCodeResolution.officeCode,
      auditContext: buildRouteAuditContext(req),
    });
    await req.commitTransaction!();
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.status(201).json({ deal: redactDealResponse(deal, { includeHubspotId }) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/contract-signed-date — set or clear contract signed date
// Admin/director only. Audit log row written on every transition.
router.patch(
  "/:id/contract-signed-date",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const raw = req.body?.date;
      let date: string | null = null;
      if (raw == null || raw === "") {
        date = null;
      } else if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
        date = raw.trim();
      } else {
        throw new AppError(422, "date must be YYYY-MM-DD or null");
      }
      const deal = await setDealContractSignedDate(
        req.tenantDb!,
        req.params.id as string,
        date,
        req.user!.id,
        req.user!.activeOfficeId ?? req.user!.officeId,
        buildRouteAuditContext(req)
      );
      if (!deal) throw new AppError(404, "Deal not found");
      await req.commitTransaction!();
      const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
      res.json({ deal: redactDealResponse(deal, { includeHubspotId }) });
    } catch (err) { next(err); }
  }
);

// PATCH /api/deals/:id/estimator — set or clear the deal's estimator.
// Admin/director ONLY, and on a DEDICATED route on purpose: estimator is deliberately OUT of
// updateDeal's allowlist so it can NEVER be set through the generic PATCH /:id (which the assigned
// rep can reach) — editing the estimator re-attributes the additive estimator commission row and
// must stay leadership-gated. setDealEstimator rejects change-order children (409
// CHANGE_ORDER_FIELD_LOCKED, mapped through here automatically by the AppError error handler).
router.patch(
  "/:id/estimator",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      // Per-deal access gate (parity with PATCH /:id and the change-order routes): estimator is a
      // commission-attribution mutation, so prove the caller can reach THIS specific deal — its
      // office/scope — before any read or write, for EVERY request shape (set / no-op / explicit
      // null-clear). requireRole above only proves leadership in the abstract; this binds it to the
      // deal, so a leader acting on a deal outside their accessible scope is rejected here (404/403)
      // before setDealEstimator runs — not left to the service's later existence check.
      await assertDealRouteAccess(req, req.params.id as string);

      // Distinguish an ABSENT field from an explicit null: a `{}` (or estimator-less) body must NOT
      // silently CLEAR the estimator — that requires an explicit `estimatorUserId: null`. An omitted
      // key is a client bug, so reject it (422) rather than wiping commission attribution by accident.
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!("estimatorUserId" in body)) {
        throw new AppError(422, "estimatorUserId is required (send null to clear the estimator)");
      }
      const raw = body.estimatorUserId;
      let estimatorUserId: string | null;
      if (raw == null || raw === "") {
        estimatorUserId = null;
      } else if (
        typeof raw === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.trim())
      ) {
        estimatorUserId = raw.trim();
      } else {
        throw new AppError(422, "estimatorUserId must be a valid UUID or null");
      }
      const deal = await setDealEstimator(
        req.tenantDb!,
        req.params.id as string,
        estimatorUserId,
        req.user!.id,
        req.user!.activeOfficeId ?? req.user!.officeId
      );
      if (!deal) throw new AppError(404, "Deal not found");
      await req.commitTransaction!();
      const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
      res.json({ deal: redactDealResponse(deal, { includeHubspotId }) });
    } catch (err) {
      next(err);
    }
  }
);

// ===== CRM change orders (dated value records added to Won / Bid-Board-Owned deals) =====
// Distinct from the Procore-synced `change_orders` table; never synced out. Mutations are
// admin-only; the amount is positive-only and the parent deal must be Won / Bid-Board-Owned
// (both enforced in change-order-service).

// GET /api/deals/:id/scorecards — list the Field Scorecards submitted for this deal (T-Rock Cam)
router.get("/:id/scorecards", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);
    const result = await listDealScorecards(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/scorecards/:scorecardId — one scorecard's full detail (items, deficiencies, action
// items, evidence photos with presigned URLs)
router.get("/:id/scorecards/:scorecardId", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);
    const scorecard = await getDealScorecardDetail(req.tenantDb!, req.params.id, req.params.scorecardId, {
      resolvePhotoUrl: (fileId) =>
        getFileDownloadUrl(req.tenantDb!, fileId)
          .then((r) => r.url)
          .catch(() => null),
    });
    await req.commitTransaction!();
    res.json({ scorecard });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/scorecards/:scorecardId/download — presigned URL for the scorecard's stored PDF
router.get("/:id/scorecards/:scorecardId/download", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);
    const result = await getDealScorecardPdfDownload(req.tenantDb!, req.params.id, req.params.scorecardId);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/description-history — the deal's description change-log (newest first)
router.get("/:id/description-history", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);
    // Mirror /detail's soft-delete hiding: a deactivated (is_active=false) deal 404s there via getDealById's
    // active filter, so its description audit trail must not be reachable here either.
    const [active] = await req.tenantDb!
      .select({ isActive: deals.isActive })
      .from(deals)
      .where(eq(deals.id, req.params.id))
      .limit(1);
    if (!active || active.isActive === false) throw new AppError(404, "Deal not found");
    const history = await listDealDescriptionHistory(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ history });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/change-orders — list a deal's CRM change orders + their sum
router.get("/:id/change-orders", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);
    const changeOrders = await listDealChangeOrders(req.tenantDb!, req.params.id);
    const total = await sumDealChangeOrders(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ changeOrders, total });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/change-orders — add a CRM change order (admin only)
router.post("/:id/change-orders", requireRole("admin"), async (req, res, next) => {
  try {
    const dealId = req.params.id as string;
    await assertDealRouteAccess(req, dealId);
    const changeOrder = await addDealChangeOrder(req.tenantDb!, {
      dealId,
      signedDate: req.body?.signedDate,
      amount: req.body?.amount,
      description: req.body?.description,
      createdBy: req.user!.id,
    });
    await writeAuditLog(req.tenantDb!, {
      tableName: "deal_change_orders",
      recordId: changeOrder.id,
      action: "insert",
      changedBy: req.user!.id,
      actorName: req.user!.displayName ?? req.user!.email ?? req.user!.id,
      actorRole: req.user!.role,
      entityType: "deal_change_order",
      changes: {
        amount: { from: null, to: changeOrder.amount },
        signedDate: { from: null, to: changeOrder.signedDate },
        description: { from: null, to: changeOrder.description },
      },
      fullRow: { dealId },
      ipAddress: req.ip ?? null,
      userAgent: buildRouteAuditContext(req).userAgent,
    });
    await req.commitTransaction!();
    res.status(201).json({ changeOrder });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/change-orders/:changeOrderId — edit a CRM change order (admin only)
router.patch("/:id/change-orders/:changeOrderId", requireRole("admin"), async (req, res, next) => {
  try {
    const dealId = req.params.id as string;
    const changeOrderId = req.params.changeOrderId as string;
    await assertDealRouteAccess(req, dealId);
    const before = await getDealChangeOrderById(req.tenantDb!, changeOrderId, dealId);
    const changeOrder = await updateDealChangeOrder(req.tenantDb!, {
      id: changeOrderId,
      dealId,
      signedDate: req.body?.signedDate,
      amount: req.body?.amount,
      description: req.body?.description,
      updatedBy: req.user!.id,
    });
    // Audit only the fields the request actually sent, with their true before -> after values.
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (req.body?.amount !== undefined) {
      changes.amount = { from: before?.amount ?? null, to: changeOrder.amount };
    }
    if (req.body?.signedDate !== undefined) {
      changes.signedDate = { from: before?.signedDate ?? null, to: changeOrder.signedDate };
    }
    if (req.body?.description !== undefined) {
      changes.description = { from: before?.description ?? null, to: changeOrder.description };
    }
    await writeAuditLog(req.tenantDb!, {
      tableName: "deal_change_orders",
      recordId: changeOrder.id,
      action: "update",
      changedBy: req.user!.id,
      actorName: req.user!.displayName ?? req.user!.email ?? req.user!.id,
      actorRole: req.user!.role,
      entityType: "deal_change_order",
      changes,
      fullRow: { dealId },
      ipAddress: req.ip ?? null,
      userAgent: buildRouteAuditContext(req).userAgent,
    });
    await req.commitTransaction!();
    res.json({ changeOrder });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/deals/:id/change-orders/:changeOrderId — remove a CRM change order (admin only)
router.delete("/:id/change-orders/:changeOrderId", requireRole("admin"), async (req, res, next) => {
  try {
    const dealId = req.params.id as string;
    const changeOrderId = req.params.changeOrderId as string;
    await assertDealRouteAccess(req, dealId);
    const removed = await deleteDealChangeOrder(req.tenantDb!, {
      id: changeOrderId,
      dealId,
      deletedBy: req.user!.id,
    });
    await writeAuditLog(req.tenantDb!, {
      tableName: "deal_change_orders",
      recordId: changeOrderId,
      action: "delete",
      changedBy: req.user!.id,
      actorName: req.user!.displayName ?? req.user!.email ?? req.user!.id,
      actorRole: req.user!.role,
      entityType: "deal_change_order",
      changes: {
        amount: { from: removed.amount, to: null },
        signedDate: { from: removed.signedDate, to: null },
        description: { from: removed.description, to: null },
      },
      fullRow: { dealId },
      ipAddress: req.ip ?? null,
      userAgent: buildRouteAuditContext(req).userAgent,
    });
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/proposal-draft - create a draft proposal handoff
router.post("/:id/proposal-draft", async (req, res, next) => {
  try {
    if (!isProposalDraftingEnabled()) {
      throw new AppError(404, "Proposal drafting is not enabled");
    }

    const deal = await startProposalDraft(
      req.tenantDb!,
      req.params.id,
      req.user!.role,
      req.user!.id,
      buildRouteAuditContext(req)
    );
    await req.commitTransaction!();
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.status(201).json({ deal: redactDealResponse(deal, { includeHubspotId }) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id — update deal fields (not stage)
router.patch("/:id", async (req, res, next) => {
  try {
    const dealAccess = await assertDealCollaboratorAccess(req.tenantDb!, req.params.id, req.user!);
    const body = { ...req.body };
    validateDealPayload(body);
    assertProjectNumberMutationAllowed(body, req.user!.role);
    const forceEditAfterRfp = body.forceEditAfterRfp === true;
    const clientRequestedMigrationMode = body.migrationMode === true;
    delete body.forceEditAfterRfp;
    delete body.migrationMode;

    // An empty-string relationship id fails the Postgres uuid cast (22P02 -> 500),
    // and an explicit null is rejected downstream ("…cannot be cleared once set");
    // the only correct "not provided" shape is to OMIT the field. Coerce blank
    // uuid fields to omitted here so ANY caller is safe, not just the form that
    // BLUE's #636 hardened client-side. null is left intact so the existing
    // clear-semantics still apply.
    stripBlankUuidPatchFields(body);

    const patchKeys = Object.keys(body);
    const isAssignmentTransferOnly = patchKeys.length > 0 && patchKeys.every((field) => field === "assignedRepId");
    // Admins and directors set project numbers on deals they don't own — this is the
    // primary use case for the projectNumber field. The collaborator access check above
    // already enforced the office boundary; only the rep-ownership check needs to be
    // skipped. Narrowly scoped: role must be admin/director AND the patch must touch
    // only projectNumber.
    const isProjectNumberOnlyAdminPatch =
      (req.user!.role === "admin" || req.user!.role === "director") &&
      patchKeys.length > 0 &&
      patchKeys.every((field) => field === "projectNumber");
    if (isAssignmentTransferOnly) {
      const isDirectorOrAdmin = req.user!.role === "admin" || req.user!.role === "director";
      if (!isDirectorOrAdmin && dealAccess.assignedRepId !== req.user!.id) {
        throw new AppError(
          403,
          "Only the assigned rep, a director, or an admin can reassign this deal",
          "DEAL_REASSIGNMENT_FORBIDDEN"
        );
      }
    } else if (!isProjectNumberOnlyAdminPatch) {
      await assertDealOwnerRouteAccess(req, req.params.id, {
        message: "Only the assigned rep can modify this deal",
      });
    }

    const hasLockedDealFieldCandidates = Object.keys(body).some((field) =>
      SCOPE_LOCKED_DEAL_PATCH_FIELDS.has(field)
    );
    const existingDeal = hasLockedDealFieldCandidates
      ? await loadLockedDealPatchComparisonBaseline(
          req.tenantDb!,
          req.params.id,
          req.user!.role,
          req.user!.id
        )
      : null;

    const priorDeal =
      body.proposalStatus === "revision_requested"
        ? await getDealById(
            req.tenantDb!,
            req.params.id,
            req.user!.role,
            req.user!.id
          )
        : null;

    const shouldInspectRelationship =
      body.companyId !== undefined ||
      body.propertyId !== undefined ||
      hasDealLocationFields(body);
    const relationshipBaseline =
      existingDeal ??
      (
        shouldInspectRelationship
          ? await getDealById(
              req.tenantDb!,
              req.params.id,
              req.user!.role,
              req.user!.id
            )
          : null
      );
    const cleanupBaseline = relationshipBaseline ?? existingDeal;
    const isLegacyCleanupPatch =
      shouldTreatPatchAsLegacyCleanup(
        body,
        req.user!.role,
        (cleanupBaseline ?? null) as Record<string, unknown> | null
      ) &&
      hasCompleteLegacyCleanupRelationships(
        body,
        (cleanupBaseline ?? null) as Record<string, unknown> | null
      );
    const scopeLockedFields = getScopeLockedDealPatchFields(
      body,
      (existingDeal ?? cleanupBaseline ?? {}) as Record<string, unknown>
    );
    const writePolicy =
      scopeLockedFields.length > 0
        ? await assertDealScopingWriteAllowed(req.tenantDb!, req.params.id, {
            role: req.user!.role,
            forceEditAfterRfp,
            ...(isLegacyCleanupPatch ? { cleanupMode: true } : {}),
          })
        : null;

    if (isLegacyCleanupPatch) {
      const effectiveCompanyId =
        body.companyId !== undefined
          ? body.companyId
          : (cleanupBaseline as Record<string, unknown>).companyId;
      const effectivePropertyId =
        body.propertyId !== undefined
          ? body.propertyId
          : (cleanupBaseline as Record<string, unknown>).propertyId;

      if (!effectiveCompanyId || !effectivePropertyId) {
        throw new AppError(
          400,
          "Legacy cleanup requires both company and property before this deal can be saved."
        );
      }
    }

    const existingPropertyId =
      typeof (relationshipBaseline as Record<string, unknown> | null)?.propertyId === "string"
        ? (relationshipBaseline as Record<string, unknown>).propertyId as string
        : null;
    const existingCompanyId =
      typeof (relationshipBaseline as Record<string, unknown> | null)?.companyId === "string"
        ? (relationshipBaseline as Record<string, unknown>).companyId as string
        : null;
    const requestedPropertyId = typeof body.propertyId === "string" && body.propertyId ? body.propertyId : null;
    const requestedCompanyId = typeof body.companyId === "string" && body.companyId ? body.companyId : null;
    const effectivePropertyId = requestedPropertyId ?? existingPropertyId;
    const effectiveCompanyId =
      requestedCompanyId ?? existingCompanyId;
    const propertyRelationshipChanged = requestedPropertyId != null && requestedPropertyId !== existingPropertyId;
    const companyRelationshipChanged = requestedCompanyId != null && requestedCompanyId !== existingCompanyId;
    let propertyAddressSync: Record<string, unknown> = {};

    if (effectivePropertyId && (propertyRelationshipChanged || companyRelationshipChanged)) {
      const property = await loadDealLocationFromProperty(req.tenantDb!, effectivePropertyId);
      if (effectiveCompanyId && property.companyId !== effectiveCompanyId) {
        throw new AppError(400, "Property does not belong to the company");
      }
      if (propertyRelationshipChanged) {
        propertyAddressSync = property.dealLocation;
      } else {
        removeDealLocationFields(body);
      }
    } else if (existingPropertyId && hasDealLocationFields(body)) {
      removeDealLocationFields(body);
    }

    const patchToApply = {
      ...body,
      ...propertyAddressSync,
      ...(isLegacyCleanupPatch ? { migrationMode: true } : {}),
      auditContext: buildRouteAuditContext(req),
    };
    let deal = await updateDeal(
      req.tenantDb!,
      req.params.id,
      patchToApply,
      req.user!.role,
      req.user!.id,
      req.user!.activeOfficeId,
    );
    if (isLegacyCleanupPatch) {
      await writeAuditLog(req.tenantDb!, {
        tableName: "deals",
        recordId: req.params.id,
        action: "update",
        changedBy: req.user!.id,
        changes: {
          cleanupMode: {
            from: false,
            to: true,
          },
          requestedMigrationMode: {
            from: clientRequestedMigrationMode,
            to: false,
          },
        },
        fullRow: {
          route: "deals",
          reason: "legacy_cleanup_relationship_repair",
          sourceLeadId: (cleanupBaseline as Record<string, unknown> | null)?.sourceLeadId ?? null,
          companyIdBefore: (cleanupBaseline as Record<string, unknown> | null)?.companyId ?? null,
          propertyIdBefore: (cleanupBaseline as Record<string, unknown> | null)?.propertyId ?? null,
          companyIdAfter:
            body.companyId !== undefined
              ? body.companyId
              : (cleanupBaseline as Record<string, unknown> | null)?.companyId ?? null,
          propertyIdAfter:
            body.propertyId !== undefined
              ? body.propertyId
              : (cleanupBaseline as Record<string, unknown> | null)?.propertyId ?? null,
        },
      });
      await writeLegacyCleanupScopeAuditLog(
        req,
        "deals",
        (cleanupBaseline ?? null) as Record<string, unknown> | null,
        patchToApply
      );
    }
    if (writePolicy?.adminOverride) {
      await writeAuditLog(req.tenantDb!, {
        tableName: "deal_scoping_intake",
        recordId: req.params.id,
        action: "update",
        changedBy: req.user!.id,
        changes: Object.fromEntries(
          scopeLockedFields.map((field) => [
            field,
            { from: null, to: "[admin override]" },
          ])
        ),
        fullRow: {
          override: "admin_force_edit_after_rfp",
          route: "deals",
          fields: scopeLockedFields,
          reason: writePolicy.lockState.reason,
          submittedAt: writePolicy.lockState.submittedAt instanceof Date
            ? writePolicy.lockState.submittedAt.toISOString()
            : writePolicy.lockState.submittedAt,
        },
      });
    }

    if (body.proposalStatus === "revision_requested") {
      const revisionRouting = await routeRevisionToEstimating(
        req.tenantDb!,
        req.params.id,
        req.user!.id,
        {
          proposalStatus: "revision_requested",
          previousEstimatingSubstage: priorDeal?.estimatingSubstage ?? null,
        }
      );
      deal = revisionRouting.deal;
    }

    await req.commitTransaction!();
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.json({ deal: redactDealResponse(deal, { includeHubspotId }) });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/estimating/documents
router.post("/:id/estimating/documents", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    let uploadedFile;
    if (req.body.fileId) {
      uploadedFile = await getFileById(req.tenantDb!, req.body.fileId);
      if (!uploadedFile) throw new AppError(404, "Uploaded file not found");
      if (uploadedFile.dealId !== req.params.id) {
        throw new AppError(400, "Uploaded file must belong to the same deal");
      }
    } else if (req.body.uploadToken) {
      const pendingUpload = getPendingUploadMetadata(req.body.uploadToken);
      if (!pendingUpload) {
        throw new AppError(400, "Invalid or expired upload token");
      }
      if (pendingUpload.dealId !== req.params.id) {
        throw new AppError(400, "Uploaded file must belong to the same deal");
      }
      // Token-only confirm (no clientUploadId) → never dedupes, so `.file` is always the freshly created row.
      uploadedFile = (await confirmUpload(req.tenantDb!, req.user!.id, {
        uploadToken: req.body.uploadToken,
      })).file;
    } else {
      throw new AppError(400, "Either uploadToken or fileId is required");
    }

    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    const document = await createEstimateSourceDocument({
      tenantDb: req.tenantDb!,
      enqueueEstimateDocumentOcr: (payload) =>
        enqueueEstimateDocumentOcrJob(req.tenantDb!, payload),
      input: {
        dealId: req.params.id,
        fileId: uploadedFile.id,
        rootFileId: uploadedFile.parentFileId ?? uploadedFile.id,
        filename: uploadedFile.originalFilename,
        mimeType: uploadedFile.mimeType,
        fileSize: uploadedFile.fileSizeBytes,
        contentHash: uploadedFile.r2Key,
        userId: req.user!.id,
        officeId,
        parseMeasurementsEnabled: req.body.parseMeasurementsEnabled,
      },
    });

    await req.commitTransaction!();
    res.status(201).json({ document, file: uploadedFile });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/documents/:documentId/reprocess", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    const document = await reprocessEstimateSourceDocument({
      tenantDb: req.tenantDb!,
      enqueueEstimateDocumentOcr: (payload) =>
        enqueueEstimateDocumentOcrJob(req.tenantDb!, payload),
      input: {
        dealId: req.params.id,
        documentId: req.params.documentId,
        userId: req.user!.id,
        officeId,
        parseProvider: req.body.parseProvider,
        parseProfile: req.body.parseProfile,
        parseMeasurementsEnabled: req.body.parseMeasurementsEnabled,
      },
    });

    if (!document) throw new AppError(404, "Estimate document not found");

    await req.commitTransaction!();
    res.status(201).json({ document });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/pricing-recommendations/:recommendationId/approve", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await approveEstimatePricingRecommendation({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      recommendationId: req.params.recommendationId,
      userId: req.user!.id,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post(
  "/:id/estimating/pricing-recommendations/:recommendationId/review-state",
  async (req, res, next) => {
    try {
      const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found");

      const result = await updateEstimatePricingRecommendationReviewState({
        tenantDb: req.tenantDb! as any,
        dealId: req.params.id,
        recommendationId: req.params.recommendationId,
        userId: req.user!.id,
        input: req.body,
      });

      await req.commitTransaction!();
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.post("/:id/estimating/promote", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");
    if (!req.body.generationRunId) {
      throw new AppError(400, "generationRunId is required");
    }

    const approvedRecommendationIds = await listApprovedRecommendationIdsForRun(
      req.tenantDb! as any,
      req.params.id,
      req.body.generationRunId
    );

    if (approvedRecommendationIds.length === 0) {
      throw new AppError(400, "At least one approved recommendation is required before promotion");
    }

    const result = await promoteApprovedRecommendationsToEstimate({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      generationRunId: req.body.generationRunId,
      approvedRecommendationIds,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/manual-rows", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await createManualEstimateRow({
      tenantDb: req.tenantDb! as any,
      appDb: (req as any).appDb as any,
      dealId: req.params.id,
      userId: req.user!.id,
      input: req.body,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/estimating/manual-rows/:recommendationId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await updateManualEstimateRow({
      tenantDb: req.tenantDb! as any,
      appDb: (req as any).appDb as any,
      dealId: req.params.id,
      recommendationId: req.params.recommendationId,
      userId: req.user!.id,
      input: req.body,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/manual-rows/:recommendationId/promote-local-catalog", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await promoteManualRowToLocalCatalog({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      recommendationId: req.params.recommendationId,
      userId: req.user!.id,
      input: req.body,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/estimating", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);
    const workflow = await getEstimatingWorkflowState(
      req.tenantDb! as any,
      req.params.id,
      {
        appDb: (req as any).appDb as any,
        officeId: req.user!.activeOfficeId ?? req.user!.officeId ?? null,
      }
    );
    await req.commitTransaction!();
    res.status(200).json(workflow);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/estimating/market-context", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);

    const marketContext = await getDealEffectiveMarketContext(req.tenantDb! as any, req.params.id);
    await req.commitTransaction!();
    res.status(200).json({ marketContext });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/estimating/markets", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);

    const markets = await listEstimateMarkets(req.tenantDb! as any);
    await req.commitTransaction!();
    res.status(200).json({ markets });
  } catch (err) {
    next(err);
  }
});

router.put("/:id/estimating/market-override", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");
    if (!req.body.marketId?.trim?.()) {
      throw new AppError(400, "marketId is required");
    }

    const result = await setDealMarketOverride({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      marketId: req.body.marketId,
      userId: req.user!.id,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId ?? null,
      reason: req.body.reason ?? null,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/estimating/market-override", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await clearDealMarketOverride({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      userId: req.user!.id,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId ?? null,
      reason: req.body.reason ?? null,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/estimating/extractions/:extractionId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await updateEstimateExtraction({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      extractionId: req.params.extractionId,
      userId: req.user!.id,
      input: req.body,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/extractions/:extractionId/approve", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await approveEstimateExtraction({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      extractionId: req.params.extractionId,
      userId: req.user!.id,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/extractions/:extractionId/reject", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await rejectEstimateExtraction({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      extractionId: req.params.extractionId,
      userId: req.user!.id,
      reason: req.body.reason ?? null,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/matches/:matchId/select", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await selectEstimateExtractionMatch({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      matchId: req.params.matchId,
      userId: req.user!.id,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/matches/:matchId/reject", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await rejectEstimateExtractionMatch({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      matchId: req.params.matchId,
      userId: req.user!.id,
      reason: req.body.reason ?? null,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/recommendations/:recommendationId/approve", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await approveEstimatePricingRecommendation({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      recommendationId: req.params.recommendationId,
      userId: req.user!.id,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/pricing-recommendations/:recommendationId/reject", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await rejectEstimatePricingRecommendation({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      recommendationId: req.params.recommendationId,
      userId: req.user!.id,
      reason: req.body.reason ?? null,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/estimating/pricing-recommendations/:recommendationId/override", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const result = await overrideEstimatePricingRecommendation({
      tenantDb: req.tenantDb! as any,
      dealId: req.params.id,
      recommendationId: req.params.recommendationId,
      userId: req.user!.id,
      input: req.body,
    });

    await req.commitTransaction!();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/estimating/copilot", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");
    const context = await buildEstimatingCopilotContext({
      tenantDb: req.tenantDb! as any,
      appDb: (req as any).appDb as any,
      dealId: req.params.id,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId ?? null,
      question: req.body.question,
    });
    const answer = await answerEstimatingCopilotQuestion({
      question: req.body.question,
      context,
    });
    await req.commitTransaction!();
    res.status(200).json({ answer });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/stage — change deal stage (with validation)
router.post("/:id/stage", async (req, res, next) => {
  try {
    await assertDealOwnerRouteAccess(req, req.params.id, {
      message: "Only the assigned rep can modify this deal",
    });
    const { targetStageId, overrideReason, lostReasonId, lostNotes, lostCompetitor, expectedCloseDate } = req.body;
    if (!targetStageId) {
      throw new AppError(400, "targetStageId is required");
    }
    // Validate the optional inline forecast date up front: reject non-strings / impossible dates with
    // a clean 400 here, before the value can reach changeDealStage and the Postgres date column.
    validateOptionalExpectedCloseDateInput(expectedCloseDate);

    const result = await changeDealStage(req.tenantDb!, {
      dealId: req.params.id,
      targetStageId,
      userId: req.user!.id,
      userRole: req.user!.role,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      overrideReason,
      lostReasonId,
      lostNotes,
      lostCompetitor,
      expectedCloseDate,
      auditContext: buildRouteAuditContext(req),
    });

    await req.tenantDb!.insert(jobQueue).values({
      jobType: "ai_refresh_copilot",
      payload: {
        dealId: req.params.id,
        reason: "deal_stage_changed",
        targetStageId,
        requestedBy: req.user!.id,
      },
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      status: "pending",
      runAfter: new Date(),
    });

    await req.commitTransaction!();
    emitLocalDealEvents((result as any)._eventsToEmit ?? [], {
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      userId: req.user!.id,
    });

    const includeHubspotIdStage = shouldIncludeHubspotId(req.query, req.user!.role);
    res.json({
      deal: redactDealResponse(result.deal, { includeHubspotId: includeHubspotIdStage }),
      stageHistory: result.stageHistory,
      eventsEmitted: result.eventsEmitted,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/stage/preflight — check stage gate without committing
router.post("/:id/stage/preflight", async (req, res, next) => {
  try {
    const { targetStageId } = req.body;
    if (!targetStageId) {
      throw new AppError(400, "targetStageId is required");
    }

    const result = await preflightStageCheck(
      req.tenantDb!,
      req.params.id,
      targetStageId,
      req.user!.role,
      req.user!.id
    );

    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    const inferredOwnership = deal
      ? inferDealBidBoardOwnership({
          id: deal.id,
          stageSlug: result.currentStage.slug,
          stageEnteredAt: deal.stageEnteredAt,
          workflowRoute: deal.workflowRoute,
          pipelineTypeSnapshot: deal.pipelineTypeSnapshot,
          ddEstimate: deal.ddEstimate,
          bidEstimate: deal.bidEstimate,
          awardedAmount: deal.awardedAmount,
          sourceLeadId: deal.sourceLeadId,
          isBidBoardOwned: deal.isBidBoardOwned,
          bidBoardStageSlug: deal.bidBoardStageSlug,
          bidBoardStageEnteredAt: deal.bidBoardStageEnteredAt,
          bidBoardMirrorSourceEnteredAt: deal.bidBoardMirrorSourceEnteredAt,
          isReadOnlyMirror: deal.isReadOnlyMirror,
          readOnlySyncedAt: deal.readOnlySyncedAt,
        })
      : null;
    const bidBoardOwnership = deal
      ? buildBidBoardOwnershipState({
          ...deal,
          isBidBoardOwned: inferredOwnership?.isBidBoardOwned ?? deal.isBidBoardOwned,
        })
      : null;
    let estimatingBoundary: { slug: string; displayOrder: number } | null = null;
    let currentIsBidBoardBoundaryOrDownstream = false;
    let targetIsBidBoardDownstream = false;
    if (deal) {
      const workflowRoute = deal.workflowRoute;
      estimatingBoundary = inferredOwnership?.isBidBoardOwned
        ? await getRequiredEstimatingBoundaryStage(workflowRoute)
        : await getEstimatingBoundaryStage(workflowRoute);
      currentIsBidBoardBoundaryOrDownstream =
        Boolean(estimatingBoundary) &&
        (isEstimatingBoundaryStageSlug(result.currentStage.slug, workflowRoute) ||
          isBidBoardOwnedDownstreamStage(result.currentStage, estimatingBoundary, workflowRoute));
      targetIsBidBoardDownstream =
        Boolean(estimatingBoundary) &&
        isBidBoardOwnedDownstreamStage(result.targetStage, estimatingBoundary, workflowRoute);
    }
    const targetIsReopenIntoCrmOwnedFlow =
      Boolean(estimatingBoundary) &&
      result.targetStage.displayOrder <
        (estimatingBoundary?.displayOrder ?? Number.NEGATIVE_INFINITY);
    const isBidBoardLocked =
      Boolean(deal) &&
      ((Boolean(inferredOwnership?.isBidBoardOwned) || currentIsBidBoardBoundaryOrDownstream) &&
        (currentIsBidBoardBoundaryOrDownstream || targetIsBidBoardDownstream) &&
        !targetIsReopenIntoCrmOwnedFlow);

    await req.commitTransaction!();
    res.json({
      ...result,
      allowed: isBidBoardLocked ? false : result.allowed,
      blockReason: isBidBoardLocked
        ? BID_BOARD_STAGE_READ_ONLY_MESSAGE
        : result.blockReason,
      bidBoardLocked: isBidBoardLocked,
      bidBoardOwnership,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/service-handoff/activate — activate service workflow once scoping is ready
router.post("/:id/service-handoff/activate", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);
    const result = await activateServiceHandoff(req.tenantDb!, {
      dealId: req.params.id,
      userId: req.user!.id,
      userRole: req.user!.role,
    });

    await req.commitTransaction!();
    emitLocalDealEvents((result as any)._eventsToEmit ?? [], {
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      userId: req.user!.id,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/approvals — request approval (rep creates)
router.post("/:id/approvals", async (req, res, next) => {
  try {
    // RBAC: verify the user has access to this deal
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { targetStageId, requiredRole } = req.body;
    if (!targetStageId || !requiredRole) {
      throw new AppError(400, "targetStageId and requiredRole are required");
    }

    const result = await req.tenantDb!
      .insert(dealApprovals)
      .values({
        dealId: req.params.id,
        targetStageId,
        requiredRole,
        requestedBy: req.user!.id,
        status: "pending",
      })
      .returning();

    // Outbox pattern: durable event BEFORE commit so worker gets it
    await req.tenantDb!.insert(jobQueue).values({
      jobType: "domain_event",
      payload: {
        eventName: "approval.requested",
        dealId: req.params.id,
        targetStageId,
        requiredRole,
        requestedBy: req.user!.id,
        approvalId: result[0].id,
      },
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      status: "pending",
      runAfter: new Date(),
    });

    await req.commitTransaction!();

    // Best-effort local emit for SSE push (already persisted via outbox above)
    try {
      eventBus.emitLocal({
        name: "approval.requested",
        payload: {
          dealId: req.params.id,
          targetStageId,
          requiredRole,
          requestedBy: req.user!.id,
          approvalId: result[0].id,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        userId: req.user!.id,
        timestamp: new Date(),
      });
    } catch (eventErr) {
      console.error("[Deals] Failed to emit approval.requested event:", eventErr);
    }

    res.status(201).json({ approval: result[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/approvals/:approvalId — resolve approval (director approves/rejects)
router.patch(
  "/:id/approvals/:approvalId",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const { status, notes } = req.body;
      if (!status || !["approved", "rejected"].includes(status)) {
        throw new AppError(400, "status must be 'approved' or 'rejected'");
      }

      const dealId = req.params.id as string;
      const approvalId = req.params.approvalId as string;

      // RBAC: verify user has access to this deal
      const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found");

      // Fetch the approval and validate state + role
      const [approval] = await req.tenantDb!.select().from(dealApprovals)
        .where(and(eq(dealApprovals.id, approvalId), eq(dealApprovals.dealId, dealId))).limit(1);

      if (!approval) throw new AppError(404, "Approval not found");
      if (approval.status !== "pending") throw new AppError(400, "Approval already resolved");

      const roleHierarchy: Record<string, number> = { rep: 0, director: 1, admin: 2 };
      if (roleHierarchy[req.user!.role] < roleHierarchy[approval.requiredRole]) {
        throw new AppError(403, `Requires ${approval.requiredRole} role to resolve this approval`);
      }

      const result = await req.tenantDb!
        .update(dealApprovals)
        .set({
          status,
          notes: notes ?? null,
          approvedBy: req.user!.id,
          resolvedAt: new Date(),
        })
        .where(eq(dealApprovals.id, approvalId))
        .returning();

      // Outbox pattern: durable event BEFORE commit so worker gets it
      await req.tenantDb!.insert(jobQueue).values({
        jobType: "domain_event",
        payload: {
          eventName: "approval.resolved",
          dealId,
          approvalId,
          status,
          requestedBy: approval.requestedBy,
          resolvedBy: req.user!.id,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        status: "pending",
        runAfter: new Date(),
      });

      await req.commitTransaction!();

      // Best-effort local emit for SSE push (already persisted via outbox above)
      try {
        eventBus.emitLocal({
          name: "approval.resolved",
          payload: {
            dealId,
            approvalId,
            status,
            resolvedBy: req.user!.id,
          },
          officeId: req.user!.activeOfficeId ?? req.user!.officeId,
          userId: req.user!.id,
          timestamp: new Date(),
        });
      } catch (eventErr) {
        console.error("[Deals] Failed to emit approval.resolved event:", eventErr);
      }

      res.json({ approval: result[0] });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/deals/:id/approvals — list approvals for a deal
router.get("/:id/approvals", async (req, res, next) => {
  try {
    // Office-level read: any rep in the deal's office may view its approvals.
    await assertDealRouteAccess(req, req.params.id);

    const approvals = await req.tenantDb!
      .select()
      .from(dealApprovals)
      .where(eq(dealApprovals.dealId, req.params.id as string))
      .orderBy(desc(dealApprovals.createdAt));

    await req.commitTransaction!();
    res.json({ approvals });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/contacts — contacts associated with a deal
router.get("/:id/contacts", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);

    const associations = await getContactsForDeal(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ associations });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/deals/:id — owner/admin soft-delete
router.delete("/:id", async (req, res, next) => {
  try {
    const dealId = req.params.id as string;
    await assertDealOwnerRouteAccess(req, dealId, {
      allowAdmin: true,
      message: "Only the assigned rep or an admin can delete this deal",
    });
    // A change-order child inherits the parent's rep, so owner access would let a non-admin rep delete it
    // via this route (voiding the CO + removing its commission), bypassing the admin-only change-order
    // delete endpoint. CO deletion is admin-only — reject non-admins here. (Admins fall through to
    // deleteDeal, which soft-deletes + removes the CO's commission + dismisses its tasks.)
    if (req.user!.role !== "admin") {
      const [coCheck] = await req.tenantDb!
        .select({ isChangeOrder: deals.isChangeOrder })
        .from(deals)
        .where(eq(deals.id, dealId))
        .limit(1);
      if (coCheck?.isChangeOrder === true) {
        throw new AppError(403, "Only an admin can delete a change order.", "CHANGE_ORDER_ADMIN_ONLY");
      }
    }
    const deal = await deleteDeal(req.tenantDb!, dealId, "admin", req.user!.id);
    if (deal) {
      const auditContext = buildRouteAuditContext(req);
      await logActivity({
        tenantDb: req.tenantDb!,
        actor: auditContext.actor,
        action: "soft_delete",
        entity: {
          tableName: "deals",
          entityType: "deal",
          recordId: dealId,
          nameSnapshot: deal.name,
          secondaryIdSnapshot: deal.projectNumber ?? deal.dealNumber ?? null,
        },
        fieldChanges: {
          isActive: { from: true, to: false },
        },
        ipAddress: auditContext.ipAddress ?? null,
        userAgent: auditContext.userAgent ?? null,
      });
    }
    await req.commitTransaction!();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ── Deal Team Members ──────────────────────────────────────────────────────────

// GET /api/deals/:id/team
router.get("/:id/team", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);

    const members = await getTeamMembers(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ members });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/team/assignable-users
router.get("/:id/team/assignable-users", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);

    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    const rows = (await listUsers(officeId)) as Array<{
      id: string;
      displayName: string;
      email: string;
      isActive: boolean;
    }>;
    const users = rows
      .filter((user) => user.isActive)
      .map((user) => ({
        id: user.id,
        displayName: user.displayName,
        email: user.email,
      }));

    await req.commitTransaction!();
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/team
router.post("/:id/team", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { userId, role, notes } = req.body;
    if (!userId || !role) throw new AppError(400, "userId and role are required");
    if (!DEAL_TEAM_ROLES.includes(role)) throw new AppError(400, "Invalid role");

    const member = await addTeamMember(req.tenantDb!, {
      dealId: req.params.id,
      userId,
      role,
      assignedBy: req.user!.id,
      notes,
    });
    await req.commitTransaction!();
    res.status(201).json({ member });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/team/:memberId
router.patch("/:id/team/:memberId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { role, notes } = req.body;
    if (role !== undefined && !DEAL_TEAM_ROLES.includes(role)) throw new AppError(400, "Invalid role");
    const member = await updateTeamMember(req.tenantDb!, req.params.memberId, req.params.id, { role, notes });
    await req.commitTransaction!();
    res.json({ member });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/deals/:id/team/:memberId
router.delete("/:id/team/:memberId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    await removeTeamMember(req.tenantDb!, req.params.memberId, req.params.id);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Estimates ──────────────────────────────────────────────────────────────────

// GET /api/deals/:id/estimates
router.get("/:id/estimates", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);

    const estimate = await getEstimate(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(estimate);
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/estimates/sections
router.post("/:id/estimates/sections", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { name, displayOrder } = req.body;
    if (!name) throw new AppError(400, "name is required");

    const section = await createSection(req.tenantDb!, req.params.id, name, displayOrder);
    await queueAiEstimateRefresh(
      req.tenantDb!,
      req.user!.activeOfficeId ?? req.user!.officeId,
      req.params.id,
      "estimate_section_created",
      req.user!.id
    );
    await req.commitTransaction!();
    res.status(201).json({ section });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/estimates/sections/:sectionId
router.patch("/:id/estimates/sections/:sectionId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { name, displayOrder } = req.body;
    const section = await updateSection(req.tenantDb!, req.params.sectionId, req.params.id, { name, displayOrder });
    await queueAiEstimateRefresh(
      req.tenantDb!,
      req.user!.activeOfficeId ?? req.user!.officeId,
      req.params.id,
      "estimate_section_updated",
      req.user!.id
    );
    await req.commitTransaction!();
    res.json({ section });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/deals/:id/estimates/sections/:sectionId
router.delete("/:id/estimates/sections/:sectionId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    await deleteSection(req.tenantDb!, req.params.sectionId, req.params.id);
    await queueAiEstimateRefresh(
      req.tenantDb!,
      req.user!.activeOfficeId ?? req.user!.officeId,
      req.params.id,
      "estimate_section_deleted",
      req.user!.id
    );
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/estimates/sections/:sectionId/items
router.post("/:id/estimates/sections/:sectionId/items", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { description, quantity, unit, unitPrice, notes, displayOrder } = req.body;
    const item = await createLineItem(req.tenantDb!, req.params.id, req.params.sectionId, {
      description,
      quantity,
      unit,
      unitPrice,
      notes,
      displayOrder,
    });
    await queueAiEstimateRefresh(
      req.tenantDb!,
      req.user!.activeOfficeId ?? req.user!.officeId,
      req.params.id,
      "estimate_item_created",
      req.user!.id
    );
    await req.commitTransaction!();
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/estimates/items/:itemId
router.patch("/:id/estimates/items/:itemId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { description, quantity, unit, unitPrice, notes, displayOrder } = req.body;
    const item = await updateLineItem(req.tenantDb!, req.params.itemId, req.params.id, {
      description,
      quantity,
      unit,
      unitPrice,
      notes,
      displayOrder,
    });
    await queueAiEstimateRefresh(
      req.tenantDb!,
      req.user!.activeOfficeId ?? req.user!.officeId,
      req.params.id,
      "estimate_item_updated",
      req.user!.id
    );
    await req.commitTransaction!();
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/deals/:id/estimates/items/:itemId
router.delete("/:id/estimates/items/:itemId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    await deleteLineItem(req.tenantDb!, req.params.itemId, req.params.id);
    await queueAiEstimateRefresh(
      req.tenantDb!,
      req.user!.activeOfficeId ?? req.user!.officeId,
      req.params.id,
      "estimate_item_deleted",
      req.user!.id
    );
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Punch List ─────────────────────────────────────────────────────────────────

// GET /api/deals/:id/punch-list
router.get("/:id/punch-list", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);

    const result = await getPunchList(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/punch-list
router.post("/:id/punch-list", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { type, title, description, assignedTo, location, priority } = req.body;
    if (type !== undefined && !PUNCH_LIST_TYPES.includes(type)) throw new AppError(400, "Invalid punch list type");
    const item = await createPunchListItem(req.tenantDb!, {
      dealId: req.params.id,
      type,
      title,
      description,
      assignedTo,
      location,
      priority,
      createdBy: req.user!.id,
    });
    await req.commitTransaction!();
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/punch-list/:itemId
router.patch("/:id/punch-list/:itemId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { type, title, description, assignedTo, location, priority, status } = req.body;
    if (type !== undefined && !PUNCH_LIST_TYPES.includes(type)) throw new AppError(400, "Invalid punch list type");
    const item = await updatePunchListItem(req.tenantDb!, req.params.itemId, req.params.id, {
      type,
      title,
      description,
      assignedTo,
      location,
      priority,
      status,
    });
    await req.commitTransaction!();
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/punch-list/:itemId/complete
router.post("/:id/punch-list/:itemId/complete", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const item = await completePunchListItem(req.tenantDb!, req.params.itemId, req.params.id, req.user!.id);
    await req.commitTransaction!();
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

// ── Workflow Timers ────────────────────────────────────────────────────────────

// GET /api/deals/:id/timers
router.get("/:id/timers", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);

    const result = await getTimers(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/timers
router.post("/:id/timers", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { timerType, label, deadlineAt } = req.body;
    if (!timerType || !deadlineAt) throw new AppError(400, "timerType and deadlineAt are required");
    if (!WORKFLOW_TIMER_TYPES.includes(timerType)) throw new AppError(400, "Invalid timer type");

    const timer = await createTimer(req.tenantDb!, {
      dealId: req.params.id,
      timerType,
      label,
      deadlineAt,
      createdBy: req.user!.id,
    });
    await req.commitTransaction!();
    res.status(201).json({ timer });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/timers/:timerId — complete or cancel
router.patch("/:id/timers/:timerId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { action } = req.body;
    if (!action || !["complete", "cancel"].includes(action)) {
      throw new AppError(400, "action must be 'complete' or 'cancel'");
    }

    const timer =
      action === "complete"
        ? await completeTimer(req.tenantDb!, req.params.timerId, req.params.id)
        : await cancelTimer(req.tenantDb!, req.params.timerId, req.params.id);

    await req.commitTransaction!();
    res.json({ timer });
  } catch (err) {
    next(err);
  }
});

// ── Close-Out Checklist ────────────────────────────────────────────────────────

// GET /api/deals/:id/closeout
router.get("/:id/closeout", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);

    const result = await getCloseoutChecklist(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/closeout/initialize
router.post("/:id/closeout/initialize", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");
    await initializeCloseoutChecklist(req.tenantDb!, req.params.id);
    const checklist = await getCloseoutChecklist(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(checklist);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/deals/:id/closeout/:itemId — update checklist item (toggle or set notes)
router.patch("/:id/closeout/:itemId", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const { isCompleted, notes } = req.body;
    const item = await updateChecklistItem(
      req.tenantDb!,
      req.params.itemId,
      req.params.id,
      req.user!.id,
      { isCompleted, notes }
    );
    await req.commitTransaction!();
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

export const dealRoutes = router;
