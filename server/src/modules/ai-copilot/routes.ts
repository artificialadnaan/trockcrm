import { Router } from "express";
import { sql } from "drizzle-orm";
import { jobQueue, users } from "@trock-crm/shared/schema";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import { getDealById } from "../deals/service.js";
import { getCompanyById } from "../companies/service.js";
import {
  assignInterventionCases,
  assertHomogeneousBatchConclusionCohort,
  buildInterventionCopilotView,
  escalateInterventionCases,
  getInterventionCaseDetail,
  getInterventionAnalyticsDashboard,
  getInterventionPolicyRecommendationsView,
  listInterventionCases,
  recordInterventionPolicyRecommendationFeedback,
  regenerateInterventionPolicyRecommendations,
  regenerateInterventionCopilot,
  resolveInterventionCases,
  snoozeInterventionCases,
} from "./intervention-service.js";
import {
  getLatestManagerAlertSnapshot,
  runManagerAlertPreview,
  sendManagerAlertSummary,
} from "./intervention-manager-alerts-service.js";
import {
  applyInterventionPolicyRecommendation,
  getInterventionPolicyRecommendationEvaluationSummary,
  revertInterventionPolicyRecommendation,
} from "./intervention-policy-application-service.js";
import { getInterventionPolicyRecommendationReview } from "./intervention-policy-recommendation-review-service.js";
import { seedInterventionPolicyRecommendationQualificationData } from "./intervention-policy-recommendation-seed-service.js";
import type { InterventionQueueFilters, InterventionQueueView } from "./intervention-types.js";
import type { StructuredEscalateConclusion, StructuredResolveConclusion, StructuredSnoozeConclusion } from "./intervention-types.js";
import { mapStructuredResolveReasonToLegacyResolutionReason } from "./intervention-outcome-taxonomy.js";
import {
  getAiActionQueue,
  getCompanyCopilotView,
  dismissTaskSuggestion,
  getDealCopilotView,
  getDirectorBlindSpots,
  getAiOpsMetrics,
  getSalesProcessDisconnectDashboard,
  getAiReviewPacketDetail,
  getAiReviewQueue,
  recordAiFeedback,
  triageAiActionQueueEntry,
} from "./service.js";
import { acceptTaskSuggestion } from "./task-suggestion-service.js";

const router = Router();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOLUTION_REASONS = new Set([
  "task_completed",
  "follow_up_completed",
  "owner_aligned",
  "false_positive",
  "duplicate_case",
  "issue_no_longer_relevant",
]);
const INTERVENTION_QUEUE_VIEWS = new Set<InterventionQueueView>([
  "open",
  "all",
  "escalated",
  "unassigned",
  "aging",
  "repeat",
  "generated-task-pending",
  "overdue",
  "snooze-breached",
]);

function allowLegacyOutcomeWrites() {
  return process.env.ALLOW_LEGACY_OUTCOME_WRITES === "true";
}

async function assertDealAccess(req: any, dealId: string) {
  const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
  if (!deal) throw new AppError(404, "Deal not found");
  return deal;
}

async function assertCompanyAccess(req: any, companyId: string) {
  const company = await getCompanyById(req.tenantDb!, companyId);
  if (!company) throw new AppError(404, "Company not found");
  return company;
}

function getActiveOfficeId(req: any) {
  const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
  if (!officeId) {
    throw new AppError(400, "Active office is required");
  }
  return officeId;
}

async function recordManagerBriefServed(req: any) {
  const execute = req?.tenantDb?.execute;
  if (typeof execute !== "function") return;

  try {
    await execute(
      sql`
        INSERT INTO audit_log (table_name, record_id, action, changed_by, changes, full_row)
        VALUES (
          'intervention_manager_brief',
          ${getActiveOfficeId(req)},
          'update',
          ${req.user?.id ?? null},
          ${JSON.stringify({ event: "served", route: "/api/ai/ops/intervention-analytics" })}::jsonb,
          ${JSON.stringify({ servedAt: new Date().toISOString() })}::jsonb
        )
      `
    );
  } catch {
    // Brief telemetry must not take down analytics delivery.
  }
}

