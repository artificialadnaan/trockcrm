import { Router } from "express";
import { jobQueue } from "@trock-crm/shared/schema";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import { getDealById } from "../deals/service.js";
import {
  dismissTaskSuggestion,
  getDealCopilotView,
  getDirectorBlindSpots,
  getAiOpsMetrics,
  getAiReviewPacketDetail,
  getAiReviewQueue,
  recordAiFeedback,
} from "./service.js";
import { acceptTaskSuggestion } from "./task-suggestion-service.js";

const router = Router();

async function assertDealAccess(req: any, dealId: string) {
  const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
  if (!deal) throw new AppError(404, "Deal not found");
  return deal;
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

export const aiCopilotRoutes = router;
