import { Router } from "express";
import { requireAuth, requireRole } from "../../lib/auth.js";
import {
  adminProgress,
  adminProgressByUser,
  adminProgressSummary,
  adminProgressUser,
  adminProgressUserExport,
  adminSkips,
  bulkReassignRecords,
  cleanupSummaryReport,
  completeOnboarding,
  createProperty,
  flagDuplicate,
  historicalPass,
  patchRecord,
  progressForUser,
  queueForUser,
  recordDetail,
  reassignRecord,
  reassignmentRecords,
  reassignmentUsers,
  searchEntities,
  skipRecord,
} from "./service.js";

export const cleanupRouter = Router();

cleanupRouter.use(requireAuth);

function statusOf(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : 500;
}

function detailsOf(error: unknown) {
  return typeof error === "object" && error !== null && "details" in error ? (error as { details: unknown }).details : undefined;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Internal server error";
}

function sendError(res: { status: (status: number) => { json: (body: unknown) => void } }, error: unknown) {
  const status = statusOf(error);
  const body: Record<string, unknown> = {
    error: status >= 500 ? "Internal server error" : messageOf(error),
  };
  const details = detailsOf(error);
  if (details) body.details = details;
  if (status >= 500) console.error(error);
  res.status(status).json(body);
}

cleanupRouter.get("/queue", async (req, res) => {
  try {
    res.json(await queueForUser(req.user!));
  } catch (error) {
    sendError(res, error);
  }
});

cleanupRouter.get("/progress", async (req, res) => {
  try {
    res.json(await progressForUser(req.user!));
  } catch (error) {
    sendError(res, error);
  }
});

cleanupRouter.get("/record/:type/:id", async (req, res) => {
  try {
    const record = await recordDetail(req.params.type, req.params.id, req.user!);
    if (!record) return res.status(404).json({ error: "Record not found" });
    return res.json(record);
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.patch("/record/:type/:id", async (req, res) => {
  try {
    const record = await patchRecord(req.params.type, req.params.id, req.user!, req.body ?? {});
    return res.json(record);
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.post("/record/:type/:id/skip", async (req, res) => {
  try {
    const result = await skipRecord(req.params.type, req.params.id, req.user!, String(req.body?.skip_reason ?? ""), req.body?.skip_notes);
    return res.json(result);
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.post("/record/:type/:id/flag-duplicate", async (req, res) => {
  try {
    const result = await flagDuplicate(req.params.type, req.params.id, req.user!);
    return res.json(result);
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.post("/bulk/historical-pass", async (req, res) => {
  try {
    const recordType = req.body?.record_type ?? req.body?.type ?? "deal";
    if (recordType !== "deal") return res.status(400).json({ error: "Only deal historical pass is supported" });
    return res.json(await historicalPass(req.user!, false));
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.post("/complete-onboarding", async (req, res) => {
  try {
    return res.json(await completeOnboarding(req.user!));
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.get("/search/:entity", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    return res.json(await searchEntities(req.params.entity, q));
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.post("/properties", async (req, res) => {
  try {
    return res.status(201).json(await createProperty(req.body ?? {}));
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.get("/admin/progress", requireRole("admin", "director"), async (_req, res) => {
  try {
    return res.json(await adminProgress());
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.get("/admin/progress/summary", requireRole("admin", "director"), async (_req, res) => {
  try {
    return res.json(await adminProgressSummary());
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.get("/admin/progress/by-user", requireRole("admin", "director"), async (_req, res) => {
  try {
    return res.json(await adminProgressByUser());
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.get("/admin/progress/user/:userId", requireRole("admin", "director"), async (req, res) => {
  try {
    const page = typeof req.query.page === "string" ? Number.parseInt(req.query.page, 10) : 1;
    return res.json(await adminProgressUser(String(req.params.userId), Number.isFinite(page) ? page : 1));
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.get("/admin/progress/user/:userId/export", requireRole("admin", "director"), async (req, res) => {
  try {
    const format = typeof req.query.format === "string" ? req.query.format : "csv";
    const userId = String(req.params.userId);
    const exportResult = await adminProgressUserExport(userId, format);
    res.setHeader("content-type", exportResult.contentType);
    res.setHeader("content-disposition", `attachment; filename=\"cleanup-activity-${userId}.${format === "json" ? "json" : "csv"}\"`);
    return res.send(exportResult.body);
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.get("/admin/reports/cleanup-summary", requireRole("admin", "director"), async (_req, res) => {
  try {
    return res.json(await cleanupSummaryReport());
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.get("/admin/reassignment-users", requireRole("admin", "director"), async (_req, res) => {
  try {
    return res.json(await reassignmentUsers());
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.get("/admin/reassignment-records", requireRole("admin", "director"), async (req, res) => {
  try {
    const page = typeof req.query.page === "string" ? Number.parseInt(req.query.page, 10) : 1;
    return res.json(await reassignmentRecords({
      type: typeof req.query.type === "string" ? req.query.type : "all",
      q: typeof req.query.q === "string" ? req.query.q : "",
      owner: typeof req.query.owner === "string" ? req.query.owner : "all",
      page: Number.isFinite(page) ? page : 1,
    }));
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.get("/admin/skips", requireRole("admin", "director"), async (req, res) => {
  try {
    const reason = typeof req.query.reason === "string" ? req.query.reason : undefined;
    return res.json(await adminSkips(reason));
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.post("/admin/users/:userId/complete-onboarding", requireRole("admin", "director"), async (req, res) => {
  try {
    return res.json(await completeOnboarding(req.user!, String(req.params.userId), String(req.body?.reason ?? "")));
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.post("/admin/bulk-historical-pass-global", requireRole("admin", "director"), async (req, res) => {
  try {
    return res.json(await historicalPass(req.user!, true));
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.post("/admin/records/:type/:id/reassign", requireRole("admin", "director"), async (req, res) => {
  try {
    const newAssignedToUserId = typeof req.body?.newAssignedToUserId === "string" ? req.body.newAssignedToUserId : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    return res.json(await reassignRecord(String(req.params.type), String(req.params.id), newAssignedToUserId, req.user!, reason));
  } catch (error) {
    return sendError(res, error);
  }
});

cleanupRouter.post("/admin/records/bulk-reassign", requireRole("admin", "director"), async (req, res) => {
  try {
    const type = typeof req.body?.type === "string" ? req.body.type : "";
    const recordIds = Array.isArray(req.body?.recordIds) ? req.body.recordIds.map(String) : [];
    const newAssignedToUserId = typeof req.body?.newAssignedToUserId === "string" ? req.body.newAssignedToUserId : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    return res.json(await bulkReassignRecords(type, recordIds, newAssignedToUserId, req.user!, reason));
  } catch (error) {
    return sendError(res, error);
  }
});
