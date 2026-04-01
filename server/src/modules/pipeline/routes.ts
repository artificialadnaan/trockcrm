import { Router } from "express";
import {
  getAllStages,
  getActiveLostReasons,
  getActiveProjectTypes,
  getActiveRegions,
} from "./service.js";

const router = Router();

// GET /api/pipeline/stages — all pipeline stages (ordered)
router.get("/stages", async (_req, res, next) => {
  try {
    const stages = await getAllStages();
    res.json({ stages });
  } catch (err) {
    next(err);
  }
});

// GET /api/pipeline/lost-reasons — active lost deal reasons
router.get("/lost-reasons", async (_req, res, next) => {
  try {
    const reasons = await getActiveLostReasons();
    res.json({ reasons });
  } catch (err) {
    next(err);
  }
});

// GET /api/pipeline/project-types — active project types (hierarchical)
router.get("/project-types", async (_req, res, next) => {
  try {
    const types = await getActiveProjectTypes();
    res.json({ projectTypes: types });
  } catch (err) {
    next(err);
  }
});

// GET /api/pipeline/regions — active regions
router.get("/regions", async (_req, res, next) => {
  try {
    const regions = await getActiveRegions();
    res.json({ regions });
  } catch (err) {
    next(err);
  }
});

export const pipelineRoutes = router;