function requireCaseIds(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw new AppError(400, "caseIds must be a non-empty array of case ids");
  }
  return value;
}

function getPolicyRecommendationFixtureOfficeIds() {
  return (process.env.POLICY_RECOMMENDATION_FIXTURE_OFFICE_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readStructuredConclusion(
  body: any,
  kind: "resolve"
): StructuredResolveConclusion | null;
function readStructuredConclusion(
  body: any,
  kind: "snooze"
): StructuredSnoozeConclusion | null;
function readStructuredConclusion(
  body: any,
  kind: "escalate"
): StructuredEscalateConclusion | null;
function readStructuredConclusion(body: any, kind: "resolve" | "snooze" | "escalate") {
  if (body?.conclusion?.kind === kind) return body.conclusion;
  if (!allowLegacyOutcomeWrites()) {
    throw new AppError(400, `Structured ${kind} conclusion is required`);
  }
  return null;
}

function assertNoLegacyResolveConflict(input: {
  legacyResolutionReason?: string | null;
  structuredResolveConclusion?: { reasonCode?: string } | null;
}) {
  if (!input.legacyResolutionReason || !input.structuredResolveConclusion?.reasonCode) return;
  const mappedLegacy = mapStructuredResolveReasonToLegacyResolutionReason(
    input.structuredResolveConclusion.reasonCode
  );
  if (mappedLegacy !== input.legacyResolutionReason) {
    throw new AppError(400, "Legacy resolutionReason conflicts with structured conclusion");
  }
}

function assertNoLegacyConclusionConflict(input: {
  notes?: string | null;
  conclusion: { notes?: string | null } | null;
  kind: "snooze" | "escalate";
}) {
  if (input.notes && input.conclusion) {
    throw new AppError(400, `Legacy notes conflict with structured ${input.kind} conclusion`);
  }
}

router.get("/deals/:id/copilot", async (req, res, next) => {
  try {
    await assertDealAccess(req, req.params.id);
    const view = await getDealCopilotView(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(view);
  } catch (err) {
    next(err);
  }
});

router.get("/companies/:id/copilot", async (req, res, next) => {
  try {
    const company = await assertCompanyAccess(req, req.params.id);
    const view = await getCompanyCopilotView(req.tenantDb!, company);
    await req.commitTransaction!();
    res.json(view);
  } catch (err) {
    next(err);
  }
});

router.post("/deals/:id/regenerate", async (req, res, next) => {
  try {
    await assertDealAccess(req, req.params.id);
    await req.tenantDb!.insert(jobQueue).values({
      jobType: "ai_refresh_copilot",
      payload: {
        dealId: req.params.id,
        reason: "manual_regenerate",
        requestedBy: req.user!.id,
      },
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      status: "pending",
      runAfter: new Date(),
    });
    await req.commitTransaction!();
    res.status(202).json({ queued: true });
  } catch (err) {
    next(err);
  }
});

router.post("/task-suggestions/:id/accept", async (req, res, next) => {
  try {
    const result = await acceptTaskSuggestion(req.tenantDb!, req.params.id, req.user!.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/task-suggestions/:id/dismiss", async (req, res, next) => {
  try {
    const result = await dismissTaskSuggestion(req.tenantDb!, req.params.id, req.user!.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/feedback", async (req, res, next) => {
  try {
    const { targetType, targetId, feedbackType, feedbackValue, comment } = req.body;
    if (!targetType || !targetId || !feedbackType || !feedbackValue) {
      throw new AppError(400, "targetType, targetId, feedbackType, and feedbackValue are required");
    }
    if (String(targetType).length > 32) {
      throw new AppError(400, "targetType must be 32 characters or fewer");
    }
    if (!UUID_PATTERN.test(String(targetId))) {
      throw new AppError(400, "targetId must be a valid UUID");
    }
    if (String(feedbackType).length > 32) {
      throw new AppError(400, "feedbackType must be 32 characters or fewer");
    }
    if (String(feedbackValue).length > 32) {
      throw new AppError(400, "feedbackValue must be 32 characters or fewer");
    }

    const feedback = await recordAiFeedback(req.tenantDb!, {
      targetType,
      targetId,
      userId: req.user!.id,
      feedbackType,
      feedbackValue,
      comment: comment ?? null,
    });
    await req.commitTransaction!();
    res.status(201).json(feedback);
  } catch (err) {
    next(err);
  }
});

router.get("/blind-spots", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const blindSpots = await getDirectorBlindSpots(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ blindSpots });
  } catch (err) {
    next(err);
  }
});

router.get("/ops/metrics", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const metrics = await getAiOpsMetrics(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ metrics });
  } catch (err) {
    next(err);
  }
});

router.get("/ops/intervention-analytics", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const dashboard = await getInterventionAnalyticsDashboard(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
    });
    await recordManagerBriefServed(req);
    await req.commitTransaction!();
    res.json(dashboard);
  } catch (err) {
    next(err);
  }
});

