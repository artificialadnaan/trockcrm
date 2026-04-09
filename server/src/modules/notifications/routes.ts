import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { registerSseConnection, canAdmitSseConnection } from "./sse-manager.js";

const router = Router();

// SSE notification stream
router.get("/stream", authMiddleware, (req, res) => {
  // Check global connection limit BEFORE sending headers
  if (!canAdmitSseConnection()) {
    res.status(503).json({ error: { message: "Too many SSE connections" } });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering on Railway
  });

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ userId: req.user!.id })}\n\n`);

  // Register this connection for real-time push
  const cleanup = registerSseConnection(
    req.user!.id,
    req.user!.activeOfficeId ?? req.user!.officeId,
    res
  );

  // Keepalive ping every 30 seconds
  const keepalive = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 30000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(keepalive);
    cleanup();
  });
});

export const notificationRoutes = router;
