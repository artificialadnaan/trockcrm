import { Router } from "express";
import { startSession } from "./collection-service.js";

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

export default router;
