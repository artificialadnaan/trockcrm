import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface SavedReport {
  id: string;
  name: string;
  entity: string;
  config: any;
  isLocked: boolean;
  isDefault: boolean;
  createdBy: string | null;
  officeId: string | null;
  visibility: string;
  createdAt: string;
  updatedAt: string;
}

export type ReportFrequency = "daily" | "weekly" | "biweekly" | "monthly" | "quarterly";
export type ReportRunStatus = "queued" | "running" | "succeeded" | "failed" | "not_implemented";

export interface ReportRecipient {
  user_id?: string;
  email?: string;
}

export interface ReportSchedule {
  id: string;
  reportId: string;
  reportName: string;
  frequency: ReportFrequency;
  cronExpr: string;
  recipients: ReportRecipient[];
  nextRunAt: string;
  lastRunAt: string | null;
  ownerId: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReportRun {
  id: string;
  reportId: string;
  reportName: string;
  scheduleId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: ReportRunStatus;
  resultUri: string | null;
  error: string | null;
  runtimeMs: number | null;
}

export interface CreateReportScheduleInput {
  frequency: ReportFrequency;
  cronExpr: string;
  recipients?: ReportRecipient[];
  nextRunAt: string;
}

export interface ReportConfig {
  entity: "deals" | "contacts" | "activities" | "tasks";
  filters: Array<{
    field: string;
    op: string;
    value?: any;
  }>;
  columns: string[];
  sort?: { field: string; dir: "asc" | "desc" };
  chart_type?: "table" | "bar" | "pie" | "line";
  // Locked report specific
  reportType?: string;
  includeDd?: boolean;
}

export type ReportBuilderDimension =
  | "stage"
  | "rep"
  | "region"
  | "source"
  | "deal_type"
  | "month"
  | "week"
  | "age_in_stage_bucket";

export type ReportBuilderMeasure =
  | "deal_count"
  | "total_value"
  | "avg_value"
  | "win_rate"
  | "avg_cycle_time"
  | "avg_age_in_stage";

export interface ReportBuilderRequest {
  dimensions: ReportBuilderDimension[];
  measures: ReportBuilderMeasure[];
  filters: Record<string, unknown>;
  dateField: "created_at" | "updated_at" | "expected_close_date" | "actual_close_date" | "contract_signed_at" | "contract_signed_date";
}

export interface ReportBuilderResult {
  columns: Array<{ key: string; label: string; kind: "dimension" | "measure" }>;
  rows: Record<string, unknown>[];
}

export interface AnalyticsQueryOptions {
  from?: string;
  to?: string;
  officeId?: string;
  regionId?: string;
  repId?: string;
  source?: string;
  includeDd?: boolean;
}

export interface AnalyticsTier4QueryOptions {
  dateFrom?: string;
  dateTo?: string;
  office?: string;
  ownerIds?: string[];
  ownerNames?: string[];
}

export interface UnifiedLeadPipelineSummaryRow {
  workflowRoute: "normal" | "service";
  validationStatus: string;
  intakeCount: number;
}

export interface UnifiedRouteRollupRow {
  workflowRoute: "normal" | "service";
  dealCount: number;
  totalValue: number;
  staleDealCount: number;
}

export interface UnifiedCompanyRollupRow {
  companyId: string | null;
  companyName: string;
  leadCount: number;
  propertyCount: number;
  dealCount: number;
  activeDealCount: number;
  standardDealCount: number;
  serviceDealCount: number;
  totalValue: number;
}

export interface UnifiedRepActivitySplitRow {
  repId: string;
  repName: string;
  leadStageCalls: number;
  leadStageEmails: number;
  leadStageMeetings: number;
  leadStageNotes: number;
  dealStageCalls: number;
  dealStageEmails: number;
  dealStageMeetings: number;
  dealStageNotes: number;
  totalLeadStageActivities: number;
  totalDealStageActivities: number;
}

export interface UnifiedStaleLeadRow {
  leadId: string;
  leadName: string;
  companyName: string;
  workflowRoute: "normal" | "service";
  validationStatus: string;
  ageInDays: number;
  staleThresholdDays: number;
}

export interface UnifiedStaleDealRow {
  dealId: string;
  dealNumber: string;
  dealName: string;
  stageName: string;
  workflowRoute: "normal" | "service";
  repName: string;
  daysInStage: number;
  staleThresholdDays: number;
  dealValue: number;
}

export interface UnifiedCrmOwnedProgressionRow {
  workflowBucket: "lead" | "opportunity" | "crm_owned";
  workflowRoute: "normal" | "service";
  stageName: string;
  itemCount: number;
  totalValue: number;
}

export interface UnifiedMirroredDownstreamSummaryRow {
  mirroredStageSlug: string;
  mirroredStageName: string;
  mirroredStageStatus: string | null;
  workflowRoute: "normal" | "service";
  dealCount: number;
  totalValue: number;
}

export interface UnifiedReasonCodedDisqualificationRow {
  workflowRoute: "normal" | "service";
  disqualificationReason: string;
  leadCount: number;
}

export interface LeadSourceRoiRow {
  source: string;
  leadCount: number;
  dealCount: number;
  activeDeals: number;
  wonDeals: number;
  lostDeals: number;
  activePipelineValue: number;
  wonValue: number;
  winRate: number;
}

export interface UnifiedWorkflowOverview {
  leadPipelineSummary: UnifiedLeadPipelineSummaryRow[];
  standardVsServiceRollups: UnifiedRouteRollupRow[];
  companyRollups: UnifiedCompanyRollupRow[];
  repActivitySplit: UnifiedRepActivitySplitRow[];
  staleLeads: UnifiedStaleLeadRow[];
  staleDeals: UnifiedStaleDealRow[];
  crmOwnedProgression: UnifiedCrmOwnedProgressionRow[];
  mirroredDownstreamSummary: UnifiedMirroredDownstreamSummaryRow[];
  reasonCodedDisqualifications: UnifiedReasonCodedDisqualificationRow[];
}

export interface DataMiningSummary {
  untouchedContact30Count: number;
  untouchedContact60Count: number;
  untouchedContact90Count: number;
  dormantCompany90Count: number;
}

export interface DataMiningUntouchedContactRow {
  contactId: string;
  contactName: string;
  companyName: string;
  daysSinceTouch: number;
  lastTouchedAt: string | null;
}

export interface DataMiningDormantCompanyRow {
  companyId: string;
  companyName: string;
  daysSinceActivity: number;
  lastActivityAt: string | null;
  activeDealCount: number;
}

export interface DataMiningOverview {
  summary: DataMiningSummary;
  untouchedContacts: DataMiningUntouchedContactRow[];
  dormantCompanies: DataMiningDormantCompanyRow[];
}

export interface RegionalOwnershipRegionRollup {
  regionId: string | null;
  regionName: string;
  dealCount: number;
  pipelineValue: number;
  staleDealCount: number;
}

export interface PerformanceReportQueryOptions {
  dateFrom?: string;
  dateTo?: string;
  office?: string;
  ownerNames?: string[];
}

export interface DirectorScorecardReport {
  kpis: {
    totalPipelineValue: number;
    openDealCount: number;
    forecastCommit: number;
    forecastBestCase: number;
    winRate: number;
  };
  risks: {
    dealsAtRisk: number;
    dealsAtRiskValue: number;
    stalledAccounts: number;
    overdueTasks: number;
    missedFollowUps: number;
  };
  repPerformance: Array<{
    repName: string;
    openDeals: number;
    pipelineValue: number;
    wonThisPeriod: number;
    winRate: number;
    activityScore: number;
  }>;
  officeComparison: Array<{
    officeName: string;
    pipelineValue: number;
    openCount: number;
    winRate: number;
  }>;
  topAtRiskDeals: Array<{
    dealId: string;
    dealName: string;
    ownerName: string;
    stageName: string;
    daysInStage: number;
    value: number;
    lastActivityDate: string | null;
  }>;
}

export interface RepActivityReport {
  kpis: {
    totalTouchpoints: number;
    dealsWorked: number;
    calls: number;
    emails: number;
    meetings: number;
    followUpsCompleted: number;
  };
  timeline: Array<{ date: string; touchpoints: number }>;
  stalledAccounts: Array<{
    accountName: string;
    ownerName: string;
    lastActivityDate: string | null;
    daysStalled: number;
    openDeals: number;
    totalOpenValue: number;
  }>;
  activityByType: Array<{ type: string; count: number }>;
  repSummary: Array<{ repName: string; touchpoints: number; activeDeals: number; stalledAccounts: number }>;
}

export interface ForecastAccuracyReport {
  kpis: {
    commit: number;
    bestCase: number;
    pipelineWeighted: number;
    wonActual: number;
  };
  monthly: Array<{ month: string; commit: number; bestCase: number; pipelineWeighted: number; wonActual: number }>;
  accuracy: { variancePercent: number };
  pipelineAtRisk: Array<{
    dealId: string;
    dealName: string;
    ownerName: string;
    stageName: string;
    value: number;
    expectedCloseDate: string | null;
  }>;
}

export interface RegionalOwnershipRepRollup {
  repId: string;
  repName: string;
  dealCount: number;
  pipelineValue: number;
  activityCount: number;
  staleDealCount: number;
}

export interface RegionalOwnershipGap {
  gapType: "missing_assigned_rep" | "missing_region";
  count: number;
}

export interface RegionalOwnershipOverview {
  regionRollups: RegionalOwnershipRegionRollup[];
  repRollups: RegionalOwnershipRepRollup[];
  ownershipGaps: RegionalOwnershipGap[];
}

export interface ForecastVarianceSummary {
  comparableDeals: number;
  avgInitialVariance: number;
  avgQualifiedVariance: number;
  avgEstimatingVariance: number;
  avgCloseDriftDays: number;
}

export interface ForecastVarianceRepRollup {
  repId: string;
  repName: string;
  comparableDeals: number;
  avgInitialVariance: number;
  avgQualifiedVariance: number;
  avgEstimatingVariance: number;
  avgCloseDriftDays: number;
}

export interface ForecastVarianceDealRow {
  dealId: string;
  dealName: string;
  repName: string;
  workflowRoute: "estimating" | "service";
  initialForecast: number;
  qualifiedForecast: number | null;
  estimatingForecast: number | null;
  awardedAmount: number;
  initialVariance: number;
  qualifiedVariance: number | null;
  estimatingVariance: number | null;
  closeDriftDays: number | null;
}

export interface ForecastVarianceOverview {
  summary: ForecastVarianceSummary;
  repRollups: ForecastVarianceRepRollup[];
  deals: ForecastVarianceDealRow[];
}

export interface MarketMixReport {
  kpis: {
    totalDealCount: number;
    totalWonValue: number;
    activeMarkets: number;
    mostActiveRegion: string;
  };
  verticalMix: Array<{ name: string; dealCount: number; wonValue: number }>;
  propertyTypeMix: Array<{ name: string; dealCount: number; wonValue: number }>;
  regionMix: Array<{ name: string; dealCount: number; wonValue: number }>;
  quarterlyWonByVertical: Array<{ quarter: string; vertical: string; wonValue: number }>;
  breakdown: Array<{ vertical: string; activeDeals: number; wonLastYear: number; winRate: number; avgDealSize: number }>;
  proxyNotes: string[];
}

export interface CustomerConcentrationReport {
  kpis: {
    totalActiveCustomers: number;
    totalOpenValue: number;
    topCustomerPipelinePercent: number;
    customersOverOneMillionOpen: number;
  };
  scopeNote: string;
  topCustomers: Array<{
    companyId: string;
    companyName: string;
    activeDeals: number;
    totalOpenValue: number;
    totalWonLifetime: number;
    lastActivityAt: string | null;
    accountOwners: string;
  }>;
  pareto: Array<{ rank: number; companyId: string; companyName: string; pipelineValue: number; cumulativePipelinePercent: number }>;
  distribution: Array<{ bucket: string; customerCount: number }>;
  staleCustomers: Array<{ companyName: string; ownerName: string; openDeals: number; openValue: number; daysStale: number }>;
}

export interface ExecutiveTrendsReport {
  kpis: Array<{
    label: string;
    value: number;
    changePercent: number;
    direction: "up" | "down" | "flat";
    format: "currency" | "number" | "percent";
  }>;
  monthlyTrends: Array<{ month: string; newDeals: number; wonDeals: number; lostDeals: number; activePipelineValue: number }>;
  activePipelineNote: string;
  quarterlyComparison: Array<{
    quarter: string;
    dealsCreated: number;
    won: number;
    lost: number;
    winRate: number;
    avgDealSize: number;
    pipelineEndValue: number;
  }>;
  winRateTrend: Array<{ month: string; winRate: number }>;
  stageProgression: Array<{ stageName: string; enteredCount: number; advancedCount: number; progressionRate: number }>;
}

export interface OperationsReportQueryOptions {
  dateFrom?: string;
  dateTo?: string;
  office?: string;
  ownerIds?: string[];
  ownerNames?: string[];
}

export interface WorkflowBottleneckStage {
  stageName: string;
  openDealCount: number;
  avgDaysInStage: number;
  medianDaysInStage: number;
  maxDaysInStage: number;
  stuckDealCount: number;
}

export interface WorkflowBottleneckDeal {
  dealId: string;
  dealName: string;
  ownerName: string;
  stageName: string;
  daysInStage: number;
  daysSinceLastActivity: number | null;
  value: number;
  projectNumber: string | null;
}

export interface WorkflowBottlenecksReport {
  generatedAt: string;
  kpis: {
    totalStuckDeals: number;
    avgDealAge: number;
    longestStuckDealAge: number;
    stagesWithFivePlusStuckDeals: number;
  };
  stageAging: WorkflowBottleneckStage[];
  topStuckDeals: WorkflowBottleneckDeal[];
  handoffBlockages: WorkflowBottleneckDeal[];
}

export interface ProjectReadinessReport {
  generatedAt: string;
  assumption: string;
  kpis: {
    dealsInScoping: number;
    dealsInEstimating: number;
    dealsContractReady: number;
    dealsKickoffReady: number;
  };
  checklistBreakdown: Array<{
    stageGroup: "Scoping" | "Estimating" | "Contract" | "Kickoff";
    completeCount: number;
    incompleteCount: number;
    signals: string[];
  }>;
  missingReadiness: Array<{
    dealId: string;
    dealName: string;
    ownerName: string;
    stageName: string;
    daysInStage: number;
    missingItems: string[];
    projectNumber: string | null;
  }>;
  ownerSummary: Array<{
    ownerName: string;
    scopingIncomplete: number;
    estimatingIncomplete: number;
    kickoffIncomplete: number;
  }>;
}

export interface PortfolioLoadReport {
  generatedAt: string;
  kpis: {
    activeCompanies: number;
    activeProperties: number;
    totalActiveValue: number;
    avgDealValuePerCompany: number;
  };
  companyBreakdown: Array<{
    companyId: string | null;
    companyName: string;
    activeDealCount: number;
    totalOpenValue: number;
    topProperty: string;
    owners: string[];
    avgDealAge: number;
  }>;
  propertyBreakdown: Array<{
    propertyId: string | null;
    propertyName: string;
    companyName: string;
    activeDealCount: number;
    totalValue: number;
    mostRecentActivity: string | null;
    ownerName: string;
  }>;
  concentrationRisk: Array<{
    companyName: string;
    totalOpenValue: number;
    percentOfOpenPipeline: number;
  }>;
  geographicSpread: {
    byOffice: Array<{ office: string; dealCount: number; totalValue: number }>;
    byRegion: Array<{ region: string; dealCount: number; totalValue: number }>;
  };
}

export function useSavedReports() {
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ reports: SavedReport[] }>("/reports/saved");
      setReports(data.reports);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  return { reports, loading, error, refetch: fetchReports };
}

