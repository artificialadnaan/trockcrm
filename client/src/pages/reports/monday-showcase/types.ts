// Client mirror of the server MondayShowcaseData payload (server/src/modules/reports/
// monday-showcase-service.ts). The 8 variants all render slices of ONE instance of this, so they
// reconcile by construction -- keep this in lockstep with the server contract.

import type { WeekMode } from "../week-mode";

export type DepartmentKey = "estimating" | "sent" | "won" | "collected";
export type ProjectionBand = "0_30" | "31_60" | "61_90" | "beyond_90";

export interface ValueWithBasis {
  amount: number;
  basisLabel: string;
}

export interface DepartmentMetric {
  key: DepartmentKey;
  label: string;
  count: number | null;
  value: ValueWithBasis | null;
  deltaCountWoW: number | null;
  sparkline: number[];
  deferred: boolean;
}

export interface ProjectionBandCell {
  band: ProjectionBand;
  count: number;
  value: number;
}

export interface ProjectionLadder {
  bands: ProjectionBandCell[];
  // n = future-dated open deals; m = ALL open deals. The undated complement is the M − N count, and
  // undatedValue is that complement's open best-estimate $ — together they back the B4 "No future close
  // date" card so office M == Σ band counts (= n) + (m − n).
  coverage: { n: number; m: number; undatedValue: number };
  /** Non-future-dated deals split into stale past dates and never-dated records. */
  blindSpots?: { stale: { count: number; value: number }; noDate: { count: number; value: number } };
  coverageCaption: string;
}

export interface LeadStatusCell {
  stageLabel: string;
  count: number;
}

export interface RepShowcaseRow {
  repId: string | null;
  repName: string;
  closed: { count: number; value: ValueWithBasis };
  projection: ProjectionLadder;
  sentThisWeek: { count: number; value: ValueWithBasis };
  leadStatus: LeadStatusCell[];
}

export interface ExecHeroMetric {
  count: number;
  value: ValueWithBasis;
}

export interface ExecHero {
  won: ExecHeroMetric;
  sent: ExecHeroMetric;
  estimated: ExecHeroMetric;
}

export interface ShowcaseWeek {
  weekStart: string;
  estimating: number;
  sent: number;
  won: number;
  spikeExcluded: boolean;
}

export interface ShowcasePeriod {
  from: string;
  to: string;
  mode: WeekMode;
  label: string;
}

/** The two buckets of the page-local Service / Other split. Mirrors WORKFLOW_ROUTE_BUCKETS on the server
 *  (server/src/modules/shared/deal-value-sql.ts) — same meaning as the deals dashboard's Service /
 *  Non-service At Risk cards: "service" is workflow_route = 'service', "other" is everything else. */
export const ROUTE_BUCKETS = ["service", "other"] as const;
export type RouteBucket = (typeof ROUTE_BUCKETS)[number];

export const ROUTE_BUCKET_LABEL: Record<RouteBucket, string> = {
  service: "Service",
  other: "Other",
};

/** What the server says the route selection did to this payload — including which figures it could NOT
 *  reach (`unfilterable`), so the UI marks those in place instead of letting an unfiltered number pass
 *  for a filtered one. `active` is true only when the selection actually narrows (exactly one bucket). */
export interface ShowcaseRouteFilter {
  selected: RouteBucket[];
  active: boolean;
  unfilterable: string[];
}

export interface EstimatingMetric {
  count: number;
  ddValue: number;
  missingDdCount: number;
}

export interface CurrentEstimatingProject {
  id: string;
  name: string;
  dealNumber: string | null;
  projectNumber: string | null;
  stageLabel: string;
  ddEstimate: number | null;
  daysInStage: number | null;
}

export interface RfpInitiatedProject {
  id: string;
  name: string;
  dealNumber: string | null;
  projectNumber: string | null;
  requestedAt: string;
  currentRfpStatus: string | null;
  assignedRepId: string | null;
  assignedRepName: string;
  ddEstimate: number | null;
}

export interface EstimateSentProject {
  id: string;
  name: string;
  dealNumber: string | null;
  projectNumber: string | null;
  sentAt: string;
  ddEstimate: number | null;
  latestBidBoardTotalSales: number | null;
  varianceAmount: number | null;
  variancePercent: number | null;
  marginPercent: number | null;
}

export interface RfpBySalesperson {
  repId: string | null;
  repName: string;
  count: number;
  ddValue: number;
  missingDdCount: number;
}

export interface EstimateSentComparison {
  dollarComparableCount: number;
  percentageComparableCount: number;
  dollarComparableDdValue: number;
  dollarComparableLatestBidBoardTotalSales: number;
  varianceAmount: number;
  percentageComparableDdValue: number;
  percentageComparableLatestBidBoardTotalSales: number;
  variancePercent: number | null;
}

export interface EstimatingReport {
  currentAsOf: string;
  currentEstimating: EstimatingMetric & { projects: CurrentEstimatingProject[] };
  newRfps: EstimatingMetric & { projects: RfpInitiatedProject[] };
  rfpBySalesperson: RfpBySalesperson[];
  estimatesSent: {
    count: number;
    latestBidBoardTotalSales: number;
    projects: EstimateSentProject[];
    comparison: EstimateSentComparison;
    margin: { projectCount: number; latestBidBoardTotalSales: number; blendedPercent: number | null };
    missingSentValueCount: number;
    missingMarginCount: number;
  };
}

