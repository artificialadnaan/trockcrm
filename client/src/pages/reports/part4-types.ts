// Client mirror of the Reports Part 4 server payloads (rep-pack-service.ts, at-risk-service.ts).
import type { RepShowcaseRow, ShowcaseWeek, ShowcasePeriod } from "./monday-showcase/types";

export interface RepPackData {
  period: ShowcasePeriod;
  rep: RepShowcaseRow;
  trend: ShowcaseWeek[];
  allReps: Array<{ repId: string; repName: string }>;
}

export type AtRiskReason = "no_date" | "stale_dated";

export interface AtRiskRecord {
  id: string;
  dealNumber: string | null;
  name: string;
  repId: string | null;
  repName: string;
  stageLabel: string;
  value: number;
  expectedCloseDate: string | null;
  reason: AtRiskReason;
  daysInStage: number | null;
}

export interface AtRiskSummary {
  count: number;
  valueAtRisk: number;
}

export interface AtRiskWatchlist {
  scope: { kind: "office" } | { kind: "rep"; repId: string | null; repName: string };
  summary: AtRiskSummary;
  byReason: Record<AtRiskReason, AtRiskSummary>;
  records: AtRiskRecord[];
}