export async function createSavedReport(input: {
  name: string;
  entity: string;
  config: ReportConfig;
  visibility?: string;
}) {
  return api<{ report: SavedReport }>("/reports/saved", {
    method: "POST",
    json: input,
  });
}

export async function updateSavedReport(reportId: string, input: Partial<SavedReport>) {
  return api<{ report: SavedReport }>(`/reports/saved/${reportId}`, {
    method: "PATCH",
    json: input,
  });
}

export async function deleteSavedReport(reportId: string) {
  return api<{ success: boolean }>(`/reports/saved/${reportId}`, {
    method: "DELETE",
  });
}

export async function listReportSchedules() {
  return api<{ schedules: ReportSchedule[] }>("/reports/schedules");
}

export async function listReportRuns() {
  return api<{ runs: ReportRun[] }>("/reports/runs");
}

export async function createReportRun(reportId: string) {
  return api<{ run: ReportRun }>(`/reports/saved/${reportId}/runs`, {
    method: "POST",
  });
}

export async function createReportSchedule(reportId: string, input: CreateReportScheduleInput) {
  return api<{ schedule: ReportSchedule }>(`/reports/saved/${reportId}/schedules`, {
    method: "POST",
    json: input,
  });
}

export function useReportSchedules() {
  const [schedules, setSchedules] = useState<ReportSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listReportSchedules();
      setSchedules(data.schedules);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load report schedules");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  return { schedules, loading, error, refetch: fetchSchedules };
}

