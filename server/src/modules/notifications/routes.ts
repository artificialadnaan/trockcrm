import { type Response, Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import {
  registerSseConnection,
  canAdmitSseConnection,
  writeSse,
  buildSsePaddingComment,
} from "./sse-manager.js";

const router = Router();

function applyNotificationTransportHeaders(res: Response) {
  // These responses are per-user and consumed cross-origin by the Railway frontend.
  // Mark them non-cacheable so Railway/Fastly never attempts to reuse or buffer them
  // across users or requests, which can surface edge-generated 502s without CORS headers.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0, no-transform");
  res.setHeader("CDN-Cache-Control", "private, no-store");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

// SSE notification stream
router.get("/stream", authMiddleware, (req, res) => {
  applyNotificationTransportHeaders(res);

  // Check global connection limit BEFORE sending headers
  if (!canAdmitSseConnection()) {
    res.status(503).json({ error: { message: "Too many SSE connections" } });
    return;
  }

  // Preserve headers already set by global middleware such as CORS.
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering on Railway
  res.flushHeaders();

  // Warm proxy/CDN buffers so the first real SSE event reaches browsers immediately.
  writeSse(res, buildSsePaddingComment());

  // Send initial connection event
  writeSse(res, `event: connected\ndata: ${JSON.stringify({ userId: req.user!.id })}\n\n`);

  // Register this connection for real-time push
  const cleanup = registerSseConnection(
    req.user!.id,
    req.user!.activeOfficeId ?? req.user!.officeId,
    res
  );

  // Keepalive ping every 30 seconds
  const keepalive = setInterval(() => {
    writeSse(res, `: keepalive\n\n`);
  }, 30000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(keepalive);
    cleanup();
  });
});

export const notificationRoutes = router;
