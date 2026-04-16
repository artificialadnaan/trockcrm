import { Router } from "express";
import { jobQueue } from "@trock-crm/shared/schema";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import { getDealById } from "../deals/service.js";
import { getCompanyById } from "../companies/service.js";
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