export function useReportRuns() {
  const [runs, setRuns] = useState<ReportRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listReportRuns();
      setRuns(data.runs);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load report runs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  return { runs, loading, error, refetch: fetchRuns };
}

/** Execute a locked report by its reportType */
function appendAnalyticsQueryOptions(params: URLSearchParams, options: AnalyticsQueryOptions) {
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  if (options.officeId) params.set("officeId", options.officeId);
  if (options.regionId) params.set("regionId", options.regionId);
  if (options.repId) params.set("repId", options.repId);
  if (options.source) params.set("source", options.source);
  if (options.includeDd) params.set("includeDd", "true");
}

function appendAnalyticsTier4QueryOptions(params: URLSearchParams, options: AnalyticsTier4QueryOptions) {
  if (options.dateFrom) params.set("dateFrom", options.dateFrom);
  if (options.dateTo) params.set("dateTo", options.dateTo);
  if (options.office && options.office !== "all") params.set("office", options.office);
  if (options.ownerIds?.length) params.set("ownerIds", options.ownerIds.join(","));
  if (options.ownerNames?.length) params.set("ownerNames", options.ownerNames.join(","));
}

export async function executeLockedReport(reportType: string, options: AnalyticsQueryOptions = {}) {
  const params = new URLSearchParams();
  appendAnalyticsQueryOptions(params, options);
  const qs = params.toString();

  const endpointMap: Record<string, string> = {
    pipeline_summary: "/reports/pipeline-summary",
    workflow_overview: "/reports/workflow-overview",
    weighted_forecast: "/reports/weighted-forecast",
    win_loss_ratio: "/reports/win-loss",
    activity_summary: "/reports/activity-summary",
    stale_deals: "/reports/stale-deals",
    lost_by_reason: "/reports/lost-by-reason",
    revenue_by_project_type: "/reports/revenue-by-type",
    lead_source_roi: "/reports/lead-source-roi",
    won_summary: "/reports/won-summary",
    closed_won_summary: "/reports/won-summary",
    pipeline_by_rep: "/reports/pipeline-by-rep",
  };

  const endpoint = endpointMap[reportType];
  if (!endpoint) throw new Error(`Unknown report type: ${reportType}`);

  return api<{ data: any }>(`${endpoint}${qs ? `?${qs}` : ""}`);
}

