import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { useOfficeScopeId } from "./use-office-scope";
import { api } from "@/lib/api";
import type {
  MondayShowcaseData,
  MondayShowcaseEvidence,
  EvidenceRequest,
  RouteBucket,
} from "@/pages/reports/monday-showcase/types";
import type { RepPackData, AtRiskWatchlist } from "@/pages/reports/part4-types";
import type { WeekMode } from "@/pages/reports/week-mode";
import type { RegionReportData } from "@/pages/reports/region-report-types";

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
  notes?: string[];
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

export interface SalesReportQueryOptions {
  dateFrom?: string;
  dateTo?: string;
  office?: string;
  ownerIds?: string[];
  ownerNames?: string[];
  ownerEmails?: string[];
}

export interface AnalyticsTier4QueryOptions {
  dateFrom?: string;
  dateTo?: string;
  office?: string;
  ownerIds?: string[];
  ownerNames?: string[];
}

export interface PipelineVelocityOverview {
  kpis: {
    avgDealAgeDays: number;
    totalOpenValue: number;
    openDealCount: number;
    stuckDealCount: number;
  };
  stages: Array<{
    stageId: string;
    stageName: string;
    openDeals: number;
    totalValue: number;
    avgDaysInStage: number;
    medianDaysInStage: number;
    oldestDeal: { dealId: string | null; dealName: string; dealIsChangeOrder?: boolean | null; daysInStage: number };
  }>;
  agingBuckets: Array<{ bucket: string; label: string; dealCount: number; totalValue: number }>;
  stuckDeals: Array<{
    dealId: string;
    dealName: string;
    dealIsChangeOrder?: boolean | null;
    ownerName: string;
    stageName: string;
    daysInStage: number;
    value: number;
  }>;
}

export interface ClosedWonRevenueOverview {
  kpis: {
    totalBookedRevenue: number;
    wonDealCount: number;
    avgDealSize: number;
    winRate: number;
  };
  monthlyRevenue: Array<{ month: string; label: string; totalRevenue: number; wonDeals: number }>;
  byOwner: Array<{
    ownerId: string;
    ownerName: string;
    wonDeals: number;
    totalRevenue: number;
    avgDealSize: number;
    largestWonDeal: { dealId: string | null; dealName: string; dealIsChangeOrder?: boolean | null; value: number };
  }>;
  byRegion: Array<{ regionName: string; wonDeals: number; totalRevenue: number; percentOfTotal: number }>;
  byWorkflowFamily: Array<{ workflowFamily: string; workflowFamilyName: string; wonDeals: number; totalRevenue: number }>;
  topDeals: Array<{ dealId: string; dealName: string; dealIsChangeOrder?: boolean | null; ownerName: string; value: number; wonAt: string }>;
}

