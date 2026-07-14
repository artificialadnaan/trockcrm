import { Router, type Request } from "express";
import {
  ESTIMATOR_PIPELINE_BUCKETS,
  ESTIMATOR_PIPELINE_COHORTS,
  ESTIMATOR_PIPELINE_TARGET_KEYS,
  type EstimatorPipelineBucket,
  type EstimatorPipelineCohort,
  type EstimatorPipelineTargetKey,
  type ScorecardKind,
} from "@trock-crm/shared/types";
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
  DIRECTOR_EVIDENCE_METRICS,
  FORECAST_EVIDENCE_METRICS,
  getDirectorScorecard,
  getDirectorScorecardEvidence,
  getForecastAccuracyEvidence,
  getForecastAccuracyReport,
  getRepActivityReport,
  normalizePerformanceReportFilters,
  type DirectorEvidenceMetric,
  type DirectorScorecardEvidenceOptions,
  type ForecastAccuracyEvidenceOptions,
  type ForecastEvidenceMetric,
} from "./performance-tier2-service.js";
import {
  getAnalyticsEvidence,
  getCustomerConcentrationReport,
  getExecutiveTrendsReport,
  getMarketMixReport,
  type AnalyticsEvidenceMetric,
  type AnalyticsEvidenceOptions,
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
import { getAtRiskWatchlist } from "./at-risk-service.js";
import { getRepPackData } from "./rep-pack-service.js";
import { getRegionReport } from "./region-report-service.js";
import { getQcScorecardsReport } from "./qc-scorecards-service.js";
import {
  getEstimatorPipelineEvidence,
  getEstimatorPipelineReport,
  type EstimatorPipelineEvidenceOptions,
} from "./estimator-pipeline-service.js";
import { resolveRepScope, weekDates, buildLiveDay, sumDays, resolveReps, USAGE_ROSTER_ROLES, readUsageDaily, buildTeamSummary, isWithinDrilldownWindow, classifyViewsState, readViewEvents, readViewEventsRange, readActionDetail, resolveDayKind, emptyUsageDay } from "../usage/read-service.js";
import { businessToday, shiftBusinessDate, getWtdPeriod, type WeekMode } from "../../lib/period.js";

// Parse the showcase/report period toggle. Accepts the four canonical modes; anything else (incl.
// absent) defaults to "to_date" (live WTD), matching the prior behavior. mtd/ytd resolve to
// first-of-month/Jan-1 → today windows that are byte-identical to the client resolveDatePreset, so the
// B2 Leaderboard reconciles to the Deals Dashboard for the same preset.
function parseWeekMode(modeRaw: string | undefined): WeekMode {
  if (modeRaw === "completed" || modeRaw === "mtd" || modeRaw === "ytd") return modeRaw;
  return "to_date";
}

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

function readPositiveInteger(value: unknown, label: string, fallback: number, maximum: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new AppError(400, `${label} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AppError(400, `${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

export function parseEstimatorPipelineEvidenceQuery(
  query: Record<string, unknown>,
): EstimatorPipelineEvidenceOptions {
  const cohortRaw = pickQueryValue(query.cohort) ?? "open";
  if (!(ESTIMATOR_PIPELINE_COHORTS as readonly string[]).includes(cohortRaw)) {
    throw new AppError(400, "cohort must be one of open or won");
  }
  const cohort = cohortRaw as EstimatorPipelineCohort;
  const bucketRaw = pickQueryValue(query.bucket);
  if (!bucketRaw || !(ESTIMATOR_PIPELINE_BUCKETS as readonly string[]).includes(bucketRaw)) {
    throw new AppError(400, "bucket must be one of target, other, or missing");
  }
  const bucket = bucketRaw as EstimatorPipelineBucket;
  const estimatorKeyRaw = pickQueryValue(query.estimatorKey);
  let estimatorKey: EstimatorPipelineTargetKey | undefined;
  if (bucket === "target") {
    if (!estimatorKeyRaw || !(ESTIMATOR_PIPELINE_TARGET_KEYS as readonly string[]).includes(estimatorKeyRaw)) {
      throw new AppError(400, "estimatorKey must identify a configured target estimator");
    }
    estimatorKey = estimatorKeyRaw as EstimatorPipelineTargetKey;
  } else if (estimatorKeyRaw !== undefined) {
    throw new AppError(400, "estimatorKey is only valid when bucket=target");
  }

  const stageSlug = pickQueryValue(query.stageSlug);
  if (stageSlug && !/^[a-z0-9_]{1,100}$/.test(stageSlug)) {
    throw new AppError(400, "stageSlug must be a canonical pipeline stage slug");
  }
  const asOf = readOptionalIsoDate(query.asOf, "asOf");
  if (asOf && cohort !== "won") {
    throw new AppError(400, "asOf is only valid when cohort=won");
  }

  return {
    cohort,
    asOf,
    bucket,
    estimatorKey,
    stageSlug,
    page: readPositiveInteger(query.page, "page", 1, 100_000),
    pageSize: readPositiveInteger(query.pageSize, "pageSize", 25, 100),
  };
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

// GET /api/reports/region?from=2026-01-01&to=2026-12-31
// Reports by Region: per-region won/pipeline/win-rate/avg + forecast + stage matrix + top reps + movers.
// from/to window the Won/Lost metrics (canonical won_closed_date / lost_at); pipeline/forecast/stage-matrix
// are current snapshots; movers are week-based. Defaults to the current week-to-date when absent.
// OPEN to any authenticated CRM user (no requireDirector) — the router mount already applies requireCrmUser,
// so auth + office/tenant scoping (req.tenantDb) still hold; "all roles" means role, NOT cross-office. The
// per-region `pipeline`/forecast figures are office AGGREGATES (not a per-rep pipeline breakdown; topReps rank
// by WON value only), so this exposes rep-visible aggregates. To reverse, re-add requireDirector here (and the
// RequireRole wrapper on the /reports/region client route).
router.get("/region", async (req, res, next) => {
  try {
    const rawFrom = readOptionalIsoDate(req.query.from, "from");
    const rawTo = readOptionalIsoDate(req.query.to, "to");
    // Both-or-neither: a single bound mixes a client date with a server default and can invert the window.
    if ((rawFrom == null) !== (rawTo == null)) {
      throw new AppError(400, "Provide both 'from' and 'to', or neither.");
    }
    const fallback = getWtdPeriod("to_date");
    const from = rawFrom ?? fallback.from;
    const to = rawTo ?? fallback.to;
    if (from > to) throw new AppError(400, "'from' must be on or before 'to'.");
    const data = await getRegionReport(req.tenantDb!, { from, to });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/qc-scorecards — office-scoped Field Scorecards for the QC dashboard, filtered by week
// range + region/superintendent/rating/flagged/search. The dashboard derives its stat strip + card
// drill-downs from this list client-side.
router.get("/qc-scorecards", requireAnyRole, async (req, res, next) => {
  try {
    const rawFrom = readOptionalIsoDate(req.query.from, "from");
    const rawTo = readOptionalIsoDate(req.query.to, "to");
    if ((rawFrom == null) !== (rawTo == null)) {
      throw new AppError(400, "Provide both 'from' and 'to', or neither.");
    }
    // Default window: the trailing ~8 weeks up to today (covers the typical review horizon).
    const to = rawTo ?? businessToday();
    const from = rawFrom ?? shiftBusinessDate(to, -56);
    if (from > to) throw new AppError(400, "'from' must be on or before 'to'.");
    const rawKind = readQueryString(req.query.kind);
    if (rawKind && rawKind !== "project" && rawKind !== "leadership") {
      throw new AppError(400, "'kind' must be 'project' or 'leadership'.");
    }
    const kind = rawKind as ScorecardKind | undefined;

    const data = await getQcScorecardsReport(req.tenantDb!, {
      from,
      to,
      region: readQueryString(req.query.region),
      kind,
      superintendent: readQueryString(req.query.superintendent),
      rating: readQueryString(req.query.rating),
      flaggedOnly: req.query.flaggedOnly === "true",
      search: readQueryString(req.query.search),
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

// GET /api/reports/director-scorecard/evidence?metric=won&dateFrom=2026-02-01&dateTo=2026-02-28&office=dallas&repId=<uuid>
// Drill-to-evidence: the supporting deal rows behind ONE Director Scorecard number, with a total that
// EQUALS that number (same cohort predicate as getDirectorScorecard). repId absent -> office-wide (so it
// reconciles to the office figure); otherwise a real rep UUID. There is no Unassigned bucket -- the
// scorecard INNER-joins users, so unassigned deals contribute to no headline number. The allowed-metric
// set is imported from the service (DIRECTOR_EVIDENCE_METRICS) so route validation stays in lockstep with
// the DirectorEvidenceMetric type.
/** Parse + validate the evidence query: a whitelisted metric (required) and an optional rep UUID (office-wide when absent). */
export function parseDirectorEvidenceParams(query: Record<string, unknown>): DirectorScorecardEvidenceOptions {
  const metricRaw = pickQueryValue(query.metric);
  if (!metricRaw || !DIRECTOR_EVIDENCE_METRICS.includes(metricRaw as DirectorEvidenceMetric)) {
    throw new AppError(400, `metric must be one of: ${DIRECTOR_EVIDENCE_METRICS.join(", ")}`);
  }
  const metric = metricRaw as DirectorEvidenceMetric;

  const repIdRaw = pickQueryValue(query.repId);
  const repId = repIdRaw === undefined ? undefined : requireUuid(repIdRaw, "repId");

  return { metric, repId };
}

router.get("/director-scorecard/evidence", requireDirector, async (req, res, next) => {
  try {
    const data = await getDirectorScorecardEvidence(
      req.tenantDb!,
      normalizePerformanceReportFilters(req.query as Record<string, unknown>),
      parseDirectorEvidenceParams(req.query as Record<string, unknown>)
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

// GET /api/reports/forecast-accuracy/evidence?metric=commit&dateFrom=2026-02-01&dateTo=2026-02-28&office=dallas&repId=<uuid>
// Drill-to-evidence: the supporting deal rows behind ONE Forecast Accuracy number, with a total that EQUALS
// that number (same cohort predicate + $ basis as getForecastAccuracyReport). won_actual stays CO-free
// (awarded-first). repId absent -> office-wide; otherwise a real rep UUID (no Unassigned bucket).
export function parseForecastEvidenceParams(query: Record<string, unknown>): ForecastAccuracyEvidenceOptions {
  const metricRaw = pickQueryValue(query.metric);
  if (!metricRaw || !FORECAST_EVIDENCE_METRICS.includes(metricRaw as ForecastEvidenceMetric)) {
    throw new AppError(400, `metric must be one of: ${FORECAST_EVIDENCE_METRICS.join(", ")}`);
  }
  const metric = metricRaw as ForecastEvidenceMetric;

  const repIdRaw = pickQueryValue(query.repId);
  const repId = repIdRaw === undefined ? undefined : requireUuid(repIdRaw, "repId");

  return { metric, repId };
}

router.get("/forecast-accuracy/evidence", requireDirector, async (req, res, next) => {
  try {
    const data = await getForecastAccuracyEvidence(
      req.tenantDb!,
      normalizePerformanceReportFilters(req.query as Record<string, unknown>),
      parseForecastEvidenceParams(req.query as Record<string, unknown>)
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

// Drill-to-evidence for the Analytics Tier-4 deal-grained headlines: the supporting deal rows behind ONE
// number, with a total that EQUALS it (same cohort predicate + $ basis as the report). repId absent ->
// office-wide; the sentinel -> the Unassigned bucket (Tier-4 includes unassigned deals); otherwise a rep UUID.
/** Parse + validate an Analytics evidence query: a metric within the report's `allowed` set + an optional rep
 * (absent = office-wide, __unassigned__ = the Unassigned bucket, uuid = that rep). */
export function parseAnalyticsEvidenceParams(
  query: Record<string, unknown>,
  allowed: readonly AnalyticsEvidenceMetric[]
): AnalyticsEvidenceOptions {
  const metricRaw = pickQueryValue(query.metric);
  if (!metricRaw || !allowed.includes(metricRaw as AnalyticsEvidenceMetric)) {
    throw new AppError(400, `metric must be one of: ${allowed.join(", ")}`);
  }
  const metric = metricRaw as AnalyticsEvidenceMetric;

  const repIdRaw = pickQueryValue(query.repId);
  let repId: string | null | undefined;
  if (repIdRaw === undefined) repId = undefined;
  else if (repIdRaw === UNASSIGNED_SENTINEL) repId = null;
  else repId = requireUuid(repIdRaw, "repId");

  return { metric, repId };
}

// Per-report allowed metrics (the `satisfies` validates each is a real AnalyticsEvidenceMetric, so a typo
// fails typecheck; the literal tuple keeps the narrow type the route advertises).
const MARKET_MIX_EVIDENCE_METRICS = ["deal_count"] as const satisfies readonly AnalyticsEvidenceMetric[];
const CUSTOMER_CONCENTRATION_EVIDENCE_METRICS = ["open_value"] as const satisfies readonly AnalyticsEvidenceMetric[];

// GET /api/reports/market-mix/evidence?metric=deal_count&dateFrom=...&dateTo=...&office=...&repId=<uuid|__unassigned__>
router.get("/market-mix/evidence", requireAnyRole, async (req, res, next) => {
  try {
    const data = await getAnalyticsEvidence(
      req.tenantDb!,
      parseTier4Filters(req.query as Record<string, unknown>, req.user!),
      parseAnalyticsEvidenceParams(req.query as Record<string, unknown>, MARKET_MIX_EVIDENCE_METRICS)
    );
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/customer-concentration/evidence?metric=open_value&dateFrom=...&dateTo=...&office=...&repId=<uuid|__unassigned__>
router.get("/customer-concentration/evidence", requireAnyRole, async (req, res, next) => {
  try {
    const data = await getAnalyticsEvidence(
      req.tenantDb!,
      parseTier4Filters(req.query as Record<string, unknown>, req.user!),
      parseAnalyticsEvidenceParams(req.query as Record<string, unknown>, CUSTOMER_CONCENTRATION_EVIDENCE_METRICS)
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
// the exec hero tile) render slices of THIS one response, so they reconcile by construction. Visible to
// standard CRM sales roles so reps can review the same Monday visibility. ?mode=to_date (live WTD) |
// completed (prior full Sun-Sat box).
router.get("/monday-showcase", requireAnyRole, async (req, res, next) => {
  try {
    const modeRaw = pickQueryValue(req.query.mode);
    const mode = parseWeekMode(modeRaw);
    const data = await getMondayShowcaseData(req.tenantDb!, { mode });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Reports Part 3 -- drill-to-evidence. Returns the supporting records behind ONE showcase number
// (metric x scope x band/lead-stage), with a total that EQUALS that number (same canonical cohort).
const EVIDENCE_METRICS = ["won", "sent", "estimated", "projection", "pipeline", "leads", "undated", "no_date", "stale"] as const;
const PROJECTION_BANDS = ["0_30", "31_60", "61_90", "beyond_90"] as const;
const UNASSIGNED_SENTINEL = "__unassigned__";

export function parseShowcaseEvidenceParams(query: Record<string, unknown>): MondayShowcaseEvidenceOptions {
  const metricRaw = pickQueryValue(query.metric);
  if (!metricRaw || !EVIDENCE_METRICS.includes(metricRaw as EvidenceMetric)) {
    throw new AppError(400, `metric must be one of: ${EVIDENCE_METRICS.join(", ")}`);
  }
  const metric = metricRaw as EvidenceMetric;

  const modeRaw = pickQueryValue(query.mode);
  const mode = parseWeekMode(modeRaw);

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

  // stageSlug: a single pipeline stage, to reconcile one region×stage heatmap cell. Pipeline metric only.
  const stageSlug = pickQueryValue(query.stageSlug);
  if (stageSlug !== undefined && metric !== "pipeline") {
    throw new AppError(400, "stageSlug is only valid for the pipeline metric");
  }

  // regionName: absent -> no region predicate (office-wide); a string -> the displayed region row to
  // drill, keyed on COALESCE(NULLIF(rc.name,''),'Unassigned') exactly as the region report groups (so a
  // duplicate/inactive same-named config can't desync the drill). "Unassigned" = that bucket. Leads have
  // no region and the region report has no leads section, so a region-scoped leads drill has no cohort to
  // reconcile against and is rejected — never returned as unfiltered rows under a region scope header.
  const regionName = pickQueryValue(query.regionName);
  if (regionName !== undefined && (metric === "leads" || metric === "undated" || metric === "no_date" || metric === "stale")) {
    // Leads have no region, and the undated card is a showcase-only blind-spot list with no region-report
    // section to reconcile against — reject regionName rather than silently ignore it (the records would
    // otherwise come back unfiltered under a region header). buildUndatedEvidenceSql takes no regionName.
    throw new AppError(400, `regionName is not valid for the ${metric} metric`);
  }
  // rep × region: the region report's "top reps within region" won totals drill into a single rep WITHIN a
  // single region, and buildWonEvidenceSql filters by both — so that combination IS reconcilable (the drawer
  // names both axes via its title and the total equals the clicked rep×region figure). Every OTHER metric
  // has no rep×region cohort to reconcile against, so the combination stays rejected there (never a subset
  // total under a single-axis header).
  if (regionName !== undefined && repId !== undefined && metric !== "won") {
    throw new AppError(400, "repId and regionName can only be combined for the won metric");
  }

  // from/to: explicit period window for a region drill (paired; both or neither). Used to reconcile the
  // windowed metrics to the region report's exact period instead of the mode-derived week.
  const fromRaw = pickQueryValue(query.from);
  const toRaw = pickQueryValue(query.to);
  if ((fromRaw === undefined) !== (toRaw === undefined)) {
    throw new AppError(400, "from and to must be provided together");
  }
  // Format AND calendar validity (so "2026-02-31" can't pass the regex and then fail at SQL date casting).
  const isoDate = (v: string, label: string): string => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new AppError(400, `${label} must be an ISO date (YYYY-MM-DD)`);
    const parsed = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) {
      throw new AppError(400, `${label} is not a valid calendar date`);
    }
    return v;
  };
  const from = fromRaw === undefined ? undefined : isoDate(fromRaw, "from");
  const to = toRaw === undefined ? undefined : isoDate(toRaw, "to");
  if (from !== undefined && to !== undefined && from > to) {
    throw new AppError(400, "from must be on or before to"); // ISO YYYY-MM-DD sorts chronologically
  }

  return { metric, mode, repId, band, leadStage, stageSlug, regionName, from, to };
}

/**
 * The Reports-by-Region drill's elevated surface is director-only: an explicit {from,to} window
 * (arbitrary historical range), the region scope, AND the `pipeline` metric (all office-wide open deals —
 * it exists only for the region drill; the showcase rep drawer never requests it). Without this a rep
 * could call ?metric=pipeline bare, or omit repId with from/to, and pull office-wide evidence they aren't
 * scoped to. The showcase rep drawer (won/sent/estimated/projection/leads, mode-week, own repId) is unaffected.
 */
export function assertShowcaseEvidenceAccess(options: MondayShowcaseEvidenceOptions, isDirector: boolean): void {
  if (isDirector) return;
  if (options.from !== undefined || options.regionName !== undefined || options.metric === "pipeline") {
    throw new AppError(403, "the pipeline metric, an explicit from/to window, and regionName are restricted to directors");
  }
}

router.get("/monday-showcase/evidence", requireAnyRole, async (req, res, next) => {
  try {
    const options = parseShowcaseEvidenceParams(req.query as Record<string, unknown>);
    assertShowcaseEvidenceAccess(options, req.user!.role === "admin" || req.user!.role === "director");
    const data = await getMondayShowcaseEvidence(req.tenantDb!, options);
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Live open-pipeline attribution plus a canonical Won-YTD cohort for the two configured estimators, with a
// reconciled assignment-gap queue. Leadership-only because the evidence is office-wide and estimator edits
// affect commissions.
router.get("/estimator-pipeline", requireDirector, async (req, res, next) => {
  try {
    const data = await getEstimatorPipelineReport(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/estimator-pipeline/evidence", requireDirector, async (req, res, next) => {
  try {
    const options = parseEstimatorPipelineEvidenceQuery(req.query as Record<string, unknown>);
    const data = await getEstimatorPipelineEvidence(req.tenantDb!, options);
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Reports Part 4 -- A·3 At-Risk & Value-at-Stake Watchlist (the forecast blind spots; M − N).
router.get("/at-risk", requireDirector, async (req, res, next) => {
  try {
    const repIdRaw = pickQueryValue(req.query.repId);
    let repId: string | null | undefined;
    if (repIdRaw === undefined) repId = undefined;
    else if (repIdRaw === UNASSIGNED_SENTINEL) repId = null;
    else repId = requireUuid(repIdRaw, "repId");
    const data = await getAtRiskWatchlist(req.tenantDb!, { repId });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Reports Part 4 -- B·1 Rep 1:1 Pack (one rep's reconciling slice + 8-week trend). repId optional (the
// service defaults to the top rep by closed value); a 1:1 pack is for a named rep, so no Unassigned bucket.
router.get("/rep-pack", requireDirector, async (req, res, next) => {
  try {
    const repIdRaw = pickQueryValue(req.query.repId);
    const repId = repIdRaw === undefined ? undefined : requireUuid(repIdRaw, "repId");
    const modeRaw = pickQueryValue(req.query.mode);
    const mode = parseWeekMode(modeRaw);
    const data = await getRepPackData(req.tenantDb!, { repId, mode });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/platform-usage?grain=day|week&date=YYYY-MM-DD&rep=<uuid>
// Reps are server-scoped to themselves; admin/director may pass ?rep= or omit for all active reps.
router.get("/platform-usage", requireAnyRole, async (req, res, next) => {
  try {
    const grain = req.query.grain === "week" ? "week" : "day";
    const today = businessToday();
    const anchor = readOptionalIsoDate(req.query.date, "date") ?? today;
    const dates = grain === "week" ? weekDates(anchor) : [anchor];

    const repParam = req.user!.role !== "rep" && typeof req.query.rep === "string" ? req.query.rep : undefined;
    if (repParam !== undefined && !UUID_PATTERN.test(repParam)) {
      throw new AppError(400, "rep must be a valid UUID");
    }
    const scope = resolveRepScope(
      { role: req.user!.role, userId: req.user!.id },
      repParam,
    );
    const schema = `office_${req.officeSlug!}`;
    const client = req.tenantClient!; // pg PoolClient bound to the request transaction

    const reps = await resolveReps(client, scope, USAGE_ROSTER_ROLES);

    // Sequential by design: all queries share the one tenant PoolClient (a single connection),
    // which cannot run concurrent queries. Do NOT wrap this in Promise.all. Batch per-rep if needed.
    const leaderboard = [];
    for (const rep of reps) {
      const days = [];
      for (const d of dates) {
        const kind = resolveDayKind(d, today);
        days.push(
          kind === "live" ? await buildLiveDay(client, schema, rep.id, d)
          : kind === "past" ? await readUsageDaily(client, schema, rep.id, d)
          : emptyUsageDay(rep.id, d),
        );
      }
      const usage = grain === "week" ? sumDays(rep.id, `week-of-${dates[0]}`, days) : days[0];
      leaderboard.push({ rep, usage });
    }

    await req.commitTransaction!();
    res.json({ data: { grain, dates, summary: buildTeamSummary(leaderboard), leaderboard } });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/platform-usage/drilldown?date=YYYY-MM-DD&rep=<uuid>&type=<entity_type>
// Returns raw view events for a single rep on one day (within the 14-day raw-retention window).
// Reps are server-scoped to themselves — the ?rep= param is ignored for reps.
router.get("/platform-usage/drilldown", requireAnyRole, async (req, res, next) => {
  try {
    const date = readOptionalIsoDate(req.query.date, "date");
    if (!date) {
      throw new AppError(400, "date is required (YYYY-MM-DD)");
    }
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const today = businessToday();

    const repParam = req.user!.role !== "rep" && typeof req.query.rep === "string" ? req.query.rep : undefined;
    if (repParam !== undefined && !UUID_PATTERN.test(repParam)) {
      throw new AppError(400, "rep must be a valid UUID");
    }
    // Drilldown targets exactly one rep, resolved through the same roster as the summary.
    let targetScope: string[];
    if (req.user!.role === "rep") {
      targetScope = [req.user!.id];
    } else if (repParam) {
      targetScope = [repParam];
    } else {
      throw new AppError(400, "rep is required");
    }
    const schema = `office_${req.officeSlug!}`;
    const roster = await resolveReps(req.tenantClient!, targetScope, USAGE_ROSTER_ROLES);
    if (roster.length === 0) {
      throw new AppError(404, "rep not found in usage roster");
    }
    const repId = roster[0].id;

    if (!isWithinDrilldownWindow(date, today)) {
      await req.commitTransaction!();
      res.json({ data: { expired: true, events: [], message: "counts only — drilldown expired" } });
      return;
    }

    const events = await readViewEvents(req.tenantClient!, schema, repId, date, type);
    await req.commitTransaction!();
    res.json({ data: { expired: false, events } });
  } catch (err) {
    next(err);
  }
});

// Rep detail: itemized Actions (audit_log, always available) + Views (usage_view_event, pruned at
// 14d) for one rep over the selected day/week. SAME server-enforced rep-self scoping as the summary
// and drilldown — a rep can only ever load their own detail.
router.get("/platform-usage/detail", requireAnyRole, async (req, res, next) => {
  try {
    const grain = req.query.grain === "week" ? "week" : "day";
    const today = businessToday();
    const anchor = readOptionalIsoDate(req.query.date, "date") ?? today;

    const repParam = req.user!.role !== "rep" && typeof req.query.rep === "string" ? req.query.rep : undefined;
    if (repParam !== undefined && !UUID_PATTERN.test(repParam)) {
      throw new AppError(400, "rep must be a valid UUID");
    }
    // Identical scoping to /drilldown: rep -> self; admin/director -> the requested rep, resolved
    // through the active-office rep roster (404 if not a rep). Never UI-gated.
    const scope = resolveRepScope({ role: req.user!.role, userId: req.user!.id }, repParam);
    if (!scope) {
      throw new AppError(400, "rep is required");
    }
    const schema = `office_${req.officeSlug!}`;
    const roster = await resolveReps(req.tenantClient!, scope, USAGE_ROSTER_ROLES);
    if (roster.length === 0) {
      throw new AppError(404, "rep not found in usage roster");
    }
    const rep = roster[0];

    const dates = grain === "week" ? weekDates(anchor) : [anchor];
    const fromDate = dates[0];
    const toExclusive = shiftBusinessDate(dates[dates.length - 1], 1);

    // Actions: never pruned -> always populate, regardless of period age.
    const actions = await readActionDetail(req.tenantClient!, schema, rep.id, fromDate, toExclusive);

    // Views: pruned at 14 days, so the detail's availability is period-age dependent (unlike actions).
    // classifyViewsState decides the state purely from the dates: future (no data yet — NOT "expired"),
    // expired (even the latest non-future day is past the window), partial (latest in-window but the
    // earliest day is pruned), or available. Mirrors the /drilldown expired messaging.
    const vState = classifyViewsState(dates, today);
    let views:
      | { expired: true; partial: false; message: string; items: never[] }
      | { expired: false; partial: boolean; message?: string; items: Awaited<ReturnType<typeof readViewEventsRange>> };
    if (vState.kind === "future") {
      // A future date-picker selection — there is no data yet, and it is not "expired".
      views = { expired: false, partial: false, items: [] };
    } else if (vState.kind === "expired") {
      views = { expired: true, partial: false, message: "view detail expired for this period — counts only", items: [] };
    } else {
      // partial | available — queryFrom is clamped to the oldest in-window day for a partial period so
      // lingering rows (if pruning lags) aren't surfaced past the retention gate.
      const items = await readViewEventsRange(req.tenantClient!, schema, rep.id, vState.queryFrom, toExclusive);
      views = vState.kind === "partial"
        ? { expired: false, partial: true, message: "view detail is partial — older days in this period are beyond the 14-day window", items }
        : { expired: false, partial: false, items };
    }

    await req.commitTransaction!();
    res.json({ data: { rep: { id: rep.id, displayName: rep.displayName }, grain, dates, actions, views } });
  } catch (err) {
    next(err);
  }
});

export const reportRoutes = router;