export async function executeLeadSourceROI(options: AnalyticsQueryOptions = {}) {
  return executeLockedReport("lead_source_roi", options);
}

export async function executeForecastVarianceOverview(options: AnalyticsQueryOptions = {}) {
  const params = new URLSearchParams();
  appendAnalyticsQueryOptions(params, options);
  const qs = params.toString();
  return api<{ data: ForecastVarianceOverview }>(`/reports/forecast-variance${qs ? `?${qs}` : ""}`);
}

export async function executeMarketMixReport(options: AnalyticsTier4QueryOptions = {}) {
  const params = new URLSearchParams();
  appendAnalyticsTier4QueryOptions(params, options);
  const qs = params.toString();
  return api<{ data: MarketMixReport }>(`/reports/market-mix${qs ? `?${qs}` : ""}`);
}

export async function executeCustomerConcentrationReport(options: AnalyticsTier4QueryOptions = {}) {
  const params = new URLSearchParams();
  appendAnalyticsTier4QueryOptions(params, options);
  const qs = params.toString();
  return api<{ data: CustomerConcentrationReport }>(`/reports/customer-concentration${qs ? `?${qs}` : ""}`);
}

export async function executeExecutiveTrendsReport(options: AnalyticsTier4QueryOptions = {}) {
  const params = new URLSearchParams();
  appendAnalyticsTier4QueryOptions(params, options);
  const qs = params.toString();
  return api<{ data: ExecutiveTrendsReport }>(`/reports/executive-trends${qs ? `?${qs}` : ""}`);
}