export interface LeadConversionOverview {
  kpis: {
    totalLeads: number;
    qualified: number;
    inDeals: number;
    won: number;
    leadToDealRate: number;
    dealToWonRate: number;
  };
  funnel: Array<{ key: string; label: string; count: number; conversionRate: number }>;
  bySource: Array<{ source: string; leads: number; qualified: number; convertedToDeal: number; won: number; totalRevenue: number }>;
  monthlyTrend: Array<{ month: string; label: string; leads: number; convertedToDeal: number; won: number; conversionRate: number }>;
  topRevenueSources: Array<{ source: string; totalRevenue: number; won: number }>;
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
  ownerIds?: string[];
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
    /** `deals.is_change_order` — the AUTHORITY for the change-order display relabel. */
    dealIsChangeOrder?: boolean | null;
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

/**
 * Daily Activity Log — the readable entries behind the Rep Activity counts.
 *
 * `days[].entryCount` is the FULL-window count for that day, not the number of entries on the
 * current page, so a day section can legitimately show fewer rows than it claims. The page range in
 * `pagination` is what makes that honest — render it.
 */
export interface DailyActivityLogEntry {
  id: string;
  type: string;
  typeLabel: string;
  occurredAt: string;
  occurredDate: string;
  loggedAt: string;
  loggedDate: string;
  loggedSameDay: boolean;
  /** loggedDate - occurredDate in whole days: positive = written up late, negative = dated ahead. */
  loggedDaysDiff: number;
  responsibleUserId: string;
  responsibleName: string;
  performedByName: string | null;
  subject: string | null;
  body: string | null;
  outcome: string | null;
  nextStep: string | null;
  nextStepDueAt: string | null;
  /** Someone else's email activity: the row still counts, but its content is withheld. Label it. */
  contentRestricted: boolean;
  durationMinutes: number | null;
  targetType: string | null;
  targetName: string | null;
  dealId: string | null;
  dealName: string | null;
  dealNumber: string | null;
}

export interface DailyActivityLogReport {
  /**
   * WINDOW-scoped: dates/office/owner only, NEVER the entry-type or logged-off-day narrowing. The KPI
   * cards render these and are themselves the narrowing controls, so a card must not rewrite its own
   * number when it is clicked. `pagination.total` is the narrowed count — render both.
   */
  kpis: {
    totalEntries: number;
    notes: number;
    daysCovered: number;
    repsLogging: number;
    offDayLogged: number;
  };
  days: Array<{
    date: string;
    entryCount: number;
    noteCount: number;
    repCount: number;
    offDayLoggedCount: number;
    entries: DailyActivityLogEntry[];
  }>;
  pagination: {
    page: number;
    limit: number;
    /** The NARROWED row count — how many entries the current type/off-day selection matches. */
    total: number;
    returned: number;
    totalPages: number;
    hasMore: boolean;
  };
  appliedTypes: string[];
  /** Echoes the off-day narrowing the SERVER applied, the same way appliedTypes echoes the types. */
  appliedLoggedOffDay: boolean;
}

export interface DailyActivityLogQueryOptions extends PerformanceReportQueryOptions {
  types?: string[];
  /** Narrow to entries logged on a different day than they occurred — the "Logged Off-Day" drill. */
  loggedOffDay?: boolean;
  page?: number;
  limit?: number;
}

/* -------------------------------------------------------------------------------------------------
 * Canvassing Activity — who entered new companies/properties/contacts/leads, per person, per period.
 * Mirrors server/src/modules/reports/canvassing-activity-service.ts.
 * ---------------------------------------------------------------------------------------------- */

export const CANVASSING_KINDS = ["company", "property", "contact", "lead"] as const;
export type CanvassingKind = (typeof CANVASSING_KINDS)[number];
export type CanvassingBucket = "week" | "month" | "quarter";

export type CanvassingCounts = Record<CanvassingKind, number> & { total: number };

export interface CanvassingPersonRow {
  userId: string;
  displayName: string;
  email: string | null;
  role: string | null;
  isActive: boolean;
  counts: CanvassingCounts;
  notesLogged: number;
}

export interface CanvassingBucketRow {
  bucketStart: string;
  label: string;
  /** The range covers only PART of this calendar period — normal for the first and last bucket. */
  partial: boolean;
  counts: CanvassingCounts;
  /** Records created in this bucket that name NO creator — pre-0220 rows and machine-created ones. */
  unattributed: CanvassingCounts;
  perUser: Array<{ userId: string; counts: CanvassingCounts; notesLogged: number }>;
}

export interface CanvassingNoteRow {
  id: string;
  type: string;
  subject: string | null;
  body: string | null;
  occurredAt: string;
  userId: string | null;
  userName: string | null;
  /** Set only when someone OTHER than the attributed user actually logged it. */
  performedByName: string | null;
  targetType: "company" | "property" | "contact" | "lead" | "deal" | null;
  targetId: string | null;
  targetName: string | null;
}

export interface CanvassingActivityReport {
  range: { from: string; to: string };
  /** The requested window was longer than supported and `range.from` was moved forward. */
  rangeClamped: boolean;
  bucket: CanvassingBucket;
  totals: CanvassingCounts;
  unattributed: CanvassingCounts;
  notesLogged: number;
  people: CanvassingPersonRow[];
  buckets: CanvassingBucketRow[];
  notes: CanvassingNoteRow[];
  notesTruncated: boolean;
  /** The feed shows only the viewer's own notes; the counts still describe everyone. */
  notesRestrictedToSelf: boolean;
  /** Earliest attributed creation; before this the report is structurally blind, not empty. */
  attributionStartHint: string | null;
}

export interface CanvassingActivityQueryOptions {
  dateFrom?: string;
  dateTo?: string;
  bucket?: CanvassingBucket;
  userIds?: string[];
  /** The filter bar's legacy name/email owner selectors; resolved to ids server-side. */
  ownerNames?: string[];
  ownerEmails?: string[];
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
    /** `deals.is_change_order` — the AUTHORITY for the change-order display relabel. */
    dealIsChangeOrder?: boolean | null;
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
  /** `deals.is_change_order` — the AUTHORITY for the change-order display relabel. */
  dealIsChangeOrder?: boolean | null;
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
  /** `deals.is_change_order` — the AUTHORITY for the change-order display relabel. */
  dealIsChangeOrder?: boolean | null;
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
    /** `deals.is_change_order` — the AUTHORITY for the change-order display relabel. */
    dealIsChangeOrder?: boolean | null;
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

function appendSalesReportQueryOptions(params: URLSearchParams, options: SalesReportQueryOptions) {
  if (options.dateFrom) params.set("dateFrom", options.dateFrom);
  if (options.dateTo) params.set("dateTo", options.dateTo);
  if (options.office && options.office !== "all") params.set("office", options.office);
  if (options.ownerIds?.length) params.set("ownerIds", options.ownerIds.join(","));
  if (options.ownerNames?.length) params.set("owners", options.ownerNames.join(","));
  if (options.ownerEmails?.length) params.set("ownerEmails", options.ownerEmails.join(","));
}

function appendAnalyticsTier4QueryOptions(params: URLSearchParams, options: AnalyticsTier4QueryOptions) {
  if (options.dateFrom) params.set("dateFrom", options.dateFrom);
  if (options.dateTo) params.set("dateTo", options.dateTo);
  if (options.office && options.office !== "all") params.set("office", options.office);
  if (options.ownerIds?.length) params.set("ownerIds", options.ownerIds.join(","));
  if (options.ownerNames?.length) params.set("ownerNames", options.ownerNames.join(","));
}

async function executeSalesReport<T>(endpoint: string, options: SalesReportQueryOptions = {}) {
  const params = new URLSearchParams();
  appendSalesReportQueryOptions(params, options);
  const qs = params.toString();
  return api<{ data: T }>(`${endpoint}${qs ? `?${qs}` : ""}`);
}

// Pipeline Velocity, Closed Won Revenue and Lead Conversion.
function useSalesReport<T>(
  endpoint: string,
  options: SalesReportQueryOptions,
  errorMessage: string
) {
  return useScopedReport<T>(
    async () => (await executeSalesReport<T>(endpoint, options)).data,
    [
      endpoint,
      options.dateFrom,
      options.dateTo,
      options.office,
      options.ownerIds?.join(","),
      options.ownerNames?.join(","),
      options.ownerEmails?.join(","),
    ],
    errorMessage
  );
}

export function usePipelineVelocityReport(options: SalesReportQueryOptions = {}) {
  return useSalesReport<PipelineVelocityOverview>(
    "/reports/pipeline-velocity",
    options,
    "Failed to load pipeline velocity"
  );
}

export function useClosedWonRevenueReport(options: SalesReportQueryOptions = {}) {
  return useSalesReport<ClosedWonRevenueOverview>(
    "/reports/closed-won-revenue",
    options,
    "Failed to load closed won revenue"
  );
}

export function useLeadConversionReport(options: SalesReportQueryOptions = {}) {
  return useSalesReport<LeadConversionOverview>(
    "/reports/lead-conversion",
    options,
    "Failed to load lead conversion"
  );
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
  return useScopedReport<WorkflowBottlenecksReport>(
    async () => (await executeOperationsReport<WorkflowBottlenecksReport>("/reports/workflow-bottlenecks", options)).data,
    [options.dateFrom, options.dateTo, options.office, options.ownerIds?.join(","), options.ownerNames?.join(",")],
    "Failed to load workflow bottlenecks"
  );
}

export function useProjectReadinessReport(options: OperationsReportQueryOptions = {}) {
  return useScopedReport<ProjectReadinessReport>(
    async () => (await executeOperationsReport<ProjectReadinessReport>("/reports/project-readiness", options)).data,
    [options.dateFrom, options.dateTo, options.office, options.ownerIds?.join(","), options.ownerNames?.join(",")],
    "Failed to load project readiness"
  );
}

export function usePortfolioLoadReport(options: OperationsReportQueryOptions = {}) {
  return useScopedReport<PortfolioLoadReport>(
    async () => (await executeOperationsReport<PortfolioLoadReport>("/reports/portfolio-load", options)).data,
    [options.dateFrom, options.dateTo, options.office, options.ownerIds?.join(","), options.ownerNames?.join(",")],
    "Failed to load portfolio load"
  );
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
  if (options.ownerIds?.length) params.set("ownerIds", options.ownerIds.join(","));
  if (options.ownerNames?.length) params.set("ownerNames", options.ownerNames.join(","));
}

/**
 * The app-level cross-office scope (?officeId) as a dependency key.
 *
 * This is an INVISIBLE input to every report request: api() reads ?officeId straight off
 * window.location at call time and sends it as the x-office-id header, so it never appears in a
 * hook's options object and is trivially left out of a dependency array. When that happens the
 * symptom is nasty rather than obvious — switching office re-renders the page (so links and headers
 * pick up the new office) but does NOT refetch, leaving the PREVIOUS office's rows on screen now
 * presented under, and linking into, the new office.
 *
 * Any hook whose request goes through api() must therefore include this in its deps, the same way it
 * includes the filters it passes explicitly. Reading it here rather than making every caller thread
 * it keeps the implicit input handled in one place. (EstimatorPipelinePage solves the same problem by
 * hand with an `officeScopeKey` prop; this is that idea made reusable.)
 */
function useOfficeScopeKey() {
  // Same source of truth as the deal links (useDealHref) — one reader of ?officeId, so the fetch
  // scope and the link scope can never disagree about what the current tenant is.
  return useOfficeScopeId() ?? "";
}

/**
 * ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ BEFORE YOU CONVERT A HOOK TO THIS WRAPPER, READ THIS.                                         │
 * │                                                                                               │
 * │   A hook may not become office-scoped unless EVERY link on its pages carries the office.      │
 * │                                                                                               │
 * │ Converting a hook makes its rows follow ?officeId. Any link on those pages that still emits a │
 * │ bare /deals/:id (or /companies/:id, /properties/:id) then points at the viewer's DEFAULT       │
 * │ tenant while the rows came from the scoped one — correct rows under wrong links, which is      │
 * │ worse than the stale list the conversion was meant to fix, because nothing looks broken.      │
 * │                                                                                               │
 * │ This is not hypothetical: converting useSalesReport and usePortfolioLoadReport did exactly    │
 * │ this to Pipeline Velocity, Closed Won Revenue and Portfolio Load, whose inline links had been  │
 * │ deferred as an acceptable follow-up while those reports were NOT office-aware. The conversion  │
 * │ is what turned a harmless deferral into a bug.                                                │
 * │                                                                                               │
 * │ The wrapper CANNOT enforce this — it owns the fetch, not the JSX, and has no way to see what   │
 * │ a page renders. It is a manual checklist item, which is why it is stated here rather than      │
 * │ left to a lint rule that does not exist:                                                      │
 * │                                                                                               │
 * │   1. grep the pages using the hook for `to={\`/deals/`, `/companies/`, `/properties/`          │
 * │   2. route every one through useDealHref / useOfficeScopedHref (hooks/use-office-scope.ts)     │
 * │   3. test BOTH directions — officeId carried verbatim when present, nothing when absent        │
 * │                                                                                               │
 * │ Still unconverted, each carrying this obligation when its turn comes: the analytics family     │
 * │ (useLeadSourceROI, useForecastVarianceOverview, useMarketMixReport,                            │
 * │ useCustomerConcentrationReport, useExecutiveTrendsReport, useUnifiedWorkflowOverview,          │
 * │ useDataMiningOverview, useRegionalOwnershipOverview) and the showcase family                   │
 * │ (useMondayShowcase, useShowcaseEvidence, useRepPack, useAtRiskWatchlist, useRegionReport).     │
 * │                                                                                               │
 * │ ALSO OPEN, one hop further out: the scope now survives report -> entity detail, but company    │
 * │ and property DETAIL pages emit bare onward links of their own (related deals, properties), so  │
 * │ it dies on the second hop. Same rule, different surface — auditing every onward link on        │
 * │ client/src/pages/companies/company-detail-page.tsx and                                         │
 * │ client/src/pages/properties/property-detail-page.tsx is its own change, not a report fix.      │
 * └───────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * The office-scope plumbing every report hook needs, in one place.
 *
 * Three DISTINCT properties that have to travel together. They were added one at a time, to one hook
 * family at a time, and each omission produced its own bug:
 *
 *   1. Office DEPENDENCY — refetch when ?officeId changes. Without it the previous office's rows stay
 *      on screen forever after a scope switch.
 *   2. Stale-response GUARD — a monotonic request id, so an older office's in-flight response cannot
 *      land after a newer one and overwrite it. Adding (1) without (2) creates this race.
 *   3. Synchronous INVALIDATION — clear rows in a LAYOUT effect keyed on the scope. (2) stops an old
 *      RESPONSE being accepted; it does nothing about old ROWS already painted. The request id is
 *      bumped inside the async fetch callback, which runs in a passive effect AFTER commit, while
 *      useDealHref has already re-rendered links with the NEW office. That leaves a painted frame
 *      showing office A's rows under office B's links, and a fast click goes to the wrong tenant.
 *      A layout effect runs after commit but before paint and before any pending response's
 *      resolution microtask, so it closes that window.
 *
 * The layout-effect approach is lifted from usePendingRfp (client/src/hooks/use-deals.ts), which
 * solved exactly this and documents why a layout effect beats mutating a ref during render (safe
 * under concurrent rendering, and only for committed renders). Keyed here on the office scope alone
 * rather than the whole search string: filter/page changes already refetch through `deps`, and
 * blanking the table on every filter tweak would be a behaviour change beyond this fix.
 */
function useScopedReport<T>(
  fetcher: () => Promise<T>,
  /**
   * The values that change the request. MUST be CONSTANT-LENGTH across renders for a given call site
   * — it is spread into a useCallback dependency array, and React requires those to be stable in size.
   * A caller building this conditionally (`[...base, ...(x ? [x] : [])]`) would break subtly: React
   * warns, then compares mismatched positions, so the hook can refetch when nothing changed or fail to
   * refetch when something did. Pass a fixed-shape array and let entries be `undefined` instead.
   */
  deps: readonly unknown[],
  errorMessage: string
) {
  const officeScopeKey = useOfficeScopeKey();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const isFirstLayout = useRef(true);

  useLayoutEffect(() => {
    requestIdRef.current += 1;
    // Skip the mount run: state already starts as loading with no rows, and only a real scope CHANGE
    // should clear anything.
    if (isFirstLayout.current) {
      isFirstLayout.current = false;
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
  }, [officeScopeKey]);

  const fetchReport = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      if (requestId !== requestIdRef.current) return; // superseded
      setData(result);
    } catch (err: unknown) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : errorMessage);
      setData(null);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
    // `fetcher` is intentionally not a dep — it is a fresh closure every render. The listed deps are
    // the values that actually change the request, matching what these hooks already did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officeScopeKey, errorMessage, ...deps]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  return { data, loading, error, refetch: fetchReport };
}

function performanceDeps(options: PerformanceReportQueryOptions) {
  return [
    options.dateFrom,
    options.dateTo,
    options.office,
    options.ownerIds?.join(","),
    options.ownerNames?.join(","),
  ] as const;
}

async function executePerformanceReport<T>(path: string, options: PerformanceReportQueryOptions = {}) {
  const params = new URLSearchParams();
  appendPerformanceReportQueryOptions(params, options);
  const qs = params.toString();
  return api<{ data: T }>(`/reports/${path}${qs ? `?${qs}` : ""}`);
}

// Director Scorecard, Rep Activity and Forecast Accuracy.
function usePerformanceReport<T>(path: string, options: PerformanceReportQueryOptions = {}, errorMessage: string) {
  return useScopedReport<T>(
    async () => (await executePerformanceReport<T>(path, options)).data,
    [path, ...performanceDeps(options)],
    errorMessage
  );
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

/**
 * Daily Activity Log. Not routed through usePerformanceReport because it carries four params that
 * report does not know about (types/loggedOffDay/page/limit) and they must take part in the refetch
 * deps — otherwise turning a filter on or paging forward would leave the previous page on screen.
 */
export function useDailyActivityLogReport(options: DailyActivityLogQueryOptions = {}) {
  const typeKey = options.types?.join(",") ?? "";
  return useScopedReport<DailyActivityLogReport>(
    async () => {
      const params = new URLSearchParams();
      appendPerformanceReportQueryOptions(params, options);
      if (options.types?.length) params.set("types", options.types.join(","));
      if (options.loggedOffDay) params.set("loggedOffDay", "1");
      if (options.page && options.page > 1) params.set("page", String(options.page));
      if (options.limit) params.set("limit", String(options.limit));
      const qs = params.toString();
      return (await api<{ data: DailyActivityLogReport }>(`/reports/daily-activity-log${qs ? `?${qs}` : ""}`)).data;
    },
    [
      options.dateFrom,
      options.dateTo,
      options.office,
      options.ownerIds?.join(","),
      options.ownerNames?.join(","),
      typeKey,
      // The off-day drill is a SERVER filter, so it has to be a dependency: without it the toggle
      // would repaint the same rows and read as "the filter does nothing".
      options.loggedOffDay,
      options.page,
      options.limit,
    ],
    "Failed to load the daily activity log"
  );
}

export function useCanvassingActivityReport(options: CanvassingActivityQueryOptions = {}) {
  const userKey = options.userIds?.join(",") ?? "";
  const nameKey = options.ownerNames?.join(",") ?? "";
  const emailKey = options.ownerEmails?.join(",") ?? "";
  return useScopedReport<CanvassingActivityReport>(
    async () => {
      const params = new URLSearchParams();
      if (options.dateFrom) params.set("dateFrom", options.dateFrom);
      if (options.dateTo) params.set("dateTo", options.dateTo);
      if (options.bucket) params.set("bucket", options.bucket);
      if (userKey) params.set("userIds", userKey);
      if (nameKey) params.set("owners", nameKey);
      if (emailKey) params.set("ownerEmails", emailKey);
      const qs = params.toString();
      return (await api<{ data: CanvassingActivityReport }>(`/reports/canvassing-activity${qs ? `?${qs}` : ""}`)).data;
    },
    [options.dateFrom, options.dateTo, options.bucket, userKey, nameKey, emailKey],
    "Failed to load canvassing activity"
  );
}

/* -------------------------------------------------------------------------------------------------
 * Canvassing Activity drill-to-evidence — the records behind ONE number.
 * ---------------------------------------------------------------------------------------------- */

/** `all` is the grid's combined column — counts.total — and returns the four kinds in one list. */
export type CanvassingEvidenceKind = CanvassingKind | "all" | "notes";

export interface CanvassingEvidenceRecord {
  id: string;
  label: string;
  sublabel: string | null;
  occurredAt: string;
  href: string | null;
  /** Which of the four this row is. Present on record drills; the combined list needs it to be readable. */
  kind?: CanvassingKind;
}

export interface CanvassingEvidenceResult {
  kind: CanvassingEvidenceKind;
  userId: string;
  bucketStart: string | null;
  /** The figure the drill was opened from. Counted with the report's own predicate, not rows.length. */
  total: number;
  rows: CanvassingEvidenceRecord[];
  truncated: boolean;
  /** Rows narrowed to the viewer's own notes; `total` still describes everyone's. */
  restrictedToSelf: boolean;
}

/** Fetched on demand when a cell is clicked, rather than prefetched for every cell on the page. */
export async function fetchCanvassingEvidence(input: {
  kind: CanvassingEvidenceKind;
  userId: string;
  bucketStart?: string | null;
  bucket: CanvassingBucket;
  dateFrom?: string;
  dateTo?: string;
  ownerIds?: string[];
}): Promise<CanvassingEvidenceResult> {
  const params = new URLSearchParams();
  params.set("kind", input.kind);
  params.set("userId", input.userId);
  params.set("bucket", input.bucket);
  if (input.bucketStart) params.set("bucketStart", input.bucketStart);
  if (input.dateFrom) params.set("dateFrom", input.dateFrom);
  if (input.dateTo) params.set("dateTo", input.dateTo);
  return (await api<{ data: CanvassingEvidenceResult }>(`/reports/canvassing-activity/evidence?${params.toString()}`)).data;
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

// Reports Part 2 -- the Monday showcase. ONE payload feeds all 8 variants (so they reconcile).
/**
 * `routes` is the page-local Service/Other selection. `undefined` = both buckets = NO ?routes param, so a
 * default page load issues the exact request it did before the filter existed. A narrowing selection is
 * part of the cache key (the deps below), so toggling a chip refetches rather than repainting stale
 * office-wide numbers under a filtered chip.
 */
export function useMondayShowcase(
  mode: WeekMode = "to_date",
  routes?: readonly RouteBucket[],
  // `false` when the page is in a state that has no honest payload to request (no bucket selected, or an
  // unparseable ?routes). It must not fetch: an un-narrowed request would load the OFFICE-WIDE report and
  // leave a full payload sitting behind a filter UI that claims otherwise.
  enabled: boolean = true
) {
  const [data, setData] = useState<MondayShowcaseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request id: this endpoint fans out many queries, so a mode toggle can leave an older
  // request in flight. Only the latest request is allowed to write state -- a stale response is dropped,
  // so the page never shows the new toggle with the previous period's data.
  const latestRequest = useRef(0);
  // Depend on the VALUE, not the array identity -- a caller rebuilding the array each render must not
  // retrigger an infinite fetch loop.
  const routesKey = routes?.join(",") ?? "";

  const fetchShowcase = useCallback(async () => {
    const requestId = ++latestRequest.current;
    if (!enabled) {
      // Drop any previously-loaded payload. Leaving it would let the last filter's numbers stay on screen
      // while the controls say "nothing selected" — a stale set read as the current one.
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    // Drop the previous payload BEFORE the new one lands. While it sits here every consumer deriving copy
    // from it -- notably the chip-row caveat naming which figures are filtered -- describes a request that
    // is no longer the current one. The numbers are already hidden behind `loading`; this closes the same
    // gap for anything rendered outside that switch.
    setData(null);
    try {
      const params = new URLSearchParams({ mode });
      if (routesKey) params.set("routes", routesKey);
      const result = await api<{ data: MondayShowcaseData }>(`/reports/monday-showcase?${params.toString()}`);
      if (requestId !== latestRequest.current) return; // superseded by a newer request
      setData(result.data);
    } catch (err: unknown) {
      if (requestId !== latestRequest.current) return;
      setError(err instanceof Error ? err.message : "Failed to load the Monday showcase");
      // Clear the payload on failure. A rejected ?routes value (400) must NOT leave the previous, more
      // broadly-scoped numbers on screen under the new chip state -- that is a stale set read as a filtered one.
      setData(null);
    } finally {
      if (requestId === latestRequest.current) setLoading(false);
    }
  }, [mode, routesKey, enabled]);

  useEffect(() => {
    fetchShowcase();
  }, [fetchShowcase]);

  return { data, loading, error, refetch: fetchShowcase };
}

// Reports Part 3 -- drill-to-evidence. Fetches the supporting records behind ONE showcase number when a
// request is set (a number was clicked); null clears. Same monotonic-request guard so a fast re-click
// can't show stale evidence under a newer heading.
export function useShowcaseEvidence(
  request: EvidenceRequest | null,
  mode: WeekMode,
  // The SAME Service/Other selection the clicked number was rendered under. Passing it is what makes the
  // drawer's total equal the figure that was clicked instead of an office-wide superset -- a card reading
  // 6 under "Service" opening 10 records is the exact defect this threading exists to prevent.
  routes?: readonly RouteBucket[]
) {
  const [data, setData] = useState<MondayShowcaseEvidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);
  const routesKey = routes?.join(",") ?? "";

  // The fetch is a stable callback so the drawer can REFETCH it after an inline edit (a close-date move on
  // the undated list) — the edited deal then drops out of the reconciling set without reopening the drawer.
  const fetchEvidence = useCallback(async () => {
    if (!request) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const requestId = ++latestRequest.current;
    setLoading(true);
    setError(null);
    setData(null);
    const params = new URLSearchParams({ metric: request.metric, mode });
    // repId undefined = office-wide (omit); null = the Unassigned bucket (sentinel); else the rep UUID.
    if (request.repId !== undefined) {
      params.set("repId", request.repId === null ? "__unassigned__" : request.repId);
    }
    if (request.band) params.set("band", request.band);
    if (request.leadStage) params.set("leadStage", request.leadStage);
    // Reports-by-Region drill: the displayed region row's name + the section's exact period (+ optional
    // heatmap stage). Passing the same params the number was computed with is what keeps the drawer
    // reconciled to the clicked figure. "Unassigned" is just the name (matches the server bucket predicate).
    if (request.regionName !== undefined) params.set("regionName", request.regionName);
    if (request.from) params.set("from", request.from);
    if (request.to) params.set("to", request.to);
    if (request.stageSlug) params.set("stageSlug", request.stageSlug);
    // Omitted when both buckets are selected — the same "no narrowing" request as before the filter shipped.
    if (routesKey) params.set("routes", routesKey);

    try {
      const result = await api<{ data: MondayShowcaseEvidence }>(
        `/reports/monday-showcase/evidence?${params.toString()}`
      );
      if (requestId === latestRequest.current) setData(result.data);
    } catch (err: unknown) {
      if (requestId !== latestRequest.current) return;
      setError(err instanceof Error ? err.message : "Failed to load the supporting records");
      setData(null);
    } finally {
      if (requestId === latestRequest.current) setLoading(false);
    }
  }, [request, mode, routesKey]);

  useEffect(() => {
    void fetchEvidence();
  }, [fetchEvidence]);

  return { data, loading, error, refetch: fetchEvidence };
}

// Reports Part 4 -- B·1 Rep 1:1 Pack. repId undefined lets the server default to the top rep.
export function useRepPack(repId: string | undefined, mode: WeekMode) {
  const [data, setData] = useState<RepPackData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    const requestId = ++latestRequest.current;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ mode });
    if (repId) params.set("repId", repId);
    api<{ data: RepPackData | null }>(`/reports/rep-pack?${params.toString()}`)
      .then((result) => {
        if (requestId === latestRequest.current) setData(result.data);
      })
      .catch((err: unknown) => {
        if (requestId !== latestRequest.current) return;
        setError(err instanceof Error ? err.message : "Failed to load the rep pack");
        setData(null);
      })
      .finally(() => {
        if (requestId === latestRequest.current) setLoading(false);
      });
  }, [repId, mode]);

  return { data, loading, error };
}

