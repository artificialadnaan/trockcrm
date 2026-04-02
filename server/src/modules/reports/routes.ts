import { Router } from "express";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  getPipelineSummary,
  getWeightedPipelineForecast,
  getWinLossRatioByRep,
  getWinRateTrend,
  getActivitySummaryByRep,
  getStaleDeals,
  getLostDealsByReason,
  getRevenueByProjectType,
  getLeadSourceROI,
  getFollowUpCompliance,
  getDdVsPipeline,
  executeCustomReport,
} from "./service.js";
import type { ReportConfig } from "./service.js";
import {
  getSavedReports,
  getSavedReportById,
  createSavedReport,
  updateSavedReport,
  deleteSavedReport,
  seedLockedReports,
} from "./saved-reports-service.js";

const router = Router();

// -------------------------------------------------------------------------
// Locked report execution endpoints
// -------------------------------------------------------------------------

// GET /api/reports/pipeline-summary?includeDd=false&from=2026-01-01&to=2026-12-31
router.get("/pipeline-summary", async (req, res, next) => {
  try {
    const data = await getPipelineSummary(req.tenantDb!, {
      includeDd: req.query.includeDd === "true",
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/weighted-forecast?from=2026-01-01&to=2026-12-31
router.get("/weighted-forecast", async (req, res, next) => {
  try {
    const data = await getWeightedPipelineForecast(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/win-loss?from=2026-01-01&to=2026-12-31
router.get("/win-loss", async (req, res, next) => {
  try {
    const data = await getWinLossRatioByRep(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/win-rate-trend?from=2026-01-01&to=2026-12-31&repId=uuid
router.get("/win-rate-trend", async (req, res, next) => {
  try {
    const data = await getWinRateTrend(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      repId: req.query.repId as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/activity-summary?from=2026-01-01&to=2026-12-31
router.get("/activity-summary", async (req, res, next) => {
  try {
    const data = await getActivitySummaryByRep(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/stale-deals?repId=uuid
router.get("/stale-deals", async (req, res, next) => {
  try {
    const data = await getStaleDeals(req.tenantDb!, {
      repId: req.query.repId as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/lost-by-reason?from=2026-01-01&to=2026-12-31
router.get("/lost-by-reason", async (req, res, next) => {
  try {
    const data = await getLostDealsByReason(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/revenue-by-type?from=2026-01-01&to=2026-12-31
router.get("/revenue-by-type", async (req, res, next) => {
  try {
    const data = await getRevenueByProjectType(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/lead-source-roi?from=2026-01-01&to=2026-12-31
router.get("/lead-source-roi", async (req, res, next) => {
  try {
    const data = await getLeadSourceROI(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/follow-up-compliance?repId=uuid&from=2026-01-01&to=2026-12-31
router.get("/follow-up-compliance", async (req, res, next) => {
  try {
    const repId = (req.query.repId as string) || req.user!.id;
    const data = await getFollowUpCompliance(req.tenantDb!, repId, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/dd-vs-pipeline
router.get("/dd-vs-pipeline", async (req, res, next) => {
  try {
    const data = await getDdVsPipeline(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------------
// Custom report execution
// -------------------------------------------------------------------------

// POST /api/reports/execute -- run a custom report config
router.post("/execute", async (req, res, next) => {
  try {
    const config = req.body.config as ReportConfig;
    if (!config || !config.entity) {
      throw new AppError(400, "config with entity is required");
    }
    const page = req.body.page ? parseInt(req.body.page, 10) : 1;
    const limit = req.body.limit ? parseInt(req.body.limit, 10) : 100;

    const data = await executeCustomReport(req.tenantDb!, config, { page, limit });
    await req.commitTransaction!();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------------
// Saved reports CRUD
// -------------------------------------------------------------------------

// GET /api/reports/saved -- list saved reports visible to the user
router.get("/saved", async (req, res, next) => {
  try {
    const reports = await getSavedReports(
      req.user!.id,
      req.user!.activeOfficeId ?? req.user!.officeId
    );
    await req.commitTransaction!();
    res.json({ reports });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/saved/:id -- get a single saved report
router.get("/saved/:id", async (req, res, next) => {
  try {
    const report = await getSavedReportById(req.params.id);
    if (!report) throw new AppError(404, "Report not found");
    await req.commitTransaction!();
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

// POST /api/reports/saved -- create a custom report
router.post("/saved", async (req, res, next) => {
  try {
    const { name, entity, config, visibility } = req.body;
    if (!name || !entity || !config) {
      throw new AppError(400, "name, entity, and config are required");
    }

    const report = await createSavedReport({
      name,
      entity,
      config,
      visibility,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      createdBy: req.user!.id,
    });
    await req.commitTransaction!();
    res.status(201).json({ report });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/reports/saved/:id -- update a custom report
router.patch("/saved/:id", async (req, res, next) => {
  try {
    const report = await updateSavedReport(
      req.params.id,
      req.body,
      req.user!.id
    );
    await req.commitTransaction!();
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/reports/saved/:id -- delete a custom report
router.delete("/saved/:id", async (req, res, next) => {
  try {
    const result = await deleteSavedReport(req.params.id, req.user!.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/reports/seed -- seed locked reports for the user's office (admin only)
router.post(
  "/seed",
  requireRole("admin"),
  async (req, res, next) => {
    try {
      await seedLockedReports(req.user!.activeOfficeId ?? req.user!.officeId);
      await req.commitTransaction!();
      res.json({ success: true, message: "Locked reports seeded" });
    } catch (err) {
      next(err);
    }
  }
);

export const reportRoutes = router;