router.get("/ops/intervention-manager-alerts", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const snapshot = await getLatestManagerAlertSnapshot(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
    });
    if (!snapshot) {
      throw new AppError(404, "Manager alert snapshot not found");
    }
    await req.commitTransaction!();
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/intervention-manager-alerts/scan", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const snapshot = await runManagerAlertPreview(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
    });
    await req.commitTransaction!();
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/intervention-manager-alerts/send", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const officeId = getActiveOfficeId(req);
    const recipients = (await req.tenantDb!.select().from(users)).filter(
      (user) =>
        user.officeId === officeId &&
        user.isActive &&
        (user.role === "admin" || user.role === "director")
    );

    let latestSnapshot = null;
    const deliveries = [];
    for (const recipient of recipients) {
      const result = await sendManagerAlertSummary(req.tenantDb!, {
        officeId,
        recipientUserId: recipient.id,
      });
      latestSnapshot = result.snapshot;
      deliveries.push({
        recipientUserId: recipient.id,
        claimed: result.claimed,
        notification: result.notification,
      });
    }

    await req.commitTransaction!();
    if (!latestSnapshot) {
      throw new AppError(404, "No active manager alert recipients found");
    }
    res.json({
      snapshot: latestSnapshot,
      deliveries,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/ops/intervention-policy-recommendations", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const view = await getInterventionPolicyRecommendationsView(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      viewerUserId: req.user!.id,
    });
    await req.commitTransaction!();
    res.json(view);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/intervention-policy-recommendations/regenerate", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const result = await regenerateInterventionPolicyRecommendations(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      requestedByUserId: req.user!.id,
    });
    await req.commitTransaction!();
    res.status(202).json({
      queued: result.queued,
      snapshotId: result.snapshotId,
      status: result.status,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/ops/intervention-policy-recommendations/:recommendationId/feedback",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const recommendationId = String(req.params.recommendationId ?? "");
      if (!UUID_PATTERN.test(recommendationId)) {
        throw new AppError(400, "recommendationId must be a valid UUID");
      }
      const feedbackValue = String(req.body?.feedbackValue ?? "");
      if (!["helpful", "not_useful", "wrong_direction"].includes(feedbackValue)) {
        throw new AppError(400, "feedbackValue must be helpful, not_useful, or wrong_direction");
      }
      const feedback = await recordInterventionPolicyRecommendationFeedback(req.tenantDb!, {
        officeId: getActiveOfficeId(req),
        recommendationId,
        userId: req.user!.id,
        feedbackValue: feedbackValue as "helpful" | "not_useful" | "wrong_direction",
        comment: typeof req.body?.comment === "string" ? req.body.comment : null,
      });
      await req.commitTransaction!();
      res.json(feedback);
    } catch (err) {
      next(err);
    }
  }
);

