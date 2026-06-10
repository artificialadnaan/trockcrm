import { Router } from "express";
import { startSession, recordHeartbeat, recordViewEvents, type ViewEventInput } from "./collection-service.js";

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

router.post("/events", async (req, res, next) => {
  try {
    const body = req.body as { sessionId?: unknown; events?: unknown };
    if (typeof body.sessionId !== "string" || !Array.isArray(body.events)) {
      return res.status(400).json({ error: "sessionId and events[] required" });
    }
    const events: ViewEventInput[] = body.events.slice(0, 200).map((raw) => {
      const e = raw as Record<string, unknown>;
      return {
        entityType: typeof e.entityType === "string" ? e.entityType : "page",
        entityId: typeof e.entityId === "string" ? e.entityId : null,
        route: typeof e.route === "string" ? e.route : "",
        labelSnapshot: typeof e.labelSnapshot === "string" ? e.labelSnapshot : null,
      };
    });
    await recordViewEvents(req.tenantDb!, req.user!.id, body.sessionId, events);
    await req.commitTransaction!();
    res.json({ ok: true, accepted: events.length });
  } catch (err) {
    next(err);
  }
});

export default router;