/** The default (both buckets) descriptor: nothing narrowed, nothing to disclaim — what the server returns
 *  when no ?routes is sent. Handy as the "unchanged report" baseline in fixtures. */
export const UNFILTERED_ROUTE_FILTER: ShowcaseRouteFilter = {
  selected: [...ROUTE_BUCKETS],
  active: false,
  unfilterable: [],
};

export interface MondayShowcaseData {
  period: ShowcasePeriod;
  departments: DepartmentMetric[];
  execHero: ExecHero;
  reps: RepShowcaseRow[];
  officeProjection: ProjectionLadder;
  weeklyTrend: ShowcaseWeek[];
  valueBases: Record<"won_awarded_first" | "open_best_estimate", string>;
  estimatingReport: EstimatingReport;
  routeFilter: ShowcaseRouteFilter;
  notes: string[];
}

// ===================== Reports Part 3: drill-to-evidence =====================
// Client mirror of the server MondayShowcaseEvidence payload (monday-showcase-service.ts). Every showcase
// number is clickable; the drawer shows these records and their total EQUALS the clicked number.

export type EvidenceMetric = "won" | "sent" | "estimated" | "projection" | "pipeline" | "leads" | "undated" | "no_date" | "stale";

export interface EvidenceRecord {
  id: string;
  dealNumber: string | null;
  projectNumber: string | null;
  name: string;
  /** `deals.is_change_order` — the AUTHORITY for the change-order display relabel; `false` for leads. */
  dealIsChangeOrder?: boolean | null;
  repId: string | null;
  repName: string;
  stageLabel: string;
  value: number | null;
  cohortDate: string | null;
  companyName: string | null;
  region: string | null;
  dealType: string | null;
  daysInStage: number | null;
  /** the deal's stored win probability (0-100), shown as-is. null = unknown (NOT zero); always null for leads. */
  winProbability: number | null;
}

export interface EvidenceTotal {
  count: number;
  value: number | null;
  basisLabel: string | null;
}

export type EvidenceScope =
  | { kind: "office" }
  | { kind: "rep"; repId: string | null; repName: string }
  | { kind: "region"; regionName: string };

/** The route selection AS APPLIED TO THIS DRILL. `applied` is false for metrics whose source table has no
 *  workflow route (leads) even when `active` is true — the drawer says so rather than presenting an
 *  office-wide list under a filtered-looking header. */
export interface EvidenceRouteFilter {
  selected: RouteBucket[];
  active: boolean;
  applied: boolean;
}

/** The default (both buckets) drill descriptor — no narrowing, so nothing to apply and nothing to disclaim. */
export const UNFILTERED_EVIDENCE_ROUTE_FILTER: EvidenceRouteFilter = {
  selected: [...ROUTE_BUCKETS],
  active: false,
  applied: false,
};

export interface MondayShowcaseEvidence {
  metric: EvidenceMetric;
  metricLabel: string;
  dateAxisLabel: string;
  period: ShowcasePeriod;
  scope: EvidenceScope;
  band: ProjectionBand | null;
  leadStage: string | null;
  routeFilter: EvidenceRouteFilter;
  total: EvidenceTotal;
  records: EvidenceRecord[];
}

/**
 * What a clicked number asks the drawer to open. `repId` undefined = office-wide; `null` = the Unassigned
 * bucket (sent to the server as the `__unassigned__` sentinel). `title`/`subtitle` are the human heading.
 */
export interface EvidenceRequest {
  metric: EvidenceMetric;
  repId?: string | null;
  band?: ProjectionBand;
  leadStage?: string;
  /** Reports-by-Region drill: the clicked row's DISPLAY name (the report's GROUP-BY key; "Unassigned" =
   *  that bucket). Carries the section's exact period so windowed metrics reconcile, and an optional stage
   *  slug for a heatmap cell. These must be the SAME values the displayed section number was computed with. */
  regionName?: string;
  from?: string;
  to?: string;
  stageSlug?: string;
  title: string;
  subtitle?: string;
}

export const PROJECTION_BAND_LABEL: Record<ProjectionBand, string> = {
  "0_30": "0–30d",
  "31_60": "31–60d",
  "61_90": "61–90d",
  beyond_90: "90d+",
};

export const SHOWCASE_VARIANTS = [
  // Exec is the consolidated survivor of the old A1 (Throughput Funnel) + A2 (Department Scoreboard) +
  // Hero (One-Glance): Hero's big-tile presentation carrying A2's data richness (all 4 departments incl.
  // Collected). The 3 non-deferred departments each carry a WoW delta chip + 8-week sparkline; Collected
  // is a deferred placeholder (no chip/sparkline) until a finance source is wired. A3 stays as a distinct
  // momentum view.
  { key: "HERO", group: "Exec", label: "Exec · One Glance" },
  { key: "A1", group: "Report A", label: "A1 · Estimating Report" },
  { key: "A3", group: "Report A", label: "A3 · Momentum Lanes" },
  // B1 (Roll-Call Scorecards) was removed; its per-rep Sent + lead-status content lives on in B2/B3.
  { key: "B2", group: "Report B", label: "B2 · Leaderboard" },
  { key: "B3", group: "Report B", label: "B3 · Rep Load Lane" },
  { key: "B4", group: "Report B", label: "B4 · Forecast Ladder" },
] as const;

export type ShowcaseVariantKey = (typeof SHOWCASE_VARIANTS)[number]["key"];
