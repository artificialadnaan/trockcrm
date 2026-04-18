import { Router } from "express";
import { requireRole, requireDirector } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  getPipelineSummary,
  getWeightedPipelineForecast,
  getWinLossRatioByRep,
  getWinRateTrend,
  getUnifiedWorkflowOverview,
  getActivitySummaryByRep,
  getStaleDeals,
  getLostDealsByReason,
  getRevenueByProjectType,
  getLeadSourceROI,
  getFollowUpCompliance,
  getDdVsPipeline,
  getClosedWonSummary,
  getRegionalOwnershipOverview,
  getPipelineByRep,
  getDataMiningOverview,
  executeCustomReport,
  getRepPerformanceComparison,
  normalizeAnalyticsFilters,
} from "./service.js";
import type { AnalyticsFilterInput, ReportConfig } from "./service.js";
import {
  getSavedReports,
  getSavedReportById,
  createSavedReport,
  updateSavedReport,
  deleteSavedReport,
  seedLockedReports,
} from "./saved-reports-service.js";

const router = Router();

function readQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseAnalyticsFilters(query: Record<string, unknown>): AnalyticsFilterInput {
  return normalizeAnalyticsFilters({
    from: readQueryString(query.from),
    to: readQueryString(query.to),
    officeId: readQueryString(query.officeId),
    regionId: readQueryString(query.regionId),
    repId: readQueryString(query.repId),
    source: readQueryString(query.source),
  });
}

// -------------------------------------------------------------------------
// Locked report execution endpoints
// -------------------------------------------------------------------------

// GET /api/reports/pipeline-summary?includeDd=false&from=2026-01-01&to=2026-12-31
router.get("/pipeline-summary", async (req, res, next) => {
  try {
    // Reps can only see their own pipeline
    const repId = req.user!.role === "rep" ? req.user!.id : undefined;
    const data = await getPipelineSummary(req.tenantDb!, {
      includeDd: req.query.includeDd === "true",
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      repId,
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
    // Reps can only see their own forecast
    const repId = req.user!.role === "rep" ? req.user!.id : undefined;
    const data = await getWeightedPipelineForecast(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      repId,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/win-loss?from=2026-01-01&to=2026-12-31
router.get("/win-loss", requireDirector, async (req, res, next) => {
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
    // Reps can only see their own data
    const repId = req.user!.role === "rep"
      ? req.user!.id
      : (req.query.repId as string | undefined);
    const data = await getWinRateTrend(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      repId,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/activity-summary?from=2026-01-01&to=2026-12-31
router.get("/activity-summary", requireDirector, async (req, res, next) => {
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

// GET /api/reports/workflow-overview
router.get("/workflow-overview", async (req, res, next) => {
  try {
    const parsedFilters = parseAnalyticsFilters(req.query as Record<string, unknown>);
    const data = await getUnifiedWorkflowOverview(req.tenantDb!, {
      ...parsedFilters,
      repId: req.user!.role === "rep" ? req.user!.id : parsedFilters.repId,
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
    // Reps can only see their own stale deals
    const repId = req.user!.role === "rep"
      ? req.user!.id
      : (req.query.repId as string | undefined);
    const data = await getStaleDeals(req.tenantDb!, {
      repId,
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
router.get("/revenue-by-type", requireDirector, async (req, res, next) => {
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
router.get("/lead-source-roi", requireDirector, async (req, res, next) => {
  try {
    const filters = parseAnalyticsFilters(req.query as Record<string, unknown>);
    const data = await getLeadSourceROI(req.tenantDb!, {
      ...filters,
      officeId: filters.officeId ?? req.user!.activeOfficeId ?? req.user!.officeId,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/data-mining?from=2026-01-01&to=2026-12-31
router.get("/data-mining", requireDirector, async (req, res, next) => {
  try {
    const parsedFilters = parseAnalyticsFilters(req.query as Record<string, unknown>);
    const data = await getDataMiningOverview(req.tenantDb!, {
      ...parsedFilters,
      officeId: parsedFilters.officeId ?? req.user!.activeOfficeId ?? req.user!.officeId,
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
    // Reps can only see their own compliance data
    const repId = req.user!.role === "rep"
      ? req.user!.id
      : ((req.query.repId as string) || req.user!.id);
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

// GET /api/reports/closed-won-summary?from=2026-01-01&to=2026-12-31
router.get("/closed-won-summary", requireDirector, async (req, res, next) => {
  try {
    const data = await getClosedWonSummary(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/pipeline-by-rep?repId=uuid
router.get("/pipeline-by-rep", requireDirector, async (req, res, next) => {
  try {
    const data = await getPipelineByRep(req.tenantDb!, {
      repId: req.query.repId as string | undefined,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/rep-performance?period=month|quarter|year
router.get("/rep-performance", requireDirector, async (req, res, next) => {
  try {
    const period = (req.query.period as string) || "month";
    if (!["month", "quarter", "year"].includes(period)) {
      throw new AppError(400, "period must be month, quarter, or year");
    }
    const result = await getRepPerformanceComparison(
      req.tenantDb!,
      period as "month" | "quarter" | "year"
    );
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/regional-ownership?officeId=uuid&from=2026-01-01&to=2026-12-31
router.get("/regional-ownership", requireDirector, async (req, res, next) => {
  try {
    const data = await getRegionalOwnershipOverview(req.tenantDb!, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      officeId:
        (req.query.officeId as string | undefined) ??
        req.user!.activeOfficeId ??
        req.user!.officeId,
      regionId: req.query.regionId as string | undefined,
      repId: req.query.repId as string | undefined,
      source: req.query.source as string | undefined,
    });
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
    const report = await getSavedReportById(
      req.params.id,
      req.user!.id,
      req.user!.activeOfficeId ?? req.user!.officeId
    );
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