function appendOperationsReportQueryOptions(params: URLSearchParams, options: OperationsReportQueryOptions = {}) {
  if (options.dateFrom) params.set("dateFrom", options.dateFrom);
  if (options.dateTo) params.set("dateTo", options.dateTo);
  if (options.office) params.set("office", options.office);
  if (options.ownerIds?.length) params.set("ownerIds", options.ownerIds.join(","));
  if (options.ownerNames?.length) params.set("ownerNames", options.ownerNames.join(","));
}

async function executeOperationsReport<T>(endpoint: string, options: OperationsReportQueryOptions = {}) {
  const params = new URLSearchParams();
  appendOperationsReportQueryOptions(params, options);
  const qs = params.toString();
  return api<{ data: T }>(`${endpoint}${qs ? `?${qs}` : ""}`);
}

export function useWorkflowBottlenecksReport(options: OperationsReportQueryOptions = {}) {
  const [data, setData] = useState<WorkflowBottlenecksReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executeOperationsReport<WorkflowBottlenecksReport>("/reports/workflow-bottlenecks", options);
      setData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load workflow bottlenecks");
    } finally {
      setLoading(false);
    }
  }, [options.dateFrom, options.dateTo, options.office, options.ownerIds?.join(","), options.ownerNames?.join(",")]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  return { data, loading, error, refetch: fetchReport };
}

