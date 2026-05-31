import { Router, type Request } from "express";
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
  getForecastVarianceOverview,
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
  getClosedWonRevenueReport,
  getLeadConversionReport,
  getPipelineVelocityReport,
  normalizeSalesReportFilters,
} from "./sales-tier1-service.js";
import {
  getSavedReports,
  getSavedReportById,
  createSavedReport,
  updateSavedReport,
  deleteSavedReport,
  seedLockedReports,
  getReportSchedules,
  createReportSchedule,
  getReportRuns,
  createReportRun,
} from "./saved-reports-service.js";
import { runReportBuilder } from "./report-builder-service.js";
import {
  getDirectorScorecard,
  getForecastAccuracyReport,
  getRepActivityReport,
  normalizePerformanceReportFilters,
} from "./performance-tier2-service.js";
import {
  getCustomerConcentrationReport,
  getExecutiveTrendsReport,
  getMarketMixReport,
  type AnalyticsTier4Filters,
} from "./analytics-tier4-service.js";
import {
  getPortfolioLoadReport,
  getProjectReadinessReport,
  getWorkflowBottlenecksReport,
  normalizeOperationsReportFilters,
} from "./operations-tier3-service.js";
import { pickQueryValue } from "./office-filter.js";
import {
  getMondayShowcaseData,
  getMondayShowcaseEvidence,
  type EvidenceMetric,
  type MondayShowcaseEvidenceOptions,
} from "./monday-showcase-service.js";
import type { ProjectionBand } from "./foundations.js";

const router = Router();
const VALID_REPORT_FREQUENCIES = ["daily", "weekly", "biweekly", "monthly", "quarterly"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireAnyRole = requireRole("admin", "director", "rep");

function readQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AppError(400, `${label} must be a valid UUID`);
  }
  return value;
}

function readOptionalUuid(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  return requireUuid(value, label);
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

function parseSalesReportRequest(req: Request) {
  const filters = normalizeSalesReportFilters(req.query as Record<string, unknown>);
  return {
    ...filters,
    ownerIds: req.user!.role === "rep" ? [req.user!.id] : filters.ownerIds,
    ownerNames: req.user!.role === "rep" ? [] : filters.ownerNames,
    ownerEmails: req.user!.role === "rep" ? [] : filters.ownerEmails,
  };
}

function parseOwnerIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseOwnerIds(item));
  }
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readOptionalIsoDate(value: unknown, label: string) {
  const raw = readQueryString(value);
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AppError(400, `${label} must be an ISO date in YYYY-MM-DD format`);
  }
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw new AppError(400, `${label} must be a valid ISO date`);
  }
  return raw;
}

export function parseTier4Filters(query: Record<string, unknown>, user: { role: string; id: string }): AnalyticsTier4Filters {
  const ownerIds = user.role === "rep" ? [user.id] : parseOwnerIds(query.ownerIds);
  for (const ownerId of ownerIds) {
    if (!UUID_PATTERN.test(ownerId)) {
      throw new AppError(400, "ownerIds must contain valid UUID values");
    }
  }
  return {
    from: readOptionalIsoDate(pickQueryValue(query.dateFrom, query.from), "dateFrom"),
    to: readOptionalIsoDate(pickQueryValue(query.dateTo, query.to), "dateTo"),
    office: pickQueryValue(query.office, query.officeId),
    ownerIds,
    ownerNames: parseOwnerIds(query.ownerNames),
  };
}

// -------------------------------------------------------------------------
// Locked report execution endpoints
// -------------------------------------------------------------------------

