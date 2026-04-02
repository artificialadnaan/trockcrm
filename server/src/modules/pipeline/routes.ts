import { Router } from "express";
import {
  getAllStages,
  getActiveLostReasons,
  getActiveProjectTypes,
  getActiveRegions,
} from "./service.js";

const router = Router();

// GET /api/pipeline/stages — all pipeline stages (ordered)
router.get("/stages", async (req, res, next) => {
  try {
    const stages = await getAllStages();
    await req.commitTransaction!();
    res.json({ stages });
  } catch (err) {
    next(err);
  }
});

// GET /api/pipeline/lost-reasons — active lost deal reasons
router.get("/lost-reasons", async (req, res, next) => {
  try {
    const reasons = await getActiveLostReasons();
    await req.commitTransaction!();
    res.json({ reasons });
  } catch (err) {
    next(err);
  }
});

// GET /api/pipeline/project-types — active project types (hierarchical)
router.get("/project-types", async (req, res, next) => {
  try {
    const types = await getActiveProjectTypes();
    await req.commitTransaction!();
    res.json({ projectTypes: types });
  } catch (err) {
    next(err);
  }
});

// GET /api/pipeline/regions — active regions
router.get("/regions", async (req, res, next) => {
  try {
    const regions = await getActiveRegions();
    await req.commitTransaction!();
    res.json({ regions });
  } catch (err) {
    next(err);
  }
});

export const pipelineRoutes = router;
