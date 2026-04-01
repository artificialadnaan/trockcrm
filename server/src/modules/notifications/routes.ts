import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";

const router = Router();

// SSE notification stream
router.get("/stream", authMiddleware, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering on Railway
  });

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ userId: req.user!.id })}\n\n`);

  // Keepalive ping every 30 seconds
  const keepalive = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 30000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(keepalive);
  });

  // TODO: In later plans, subscribe to eventBus for this user's notifications
  // and push them as SSE events:
  // eventBus.on("notification.created", (event) => {
  //   if (event.payload.userId === req.user!.id) {
  //     res.write(`event: notification\ndata: ${JSON.stringify(event.payload)}\n\n`);
  //   }
  // });
});

export const notificationRoutes = router;
