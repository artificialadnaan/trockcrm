import { Router } from "express";
import { startSession, recordHeartbeat } from "./collection-service.js";

const router = Router();

// Endpoints are added in Tasks 9–11.

router.post("/session/start", async (req, res, next) => {
  try {
    const userAgentHeader = req.headers["user-agent"];
    const result = await startSession(req.tenantDb!, {
      userId: req.user!.id,
      userAgent: typeof userAgentHeader === "string" ? userAgentHeader.slice(0, 500) : null,
      // No impersonation feature currently sets this; null today, forward-compatible (matches auditLog).
      impersonatorId: (req as { impersonatorId?: string | null }).impersonatorId ?? null,
    });
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/heartbeat", async (req, res, next) => {
  try {
    const sessionId = (req.body as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string") {
      return res.status(400).json({ error: "sessionId required" });
    }
    await recordHeartbeat(req.tenantDb!, { userId: req.user!.id, sessionId });
    await req.commitTransaction!();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