router.get("/ops/intervention-policy-recommendations/evaluation", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const window =
      req.query.window === "last_7_days" || req.query.window === "last_90_days" || req.query.window === "last_30_days"
        ? req.query.window
        : "last_30_days";
    const summary = await getInterventionPolicyRecommendationEvaluationSummary(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      window,
      taxonomy: typeof req.query.taxonomy === "string" ? (req.query.taxonomy as any) : null,
      decision: typeof req.query.decision === "string" ? req.query.decision : null,
    });
    await req.commitTransaction!();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.get("/ops/intervention-policy-recommendations/review", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const window =
      req.query.window === "last_7_days" || req.query.window === "last_90_days" || req.query.window === "last_30_days"
        ? req.query.window
        : "last_30_days";
    const decision =
      req.query.decision === "rendered" || req.query.decision === "suppressed" || req.query.decision === "all"
        ? req.query.decision
        : "all";
    const review = await getInterventionPolicyRecommendationReview(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      viewerUserId: req.user!.id,
      window,
      decision,
    });
    await req.commitTransaction!();
    res.json(review);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/intervention-policy-recommendations/dev/seed-qualification", requireRole("admin"), async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === "production") {
      throw new AppError(404, "Not found");
    }

    const officeId = getActiveOfficeId(req);
    const seedKey =
      typeof req.body?.seedKey === "string" && req.body.seedKey.trim().length > 0
        ? req.body.seedKey.trim()
        : undefined;
    const seeded = await seedInterventionPolicyRecommendationQualificationData(req.tenantDb!, {
      officeId,
      actorUserId: req.user!.id,
      environment: process.env.NODE_ENV ?? "development",
      allowedOfficeIds: getPolicyRecommendationFixtureOfficeIds(),
      seedKey,
    });
    const generation = await regenerateInterventionPolicyRecommendations(req.tenantDb!, {
      officeId,
      requestedByUserId: req.user!.id,
    });

    await req.commitTransaction!();
    res.json({
      ...seeded,
      generation: {
        snapshotId: generation.snapshotId,
        status: generation.status,
        recommendationCount: generation.recommendations?.length ?? null,
        taxonomies: generation.recommendations?.map((item) => item.taxonomy) ?? [],
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/ops/intervention-policy-recommendations/:recommendationId/apply", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const recommendationId = String(req.params.recommendationId ?? "");
    if (!UUID_PATTERN.test(recommendationId)) {
      throw new AppError(400, "recommendationId must be a valid UUID");
    }
    const snapshotId = typeof req.body?.snapshotId === "string" ? req.body.snapshotId : null;
    const recommendationIdempotencyKey =
      typeof req.body?.recommendationIdempotencyKey === "string" ? req.body.recommendationIdempotencyKey : null;
    if (!snapshotId || !UUID_PATTERN.test(snapshotId)) {
      throw new AppError(400, "snapshotId must be a valid UUID");
    }
    if (!recommendationIdempotencyKey) {
      throw new AppError(400, "recommendationIdempotencyKey is required");
    }
    const result = await applyInterventionPolicyRecommendation(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      recommendationId,
      snapshotId,
      actorUserId: req.user!.id,
      recommendationIdempotencyKey,
    });
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/intervention-policy-recommendations/:recommendationId/revert", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const recommendationId = String(req.params.recommendationId ?? "");
    if (!UUID_PATTERN.test(recommendationId)) {
      throw new AppError(400, "recommendationId must be a valid UUID");
    }
    const snapshotId = typeof req.body?.snapshotId === "string" ? req.body.snapshotId : null;
    const recommendationIdempotencyKey =
      typeof req.body?.recommendationIdempotencyKey === "string" ? req.body.recommendationIdempotencyKey : null;
    if (!snapshotId || !UUID_PATTERN.test(snapshotId)) {
      throw new AppError(400, "snapshotId must be a valid UUID");
    }
    if (!recommendationIdempotencyKey) {
      throw new AppError(400, "recommendationIdempotencyKey is required");
    }
    const result = await revertInterventionPolicyRecommendation(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      recommendationId,
      snapshotId,
      actorUserId: req.user!.id,
      recommendationIdempotencyKey,
    });
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/ops/reviews", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const reviews = await getAiReviewQueue(req.tenantDb!, { limit });
    await req.commitTransaction!();
    res.json({ reviews });
  } catch (err) {
    next(err);
  }
});

router.get("/ops/action-queue", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const queue = await getAiActionQueue(req.tenantDb!, { limit });
    await req.commitTransaction!();
    res.json({ queue });
  } catch (err) {
    next(err);
  }
});