export function useProjectReadinessReport(options: OperationsReportQueryOptions = {}) {
  const [data, setData] = useState<ProjectReadinessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executeOperationsReport<ProjectReadinessReport>("/reports/project-readiness", options);
      setData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load project readiness");
    } finally {
      setLoading(false);
    }
  }, [options.dateFrom, options.dateTo, options.office, options.ownerIds?.join(","), options.ownerNames?.join(",")]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  return { data, loading, error, refetch: fetchReport };
}

export function usePortfolioLoadReport(options: OperationsReportQueryOptions = {}) {
  const [data, setData] = useState<PortfolioLoadReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executeOperationsReport<PortfolioLoadReport>("/reports/portfolio-load", options);
      setData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load portfolio load");
    } finally {
      setLoading(false);
    }
  }, [options.dateFrom, options.dateTo, options.office, options.ownerIds?.join(","), options.ownerNames?.join(",")]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  return { data, loading, error, refetch: fetchReport };
}

export function useLeadSourceROI(options: AnalyticsQueryOptions = {}) {
  const [data, setData] = useState<LeadSourceRoiRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executeLeadSourceROI(options);
      setData(result.data as LeadSourceRoiRow[]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load source performance");
    } finally {
      setLoading(false);
    }
  }, [options.from, options.to, options.officeId, options.regionId, options.repId, options.source, options.includeDd]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  return { data, loading, error, refetch: fetchReport };
}

export function useForecastVarianceOverview(options: AnalyticsQueryOptions = {}) {
  const [data, setData] = useState<ForecastVarianceOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executeForecastVarianceOverview(options);
      setData(result.data as ForecastVarianceOverview);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load forecast variance");
    } finally {
      setLoading(false);
    }
  }, [options.from, options.to, options.officeId, options.regionId, options.repId, options.source, options.includeDd]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  return { data, loading, error, refetch: fetchOverview };
}

export function useMarketMixReport(options: AnalyticsTier4QueryOptions = {}) {
  const [data, setData] = useState<MarketMixReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executeMarketMixReport(options);
      setData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load market mix");
    } finally {
      setLoading(false);
    }
  }, [options.dateFrom, options.dateTo, options.office, options.ownerIds?.join(","), options.ownerNames?.join(",")]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  return { data, loading, error, refetch: fetchReport };
}

export function useCustomerConcentrationReport(options: AnalyticsTier4QueryOptions = {}) {
  const [data, setData] = useState<CustomerConcentrationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executeCustomerConcentrationReport(options);
      setData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load customer concentration");
    } finally {
      setLoading(false);
    }
  }, [options.dateFrom, options.dateTo, options.office, options.ownerIds?.join(","), options.ownerNames?.join(",")]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  return { data, loading, error, refetch: fetchReport };
}

export function useExecutiveTrendsReport(options: AnalyticsTier4QueryOptions = {}) {
  const [data, setData] = useState<ExecutiveTrendsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executeExecutiveTrendsReport(options);
      setData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load executive trends");
    } finally {
      setLoading(false);
    }
  }, [options.dateFrom, options.dateTo, options.office, options.ownerIds?.join(","), options.ownerNames?.join(",")]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  return { data, loading, error, refetch: fetchReport };
}

export async function executeWorkflowOverview(options: AnalyticsQueryOptions = {}) {
  const params = new URLSearchParams();
  appendAnalyticsQueryOptions(params, options);
  const qs = params.toString();

  return api<{ data: UnifiedWorkflowOverview }>(`/reports/workflow-overview${qs ? `?${qs}` : ""}`);
}

