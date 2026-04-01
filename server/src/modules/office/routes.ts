import { Router } from "express";

const router = Router();

// Placeholder — office management routes will be added in a later task
router.get("/", (_req, res) => {
  res.json({ offices: [] });
});

export const officeRoutes = router;