router.get("/ops/interventions", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const page = typeof req.query.page === "string" ? Number(req.query.page) : undefined;
    const pageSize = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const status =
      typeof req.query.status === "string" &&
      (req.query.status === "open" || req.query.status === "snoozed" || req.query.status === "resolved")
        ? req.query.status
        : undefined;
    const view =
      typeof req.query.view === "string" && INTERVENTION_QUEUE_VIEWS.has(req.query.view as InterventionQueueView)
        ? (req.query.view as InterventionQueueView)
        : undefined;
    const clusterKey =
      typeof req.query.clusterKey === "string" && req.query.clusterKey.length > 0
        ? req.query.clusterKey
        : undefined;
    const filters: InterventionQueueFilters = {
      caseId: typeof req.query.caseId === "string" && req.query.caseId.length > 0 ? req.query.caseId : undefined,
      severity: typeof req.query.severity === "string" && req.query.severity.length > 0 ? req.query.severity : undefined,
      disconnectType:
        typeof req.query.disconnectType === "string" && req.query.disconnectType.length > 0
          ? req.query.disconnectType
          : undefined,
      assigneeId:
        typeof req.query.assigneeId === "string" && req.query.assigneeId.length > 0 ? req.query.assigneeId : undefined,
      repId: typeof req.query.repId === "string" && req.query.repId.length > 0 ? req.query.repId : undefined,
      companyId:
        typeof req.query.companyId === "string" && req.query.companyId.length > 0 ? req.query.companyId : undefined,
      stageKey:
        typeof req.query.stageKey === "string" && req.query.stageKey.length > 0 ? req.query.stageKey : undefined,
    };

    const result = await listInterventionCases(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      page,
      pageSize,
      status,
      view,
      clusterKey,
      filters,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/ops/interventions/:id", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const caseId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const detail = await getInterventionCaseDetail(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      caseId,
    });

    await req.commitTransaction!();
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.get("/ops/interventions/:id/copilot", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const caseId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const view = await buildInterventionCopilotView(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      caseId,
      viewerUserId: req.user!.id,
    });

    await req.commitTransaction!();
    res.json(view);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/interventions/:id/copilot/regenerate", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const caseId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await regenerateInterventionCopilot(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      caseId,
      requestedBy: req.user!.id,
    });

    await req.commitTransaction!();
    res.status(result.queued ? 202 : 200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/interventions/batch-assign", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const assignedTo = typeof req.body?.assignedTo === "string" ? req.body.assignedTo : null;
    if (!assignedTo) throw new AppError(400, "assignedTo is required");

    const result = await assignInterventionCases(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      actorUserId: req.user!.id,
      actorRole: req.user!.role,
      caseIds: requireCaseIds(req.body?.caseIds),
      assignedTo,
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/interventions/batch-snooze", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const snoozedUntil = typeof req.body?.snoozedUntil === "string" ? req.body.snoozedUntil : null;
    if (!snoozedUntil) throw new AppError(400, "snoozedUntil is required");
    const conclusion = readStructuredConclusion(req.body, "snooze");
    assertNoLegacyConclusionConflict({
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
      conclusion,
      kind: "snooze",
    });
    const caseIds = requireCaseIds(req.body?.caseIds);
    if (conclusion) {
      await assertHomogeneousBatchConclusionCohort(req.tenantDb!, getActiveOfficeId(req), caseIds, "snooze");
    }

    const result = await snoozeInterventionCases(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      actorUserId: req.user!.id,
      actorRole: req.user!.role,
      caseIds,
      snoozedUntil,
      conclusion,
      allowLegacyOutcomeWrites: allowLegacyOutcomeWrites(),
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/interventions/batch-resolve", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const conclusion = readStructuredConclusion(req.body, "resolve");
    const legacyResolutionReason = typeof req.body?.resolutionReason === "string" ? req.body.resolutionReason : null;
    const resolutionReason =
      legacyResolutionReason ??
      (conclusion ? mapStructuredResolveReasonToLegacyResolutionReason(conclusion.reasonCode) : null);
    if (!resolutionReason) throw new AppError(400, "resolutionReason is required");
    if (!RESOLUTION_REASONS.has(resolutionReason)) {
      throw new AppError(400, "Invalid resolutionReason");
    }
    assertNoLegacyResolveConflict({
      legacyResolutionReason,
      structuredResolveConclusion: conclusion,
    });
    const caseIds = requireCaseIds(req.body?.caseIds);
    if (conclusion) {
      await assertHomogeneousBatchConclusionCohort(req.tenantDb!, getActiveOfficeId(req), caseIds, "resolve");
    }

    const result = await resolveInterventionCases(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      actorUserId: req.user!.id,
      actorRole: req.user!.role,
      caseIds,
      resolutionReason: resolutionReason as Parameters<typeof resolveInterventionCases>[1]["resolutionReason"],
      conclusion,
      allowLegacyOutcomeWrites: allowLegacyOutcomeWrites(),
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/interventions/batch-escalate", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const conclusion = readStructuredConclusion(req.body, "escalate");
    assertNoLegacyConclusionConflict({
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
      conclusion,
      kind: "escalate",
    });
    const caseIds = requireCaseIds(req.body?.caseIds);
    if (conclusion) {
      await assertHomogeneousBatchConclusionCohort(req.tenantDb!, getActiveOfficeId(req), caseIds, "escalate");
    }
    const result = await escalateInterventionCases(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      actorUserId: req.user!.id,
      actorRole: req.user!.role,
      caseIds,
      conclusion,
      allowLegacyOutcomeWrites: allowLegacyOutcomeWrites(),
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/interventions/:id/assign", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const caseId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const assignedTo = typeof req.body?.assignedTo === "string" ? req.body.assignedTo : null;
    if (!assignedTo) throw new AppError(400, "assignedTo is required");

    const result = await assignInterventionCases(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      actorUserId: req.user!.id,
      actorRole: req.user!.role,
      caseIds: [caseId],
      assignedTo,
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/interventions/:id/snooze", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const caseId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const snoozedUntil = typeof req.body?.snoozedUntil === "string" ? req.body.snoozedUntil : null;
    if (!snoozedUntil) throw new AppError(400, "snoozedUntil is required");
    const conclusion = readStructuredConclusion(req.body, "snooze");
    assertNoLegacyConclusionConflict({
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
      conclusion,
      kind: "snooze",
    });

    const result = await snoozeInterventionCases(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      actorUserId: req.user!.id,
      actorRole: req.user!.role,
      caseIds: [caseId],
      snoozedUntil,
      conclusion,
      allowLegacyOutcomeWrites: allowLegacyOutcomeWrites(),
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/interventions/:id/resolve", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const caseId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const conclusion = readStructuredConclusion(req.body, "resolve");
    const legacyResolutionReason = typeof req.body?.resolutionReason === "string" ? req.body.resolutionReason : null;
    const resolutionReason =
      legacyResolutionReason ??
      (conclusion ? mapStructuredResolveReasonToLegacyResolutionReason(conclusion.reasonCode) : null);
    if (!resolutionReason) throw new AppError(400, "resolutionReason is required");
    if (!RESOLUTION_REASONS.has(resolutionReason)) {
      throw new AppError(400, "Invalid resolutionReason");
    }
    assertNoLegacyResolveConflict({
      legacyResolutionReason,
      structuredResolveConclusion: conclusion,
    });

    const result = await resolveInterventionCases(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      actorUserId: req.user!.id,
      actorRole: req.user!.role,
      caseIds: [caseId],
      resolutionReason: resolutionReason as Parameters<typeof resolveInterventionCases>[1]["resolutionReason"],
      conclusion,
      allowLegacyOutcomeWrites: allowLegacyOutcomeWrites(),
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/interventions/:id/escalate", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const caseId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const conclusion = readStructuredConclusion(req.body, "escalate");
    assertNoLegacyConclusionConflict({
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
      conclusion,
      kind: "escalate",
    });
    const result = await escalateInterventionCases(req.tenantDb!, {
      officeId: getActiveOfficeId(req),
      actorUserId: req.user!.id,
      actorRole: req.user!.role,
      caseIds: [caseId],
      conclusion,
      allowLegacyOutcomeWrites: allowLegacyOutcomeWrites(),
      notes: typeof req.body?.notes === "string" ? req.body.notes : null,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/ops/process-disconnects", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const dashboard = await getSalesProcessDisconnectDashboard(req.tenantDb!, { limit });
    await req.commitTransaction!();
    res.json(dashboard);
  } catch (err) {
    next(err);
  }
});

router.get("/ops/reviews/:packetId", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const packetId = Array.isArray(req.params.packetId) ? req.params.packetId[0] : req.params.packetId;
    const detail = await getAiReviewPacketDetail(req.tenantDb!, packetId);
    await req.commitTransaction!();
    if (!detail.packet) {
      throw new AppError(404, "AI packet not found");
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/action-queue/:entryType/:id", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const entryType = Array.isArray(req.params.entryType) ? req.params.entryType[0] : req.params.entryType;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (entryType !== "blind_spot" && entryType !== "task_suggestion") {
      throw new AppError(400, "entryType must be blind_spot or task_suggestion");
    }

    const action = typeof req.body?.action === "string" ? req.body.action : "";
    if (!["mark_reviewed", "resolve", "dismiss", "escalate"].includes(action)) {
      throw new AppError(400, "Invalid triage action");
    }

    const result = await triageAiActionQueueEntry(req.tenantDb!, {
      entryType,
      id,
      action: action as "mark_reviewed" | "resolve" | "dismiss" | "escalate",
      userId: req.user!.id,
      comment: typeof req.body?.comment === "string" ? req.body.comment : null,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/ops/backfill", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    if (!officeId) {
      throw new AppError(400, "Active office is required to queue AI backfill");
    }

    const sourceType = typeof req.body?.sourceType === "string" ? req.body.sourceType : null;
    const batchSize =
      typeof req.body?.batchSize === "number" && Number.isFinite(req.body.batchSize)
        ? Math.max(1, Math.min(req.body.batchSize, 250))
        : 100;

    await req.tenantDb!.insert(jobQueue).values({
      jobType: "ai_backfill_documents",
      payload: {
        officeId,
        sourceType,
        batchSize,
        requestedBy: req.user!.id,
      },
      officeId,
      status: "pending",
      runAfter: new Date(),
    });

    await req.commitTransaction!();
    res.status(202).json({ queued: true, sourceType, batchSize });
  } catch (err) {
    next(err);
  }
});

router.post("/ops/disconnect-digest", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    if (!officeId) {
      throw new AppError(400, "Active office is required to queue AI disconnect digest");
    }

    const mode = typeof req.body?.mode === "string" ? req.body.mode : "manual";

    await req.tenantDb!.insert(jobQueue).values({
      jobType: "ai_disconnect_digest",
      payload: {
        officeId,
        mode,
        requestedBy: req.user!.id,
      },
      officeId,
      status: "pending",
      runAfter: new Date(),
    });

    await req.commitTransaction!();
    res.status(202).json({ queued: true, mode });
  } catch (err) {
    next(err);
  }
});

router.post("/ops/disconnect-escalation-scan", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    if (!officeId) {
      throw new AppError(400, "Active office is required to queue AI disconnect escalation scan");
    }

    const mode = typeof req.body?.mode === "string" ? req.body.mode : "manual";

    await req.tenantDb!.insert(jobQueue).values({
      jobType: "ai_disconnect_escalation_scan",
      payload: {
        officeId,
        mode,
        requestedBy: req.user!.id,
      },
      officeId,
      status: "pending",
      runAfter: new Date(),
    });

    await req.commitTransaction!();
    res.status(202).json({ queued: true, mode });
  } catch (err) {
    next(err);
  }
});

router.post("/ops/disconnect-admin-tasks", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    if (!officeId) {
      throw new AppError(400, "Active office is required to queue AI disconnect admin tasks");
    }

    const mode = typeof req.body?.mode === "string" ? req.body.mode : "manual";

    await req.tenantDb!.insert(jobQueue).values({
      jobType: "ai_disconnect_admin_tasks",
      payload: {
        officeId,
        mode,
        requestedBy: req.user!.id,
      },
      officeId,
      status: "pending",
      runAfter: new Date(),
    });

    await req.commitTransaction!();
    res.status(202).json({ queued: true, mode });
  } catch (err) {
    next(err);
  }
});

export const aiCopilotRoutes = router;