export function useUnifiedWorkflowOverview(options: AnalyticsQueryOptions = {}) {
  const [data, setData] = useState<UnifiedWorkflowOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executeWorkflowOverview(options);
      setData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load workflow overview");
    } finally {
      setLoading(false);
    }
  }, [options.from, options.to, options.officeId, options.regionId, options.repId, options.source, options.includeDd]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  return { data, loading, error, refetch: fetchOverview };
}

export async function executeDataMiningOverview(options: AnalyticsQueryOptions = {}) {
  const params = new URLSearchParams();
  appendAnalyticsQueryOptions(params, options);
  const qs = params.toString();

  return api<{ data: DataMiningOverview }>(`/reports/data-mining${qs ? `?${qs}` : ""}`);
}

export function useDataMiningOverview(
  options: AnalyticsQueryOptions = {},
  settings: { enabled?: boolean } = {}
) {
  const [data, setData] = useState<DataMiningOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const enabled = settings.enabled ?? true;

  const fetchOverview = useCallback(async () => {
    if (!enabled) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await executeDataMiningOverview(options);
      setData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load data mining overview");
    } finally {
      setLoading(false);
    }
  }, [enabled, options.from, options.to, options.officeId, options.regionId, options.repId, options.source, options.includeDd]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  return { data, loading, error, refetch: fetchOverview };
}

export async function executeRegionalOwnershipOverview(options: AnalyticsQueryOptions = {}) {
  const params = new URLSearchParams();
  appendAnalyticsQueryOptions(params, options);
  const qs = params.toString();

  return api<{ data: RegionalOwnershipOverview }>(`/reports/regional-ownership${qs ? `?${qs}` : ""}`);
}

export function useRegionalOwnershipOverview(options: AnalyticsQueryOptions = {}, enabled = true) {
  const [data, setData] = useState<RegionalOwnershipOverview | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    if (!enabled) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await executeRegionalOwnershipOverview(options);
      setData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load regional ownership");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [enabled, options.from, options.to, options.officeId, options.regionId, options.repId, options.source]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  return { data, loading, error, refetch: fetchOverview };
}

function appendPerformanceReportQueryOptions(params: URLSearchParams, options: PerformanceReportQueryOptions) {
  if (options.dateFrom) params.set("dateFrom", options.dateFrom);
  if (options.dateTo) params.set("dateTo", options.dateTo);
  if (options.office && options.office !== "all") params.set("office", options.office);
  if (options.ownerNames?.length) params.set("ownerNames", options.ownerNames.join(","));
}

function performanceDeps(options: PerformanceReportQueryOptions) {
  return [
    options.dateFrom,
    options.dateTo,
    options.office,
    options.ownerNames?.join(","),
  ] as const;
}

async function executePerformanceReport<T>(path: string, options: PerformanceReportQueryOptions = {}) {
  const params = new URLSearchParams();
  appendPerformanceReportQueryOptions(params, options);
  const qs = params.toString();
  return api<{ data: T }>(`/reports/${path}${qs ? `?${qs}` : ""}`);
}

function usePerformanceReport<T>(path: string, options: PerformanceReportQueryOptions = {}, errorMessage: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const deps = performanceDeps(options);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executePerformanceReport<T>(path, options);
      setData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : errorMessage);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [path, errorMessage, ...deps]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  return { data, loading, error, refetch: fetchReport };
}

export function useDirectorScorecardReport(options: PerformanceReportQueryOptions = {}) {
  return usePerformanceReport<DirectorScorecardReport>(
    "director-scorecard",
    options,
    "Failed to load director scorecard"
  );
}

export function useRepActivityReport(options: PerformanceReportQueryOptions = {}) {
  return usePerformanceReport<RepActivityReport>(
    "rep-activity",
    options,
    "Failed to load rep activity"
  );
}

export function useForecastAccuracyReport(options: PerformanceReportQueryOptions = {}) {
  return usePerformanceReport<ForecastAccuracyReport>(
    "forecast-accuracy",
    options,
    "Failed to load forecast accuracy"
  );
}

/** Execute a custom report config */
export async function executeCustomReport(
  config: ReportConfig,
  pagination: { page: number; limit: number } = { page: 1, limit: 100 }
) {
  return api<{ rows: Record<string, any>[]; total: number }>("/reports/execute", {
    method: "POST",
    json: { config, ...pagination },
  });
}

export async function runReportBuilder(input: ReportBuilderRequest) {
  return api<{ data: ReportBuilderResult }>("/reports/run", {
    method: "POST",
    json: input,
  });
}