router.get("/pipeline-velocity", async (req, res, next) => {
  try {
    const filters = parseSalesReportRequest(req);
    const data = await getPipelineVelocityReport(req.tenantDb!, filters, req.officeSlug ?? req.user!.activeOfficeId ?? req.user!.officeId);
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/closed-won-revenue", async (req, res, next) => {
  try {
    const filters = parseSalesReportRequest(req);
    const data = await getClosedWonRevenueReport(req.tenantDb!, filters, req.officeSlug ?? req.user!.activeOfficeId ?? req.user!.officeId);
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/lead-conversion", async (req, res, next) => {
  try {
    const filters = parseSalesReportRequest(req);
    const data = await getLeadConversionReport(req.tenantDb!, filters, req.officeSlug ?? req.user!.activeOfficeId ?? req.user!.officeId);
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

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

// GET /api/reports/forecast-variance?from=2026-01-01&to=2026-12-31
router.get("/forecast-variance", requireDirector, async (req, res, next) => {
  try {
    const filters = parseAnalyticsFilters(req.query as Record<string, unknown>);
    const data = await getForecastVarianceOverview(req.tenantDb!, {
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

async function handleOpportunityVsPipeline(req: any, res: any, next: any) {
  try {
    const data = await getDdVsPipeline(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

// GET /api/reports/opportunity-vs-pipeline
router.get("/opportunity-vs-pipeline", handleOpportunityVsPipeline);

// Legacy alias
router.get("/dd-vs-pipeline", handleOpportunityVsPipeline);

async function handleWonSummary(req: any, res: any, next: any) {
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
}

// GET /api/reports/won-summary?from=2026-01-01&to=2026-12-31
router.get("/won-summary", requireDirector, handleWonSummary);

// Legacy alias
router.get("/closed-won-summary", requireDirector, handleWonSummary);

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

// GET /api/reports/director-scorecard?dateFrom=2026-02-01&dateTo=2026-05-01&office=dallas&ownerNames=Rep%20One,Rep%20Two
router.get("/director-scorecard", requireDirector, async (req, res, next) => {
  try {
    const data = await getDirectorScorecard(
      req.tenantDb!,
      normalizePerformanceReportFilters(req.query as Record<string, unknown>),
      req.officeSlug ?? req.user!.activeOfficeId
    );
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/rep-activity?dateFrom=2026-02-01&dateTo=2026-05-01&office=dallas&ownerNames=Rep%20One,Rep%20Two
router.get("/rep-activity", requireAnyRole, async (req, res, next) => {
  try {
    const data = await getRepActivityReport(
      req.tenantDb!,
      normalizePerformanceReportFilters(req.query as Record<string, unknown>),
      { role: req.user!.role, userId: req.user!.id, displayName: req.user!.displayName },
      req.officeSlug ?? req.user!.activeOfficeId
    );
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/forecast-accuracy?dateFrom=2026-02-01&dateTo=2026-05-01&office=dallas&ownerNames=Rep%20One,Rep%20Two
router.get("/forecast-accuracy", requireDirector, async (req, res, next) => {
  try {
    const data = await getForecastAccuracyReport(
      req.tenantDb!,
      normalizePerformanceReportFilters(req.query as Record<string, unknown>),
      req.officeSlug ?? req.user!.activeOfficeId
    );
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

function parseOperationsFilters(req: any) {
  return normalizeOperationsReportFilters({
    dateFrom: req.query.dateFrom as string | undefined,
    dateTo: req.query.dateTo as string | undefined,
    office: req.query.office as string | undefined,
    ownerIds: req.query.ownerIds as string | string[] | undefined,
    ownerNames: req.query.ownerNames as string | string[] | undefined,
    cacheScope: `${req.user?.activeOfficeId ?? req.user?.officeId ?? "unknown"}:${req.user?.role ?? "unknown"}`,
  });
}

// GET /api/reports/workflow-bottlenecks?dateFrom=2026-02-01&dateTo=2026-05-01&office=all&ownerNames=Rep%20One,Rep%20Two
// GET /api/reports/market-mix?dateFrom=2025-05-11&dateTo=2026-05-11&office=uuid&ownerIds=uuid,uuid
router.get("/market-mix", requireAnyRole, async (req, res, next) => {
  try {
    const data = await getMarketMixReport(
      req.tenantDb!,
      parseTier4Filters(req.query as Record<string, unknown>, req.user!)
    );
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/customer-concentration?dateFrom=2025-05-11&dateTo=2026-05-11&office=uuid&ownerIds=uuid,uuid
router.get("/customer-concentration", requireAnyRole, async (req, res, next) => {
  try {
    const data = await getCustomerConcentrationReport(
      req.tenantDb!,
      parseTier4Filters(req.query as Record<string, unknown>, req.user!)
    );
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/executive-trends?dateFrom=2025-05-11&dateTo=2026-05-11&office=uuid&ownerIds=uuid,uuid
router.get("/executive-trends", requireAnyRole, async (req, res, next) => {
  try {
    const data = await getExecutiveTrendsReport(
      req.tenantDb!,
      parseTier4Filters(req.query as Record<string, unknown>, req.user!)
    );
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/workflow-bottlenecks?dateFrom=2026-02-01&dateTo=2026-05-01&office=all&ownerNames=Rep%20One,Rep%20Two
router.get("/workflow-bottlenecks", requireDirector, async (req, res, next) => {
  try {
    const data = await getWorkflowBottlenecksReport(req.tenantDb!, parseOperationsFilters(req));
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/project-readiness?dateFrom=2026-02-01&dateTo=2026-05-01&office=all&ownerNames=Rep%20One,Rep%20Two
router.get("/project-readiness", requireDirector, async (req, res, next) => {
  try {
    const data = await getProjectReadinessReport(req.tenantDb!, parseOperationsFilters(req));
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/portfolio-load?dateFrom=2026-02-01&dateTo=2026-05-01&office=all&ownerNames=Rep%20One,Rep%20Two
router.get("/portfolio-load", requireDirector, async (req, res, next) => {
  try {
    const data = await getPortfolioLoadReport(req.tenantDb!, parseOperationsFilters(req));
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
router.post("/execute", requireDirector, async (req, res, next) => {
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

// POST /api/reports/run -- aggregate report-builder query
router.post("/run", requireAnyRole, async (req, res, next) => {
  try {
    const data = await runReportBuilder(req.tenantDb!, {
      dimensions: Array.isArray(req.body.dimensions) ? req.body.dimensions : [],
      measures: Array.isArray(req.body.measures) ? req.body.measures : [],
      filters: req.body.filters && typeof req.body.filters === "object" ? req.body.filters : {},
      dateField: typeof req.body.dateField === "string" ? req.body.dateField : "created_at",
      role: req.user!.role,
      userId: req.user!.id,
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------------
// Saved reports CRUD
// -------------------------------------------------------------------------

// GET /api/reports/schedules -- schedules for reports visible to the user
router.get("/schedules", async (req, res, next) => {
  try {
    const schedules = await getReportSchedules(
      req.user!.id,
      req.user!.activeOfficeId ?? req.user!.officeId
    );
    await req.commitTransaction!();
    res.json({ schedules });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/runs -- run history for reports visible to the user
router.get("/runs", async (req, res, next) => {
  try {
    const runs = await getReportRuns(
      req.user!.id,
      req.user!.activeOfficeId ?? req.user!.officeId
    );
    await req.commitTransaction!();
    res.json({ runs });
  } catch (err) {
    next(err);
  }
});

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

// POST /api/reports/saved/:id/runs -- enqueue a report execution stub
router.post("/saved/:id/runs", async (req, res, next) => {
  try {
    const reportId = requireUuid(req.params.id, "reportId");
    const run = await createReportRun({
      reportId,
      userId: req.user!.id,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      scheduleId: readOptionalUuid(req.body?.scheduleId, "scheduleId"),
    });
    await req.commitTransaction!();
    res.status(201).json({ run });
  } catch (err) {
    next(err);
  }
});

// POST /api/reports/saved/:id/schedules -- schedule a visible saved report
router.post("/saved/:id/schedules", async (req, res, next) => {
  try {
    const reportId = requireUuid(req.params.id, "reportId");
    const { frequency, cronExpr, recipients, nextRunAt } = req.body ?? {};
    if (!frequency || !cronExpr || !nextRunAt) {
      throw new AppError(400, "frequency, cronExpr, and nextRunAt are required");
    }
    if (!VALID_REPORT_FREQUENCIES.includes(frequency)) {
      throw new AppError(400, `frequency must be one of: ${VALID_REPORT_FREQUENCIES.join(", ")}`);
    }
    const parsedNextRunAt = new Date(nextRunAt);
    if (Number.isNaN(parsedNextRunAt.getTime())) {
      throw new AppError(400, "nextRunAt must be a valid ISO timestamp");
    }
    if (parsedNextRunAt.getTime() <= Date.now()) {
      throw new AppError(400, "nextRunAt must be in the future");
    }

    const schedule = await createReportSchedule({
      reportId,
      userId: req.user!.id,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      frequency,
      cronExpr,
      recipients: Array.isArray(recipients) ? recipients : [],
      nextRunAt,
    });
    await req.commitTransaction!();
    res.status(201).json({ schedule });
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
    if (visibility === "company" && req.user!.role !== "admin") {
      throw new AppError(403, "Only admins can save org-wide reports");
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

// Reports Part 2 -- the Monday-showcase single payload. The 8 client variants (3 Report A + 4 Report B +
// the exec hero tile) render slices of THIS one response, so they reconcile by construction. Director-
// scoped (it exposes every rep's numbers). ?mode=to_date (live WTD) | completed (prior full Sun-Sat box).
router.get("/monday-showcase", requireDirector, async (req, res, next) => {
  try {
    const modeRaw = pickQueryValue(req.query.mode);
    const mode = modeRaw === "completed" ? "completed" : "to_date";
    const data = await getMondayShowcaseData(req.tenantDb!, { mode });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Reports Part 3 -- drill-to-evidence. Returns the supporting records behind ONE showcase number
// (metric x scope x band/lead-stage), with a total that EQUALS that number (same canonical cohort).
const EVIDENCE_METRICS = ["won", "sent", "estimated", "projection", "leads"] as const;
const PROJECTION_BANDS = ["0_30", "31_60", "61_90", "beyond_90"] as const;
const UNASSIGNED_SENTINEL = "__unassigned__";

export function parseShowcaseEvidenceParams(query: Record<string, unknown>): MondayShowcaseEvidenceOptions {
  const metricRaw = pickQueryValue(query.metric);
  if (!metricRaw || !EVIDENCE_METRICS.includes(metricRaw as EvidenceMetric)) {
    throw new AppError(400, `metric must be one of: ${EVIDENCE_METRICS.join(", ")}`);
  }
  const metric = metricRaw as EvidenceMetric;

  const modeRaw = pickQueryValue(query.mode);
  const mode = modeRaw === "completed" ? "completed" : "to_date";

  // repId: absent -> office-wide (undefined, so it reconciles to the office number); the sentinel ->
  // the Unassigned (null) bucket; otherwise a real rep UUID.
  const repIdRaw = pickQueryValue(query.repId);
  let repId: string | null | undefined;
  if (repIdRaw === undefined) repId = undefined;
  else if (repIdRaw === UNASSIGNED_SENTINEL) repId = null;
  else repId = requireUuid(repIdRaw, "repId");

  const bandRaw = pickQueryValue(query.band);
  let band: ProjectionBand | undefined;
  if (bandRaw !== undefined) {
    if (metric !== "projection") throw new AppError(400, "band is only valid for the projection metric");
    if (!PROJECTION_BANDS.includes(bandRaw as ProjectionBand)) {
      throw new AppError(400, `band must be one of: ${PROJECTION_BANDS.join(", ")}`);
    }
    band = bandRaw as ProjectionBand;
  }

  const leadStage = pickQueryValue(query.leadStage);
  if (leadStage !== undefined && metric !== "leads") {
    throw new AppError(400, "leadStage is only valid for the leads metric");
  }

  return { metric, mode, repId, band, leadStage };
}

router.get("/monday-showcase/evidence", requireDirector, async (req, res, next) => {
  try {
    const options = parseShowcaseEvidenceParams(req.query as Record<string, unknown>);
    const data = await getMondayShowcaseEvidence(req.tenantDb!, options);
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

export const reportRoutes = router;
