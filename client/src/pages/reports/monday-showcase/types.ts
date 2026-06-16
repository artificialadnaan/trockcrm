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
  coverage: { n: number; m: number };
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

export interface MondayShowcaseData {
  period: ShowcasePeriod;
  departments: DepartmentMetric[];
  execHero: ExecHero;
  reps: RepShowcaseRow[];
  officeProjection: ProjectionLadder;
  weeklyTrend: ShowcaseWeek[];
  valueBases: Record<"won_awarded_first" | "open_best_estimate", string>;
  notes: string[];
}

// ===================== Reports Part 3: drill-to-evidence =====================
// Client mirror of the server MondayShowcaseEvidence payload (monday-showcase-service.ts). Every showcase
// number is clickable; the drawer shows these records and their total EQUALS the clicked number.

export type EvidenceMetric = "won" | "sent" | "estimated" | "projection" | "pipeline" | "leads";

export interface EvidenceRecord {
  id: string;
  dealNumber: string | null;
  name: string;
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

export interface MondayShowcaseEvidence {
  metric: EvidenceMetric;
  metricLabel: string;
  dateAxisLabel: string;
  period: ShowcasePeriod;
  scope: EvidenceScope;
  band: ProjectionBand | null;
  leadStage: string | null;
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
  { key: "A1", group: "Report A", label: "A1 · Throughput Funnel" },
  { key: "A2", group: "Report A", label: "A2 · Department Scoreboard" },
  { key: "A3", group: "Report A", label: "A3 · Momentum Lanes" },
  { key: "HERO", group: "Exec", label: "Exec · One-Glance Hero" },
  { key: "B1", group: "Report B", label: "B1 · Roll-Call Scorecards" },
  { key: "B2", group: "Report B", label: "B2 · Leaderboard" },
  { key: "B3", group: "Report B", label: "B3 · Rep Load Lane" },
  { key: "B4", group: "Report B", label: "B4 · Forecast Ladder" },
] as const;

export type ShowcaseVariantKey = (typeof SHOWCASE_VARIANTS)[number]["key"];