// Reports Part 4 -- A·3 At-Risk Watchlist. repId undefined = office-wide.
export function useAtRiskWatchlist(repId?: string) {
  const [data, setData] = useState<AtRiskWatchlist | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    const requestId = ++latestRequest.current;
    setLoading(true);
    setError(null);
    const qs = repId ? `?repId=${encodeURIComponent(repId)}` : "";
    api<{ data: AtRiskWatchlist }>(`/reports/at-risk${qs}`)
      .then((result) => {
        if (requestId === latestRequest.current) setData(result.data);
      })
      .catch((err: unknown) => {
        if (requestId !== latestRequest.current) return;
        setError(err instanceof Error ? err.message : "Failed to load the at-risk watchlist");
        setData(null);
      })
      .finally(() => {
        if (requestId === latestRequest.current) setLoading(false);
      });
  }, [repId]);

  return { data, loading, error };
}

// Reports by Region. from/to window the Won/Lost metrics; pipeline/forecast are snapshots. The monotonic
// request guard drops stale responses when the period toggle fires several fetches in quick succession.
export function useRegionReport(from?: string, to?: string) {
  const [data, setData] = useState<RegionReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  const fetchReport = useCallback(async () => {
    const requestId = ++latestRequest.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      const result = await api<{ data: RegionReportData }>(`/reports/region${qs ? `?${qs}` : ""}`);
      if (requestId !== latestRequest.current) return;
      setData(result.data);
    } catch (err: unknown) {
      if (requestId !== latestRequest.current) return;
      setError(err instanceof Error ? err.message : "Failed to load region report");
      setData(null);
    } finally {
      if (requestId === latestRequest.current) setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  return { data, loading, error, refetch: fetchReport };
}
