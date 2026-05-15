import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq, desc, isNotNull, isNull, or, sql } from "drizzle-orm";
import { companies, dealApprovals, dealScopingIntake, deals, jobQueue, properties } from "@trock-crm/shared/schema";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import { writeAuditLog } from "../../lib/audit-log.js";
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
} from "./service.js";
import { toJsonSafe } from "../../lib/json-safe.js";
import { redactDealList, redactDealResponse, shouldIncludeHubspotId } from "./redact.js";
import { activateServiceHandoff, changeDealStage } from "./stage-change.js";
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
import { confirmUpload, getFileById, getPendingUploadMetadata } from "../files/service.js";
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
import { insertOpportunityRfpRequestJob } from "./rfp-enqueue.js";
import { isOpportunityRfpEventEnabled } from "../../config/feature-flags.js";
import { getActiveProjectTypes, getAllStages, getStageBySlug } from "../pipeline/service.js";
import { resolveDealCreateOfficeCode } from "./create-context.js";

const router = Router();

async function assertDealRouteAccess(req: any, dealId: string) {
  const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
  if (!deal) {
    throw new AppError(403, "Access denied: you do not have access to this deal.");
  }
  return deal;
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

const LEGACY_CLEANUP_PATCH_ALLOWED_FIELDS = new Set([
  "name",
  "companyId",
  "propertyId",
  "primaryContactId",
  "description",
  "propertyAddress",
  "propertyCity",
  "propertyState",
  "propertyZip",
  "projectTypeId",
  "regionId",
  "source",
  "winProbability",
  "expectedCloseDate",
  "ddEstimate",
  "bidEstimate",
  "awardedAmount",
  "proposalStatus",
  "proposalNotes",
  "estimatingSubstage",
  "forecastWindow",
  "forecastCategory",
  "forecastConfidencePercent",
  "forecastRevenue",
  "forecastGrossProfit",
  "forecastBlockers",
  "nextMilestoneAt",
  "nextStep",
  "nextStepDueAt",
  "supportNeededType",
  "supportNeededNotes",
  "decisionMakerName",
  "budgetStatus",
]);

function isLegacyCleanupEligibleRole(role: string) {
  return role === "admin" || role === "director" || role === "rep";
}

function isLegacyCleanupFieldSet(body: Record<string, unknown>) {
  const fields = Object.keys(body);
  return fields.length > 0 && fields.every((field) => LEGACY_CLEANUP_PATCH_ALLOWED_FIELDS.has(field));
}

function shouldTreatPatchAsLegacyCleanup(
  body: Record<string, unknown>,
  requestedCleanupContext: boolean,
  role: string,
  deal: Record<string, unknown> | null
) {
  if (
    !requestedCleanupContext ||
    !deal ||
    !isLegacyCleanupEligibleRole(role) ||
    !isLegacyCleanupFieldSet(body)
  ) {
    return false;
  }

  if (deal.sourceLeadId != null) {
    return false;
  }

  return (
    !deal.companyId ||
    !deal.propertyId ||
    body.companyId !== undefined ||
    body.propertyId !== undefined
  );
}

function isEstimatingBoundaryStageSlug(stageSlug: string, workflowRoute: "normal" | "service") {
  return (
    stageSlug === "estimating" ||
    stageSlug === (workflowRoute === "service" ? "service_estimating" : "estimate_in_progress")
  );
}

function readBoardInput(req: Parameters<typeof router.get>[1] extends never ? never : any) {
  return {
    role: req.user!.role,
    userId: req.user!.id,
    activeOfficeId: req.user!.activeOfficeId ?? req.user!.officeId,
    scope: (req.query.scope as "mine" | "team" | "all" | undefined) ?? "mine",
    includeDd: req.query.includeDd === "true",
  };
}

function readListScope(value: unknown): "mine" | "team" | "all" {
  return value === "mine" || value === "team" || value === "all" ? value : "all";
}

function readStageInput(req: Parameters<typeof router.get>[1] extends never ? never : any) {
  const parseNumber = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return {
    ...readBoardInput(req),
    stageId: req.params.stageId,
    page: parseNumber(req.query.page) ?? 1,
    pageSize: parseNumber(req.query.pageSize) ?? 25,
    search: req.query.search as string | undefined,
    assignedRepId: req.query.assignedRepId as string | undefined,
    regionId: req.query.regionId as string | undefined,
    workflowRoute: req.query.workflowRoute as string | undefined,
    updatedFrom: (req.query.updatedAfter as string | undefined) ?? (req.query.updatedFrom as string | undefined),
    updatedTo: (req.query.updatedBefore as string | undefined) ?? (req.query.updatedTo as string | undefined),
    minAgeDays: parseNumber(req.query.minAgeDays),
    maxAgeDays: parseNumber(req.query.maxAgeDays),
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

async function queueAiEstimateRefresh(tenantDb: any, officeId: string, dealId: string, reason: string) {
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
      updatedFrom: req.query.updatedFrom as string | undefined,
      updatedTo: req.query.updatedTo as string | undefined,
      isActive: isActiveFilter,
      sortBy: req.query.sortBy as any,
      sortDir: req.query.sortDir as "asc" | "desc" | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      scope: readListScope(req.query.scope),
      activeOfficeId: req.user!.activeOfficeId ?? req.user!.officeId,
    };

    const result = await getDeals(req.tenantDb!, filters, req.user!.role, req.user!.id);
    await req.commitTransaction!();
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.json({
      ...result,
      deals: redactDealList(result.deals, { includeHubspotId }),
    });
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
    const filters = {
      assignedRepId: req.query.assignedRepId as string | undefined,
      scope: req.query.scope as "mine" | "team" | "all" | undefined,
      activeOfficeId: req.user!.activeOfficeId ?? req.user!.officeId,
      includeDd: req.query.includeDd === "true",
      wonSince: req.query.won_since as string | undefined,
      wonUntil: req.query.won_until as string | undefined,
      wonAllTime: req.query.won_all_time === "true",
      lostSince: req.query.lost_since as string | undefined,
      lostUntil: req.query.lost_until as string | undefined,
      lostAllTime: req.query.lost_all_time === "true",
    };
    const result = await getDealsForPipeline(
      req.tenantDb!,
      req.user!.role,
      req.user!.id,
      filters
    );
    await req.commitTransaction!();
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.json({
      ...result,
      pipelineColumns: result.pipelineColumns.map((column) => ({
        ...column,
        deals: redactDealList(column.deals, { includeHubspotId }),
      })),
      terminalStages: result.terminalStages.map((column) => ({
        ...column,
        deals: redactDealList(column.deals, { includeHubspotId }),
      })),
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
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");
    await req.commitTransaction!();
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.json(toJsonSafe({ deal: redactDealResponse(deal, { includeHubspotId }) }));
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/detail — deal with stage history, approvals, change orders
router.get("/:id/detail", async (req, res, next) => {
  try {
    const detail = await getDealDetail(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!detail) throw new AppError(404, "Deal not found");
    await req.commitTransaction!();
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.json(toJsonSafe({
      deal: {
        ...redactDealResponse(detail, { includeHubspotId }),
        isRfpTriggerEnabled: isOpportunityRfpEventEnabled(),
      },
    }));
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

    if (userRole !== "admin" && !(userRole === "rep" && deal.assignedRepId === userId)) {
      throw new AppError(403, "Only the assigned rep or an admin can trigger RFP review.", "RFP_UNAUTHORIZED");
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

// POST /api/deals/:id/rfp-retry — enqueue a fresh RFP delivery job from the latest dead row.
router.post("/:id/rfp-retry", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

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

    const payload: RfpRequestDeliveryPayload = {
      ...deadJob.payload,
      syncHubUrl: resolveSyncHubRfpRequestUrl(),
    };
    delete payload.dealHandled;
    await req.tenantDb!.insert(jobQueue).values({
      jobType: "rfp_request_delivery",
      payload,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      status: "pending",
      attempts: 0,
      runAfter: new Date(),
      maxAttempts: 8,
    });
    await req.tenantDb!
      .update(deals)
      .set({
        rfpApprovalStatus: "pending_outbox",
        rfpLastAttemptError: null,
      })
      .where(eq(deals.id, deal.id));

    await req.commitTransaction!();
    res.status(202).json({ success: true, status: "pending_outbox" });
  } catch (err) {
    next(err);
  }
});

// GET /api/deals/:id/scoping-intake — load or initialize scoping intake
router.get("/:id/scoping-intake", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);
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
    await assertDealRouteAccess(req, req.params.id);
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

    const hasLockedResolvedFieldCandidates = Object.keys(patch).some((field) =>
      SCOPE_LOCKED_RESOLVED_FIELDS.has(field)
    );
    const existingResolved = hasLockedResolvedFieldCandidates
      ? await loadLockedResolvedFieldComparisonBaseline(req.tenantDb!, req.params.id)
      : {};
    const scopeLockedFields = getScopeLockedResolvedFields(patch, existingResolved);
    const writePolicy = scopeLockedFields.length > 0
      ? await assertDealScopingWriteAllowed(req.tenantDb!, req.params.id, {
          role: req.user!.role,
          forceEditAfterRfp,
        })
      : null;

    const resolved = await writeResolvedDealFields(req.tenantDb!, req.params.id, patch, {
      userId: req.user!.id,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      role: req.user!.role,
    });
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
    await assertDealRouteAccess(req, req.params.id);
    const readiness = await evaluateDealScopingReadiness(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ readiness });
  } catch (err) {
    next(err);
  }
});

// POST /api/deals/:id/scoping-intake/attachments/link-existing — reuse an existing deal file
router.post("/:id/scoping-intake/attachments/link-existing", async (req, res, next) => {
  try {
    await assertDealRouteAccess(req, req.params.id);
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
  const [companyRows, propertyRows] = await Promise.all([
    tenantDb
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.id, input.companyId), eq(companies.isActive, true)))
      .limit(1),
    tenantDb
      .select({ id: properties.id, companyId: properties.companyId })
      .from(properties)
      .where(and(eq(properties.id, input.propertyId), eq(properties.isActive, true)))
      .limit(1),
  ]);

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
    const {
      name,
      assignedRepId,
      companyId,
      propertyId,
      primaryContactId,
      description,
      source,
      winProbability,
      expectedCloseDate,
      projectTypeId,
      projectType,
      officeCode,
    } = req.body;
    if (!name) {
      throw new AppError(400, "Name is required");
    }
    if (!companyId || !propertyId) {
      throw new AppError(400, "Company and property are required");
    }
    validateDealPayload(req.body);
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
      expectedCloseDate,
      workflowRoute: "service",
      projectType: "service",
      projectTypeId: serviceProjectType.id,
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
    const {
      name,
      stageId,
      assignedRepId,
      creationContext: _creationContext,
      sourceLeadWriteMode: _sourceLeadWriteMode,
      migrationMode: _migrationMode,
      ...rest
    } = req.body;
    if (!name || !stageId) {
      throw new AppError(400, "Name and stageId are required");
    }
    validateDealPayload(req.body);

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
    const body = { ...req.body };
    validateDealPayload(body);
    const forceEditAfterRfp = body.forceEditAfterRfp === true;
    const clientRequestedMigrationMode = body.migrationMode === true;
    delete body.forceEditAfterRfp;
    delete body.migrationMode;

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
    const scopeLockedFields = getScopeLockedDealPatchFields(
      body,
      (existingDeal ?? {}) as Record<string, unknown>
    );
    const writePolicy = scopeLockedFields.length > 0
      ? await assertDealScopingWriteAllowed(req.tenantDb!, req.params.id, {
          role: req.user!.role,
          forceEditAfterRfp,
        })
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

    const shouldLoadCleanupBaseline =
      existingDeal == null &&
      clientRequestedMigrationMode &&
      isLegacyCleanupEligibleRole(req.user!.role) &&
      isLegacyCleanupFieldSet(body);
    const cleanupBaseline =
      existingDeal ??
      (
        shouldLoadCleanupBaseline
          ? await getDealById(
              req.tenantDb!,
              req.params.id,
              req.user!.role,
              req.user!.id
            )
          : null
      );
    const isLegacyCleanupPatch = shouldTreatPatchAsLegacyCleanup(
      body,
      clientRequestedMigrationMode,
      req.user!.role,
      (cleanupBaseline ?? null) as Record<string, unknown> | null
    );

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

    let deal = await updateDeal(
      req.tenantDb!,
      req.params.id,
      {
        ...body,
        ...(isLegacyCleanupPatch ? { migrationMode: true } : {}),
        auditContext: buildRouteAuditContext(req),
      },
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
      uploadedFile = await confirmUpload(req.tenantDb!, req.user!.id, {
        uploadToken: req.body.uploadToken,
      });
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
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");
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
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const marketContext = await getDealEffectiveMarketContext(req.tenantDb! as any, req.params.id);
    await req.commitTransaction!();
    res.status(200).json({ marketContext });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/estimating/markets", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

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
    const { targetStageId, overrideReason, lostReasonId, lostNotes, lostCompetitor } = req.body;
    if (!targetStageId) {
      throw new AppError(400, "targetStageId is required");
    }

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
      auditContext: buildRouteAuditContext(req),
    });

    await req.tenantDb!.insert(jobQueue).values({
      jobType: "ai_refresh_copilot",
      payload: {
        dealId: req.params.id,
        reason: "deal_stage_changed",
        targetStageId,
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
    // RBAC: verify user has access to this deal
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

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
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const associations = await getContactsForDeal(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ associations });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/deals/:id — admin-only soft-delete
router.delete("/:id", requireRole("admin"), async (req, res, next) => {
  try {
    const dealId = req.params.id as string;
    const deal = await deleteDeal(req.tenantDb!, dealId, req.user!.role);
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
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

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
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

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
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

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
      "estimate_section_created"
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
      "estimate_section_updated"
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
      "estimate_section_deleted"
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
      "estimate_item_created"
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
      "estimate_item_updated"
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
      "estimate_item_deleted"
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
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

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
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

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
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

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
