import { Router } from "express";

const router = Router();

// Placeholder — SSE notification endpoint will be added in a later task
router.get("/stream", (_req, res) => {
  res.json({ message: "SSE not yet implemented" });
});

export const notificationRoutes = router;
