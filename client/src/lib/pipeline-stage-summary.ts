import type { DealStagePageResponse } from "@/hooks/use-deals";
import type { LeadStagePageResponse } from "@/hooks/use-leads";

const QUALIFIED_PRESSURE_SLUGS = new Set([
  "pre_qual_value_assigned",
  "lead_go_no_go",
  "qualified_for_opportunity",
]);

export interface DealStageSummary {
  totalCount: number;
  totalValue: number;
  averageAgeDays: number;
}

export interface LeadStageSummary {
  totalCount: number;
  averageAgeDays: number;
  isQualifiedPressureStage: boolean;
  isOpportunityStage: boolean;
}

function averageDays(values: string[], now: Date) {
  if (values.length === 0) return 0;

  const total = values.reduce((sum, value) => {
    const entered = new Date(value);
    return sum + Math.floor((now.getTime() - entered.getTime()) / (1000 * 60 * 60 * 24));
  }, 0);

  return Math.round(total / values.length);
}

export function buildDealStageSummary(
  data: DealStagePageResponse | null,
  now = new Date()
): DealStageSummary {
  return {
    totalCount: data?.summary.count ?? 0,
    totalValue: data?.summary.totalValue ?? 0,
    averageAgeDays: averageDays((data?.rows ?? []).map((row) => row.stageEnteredAt), now),
  };
}

export function buildLeadStageSummary(
  data: LeadStagePageResponse | null,
  now = new Date()
): LeadStageSummary {
  const slug = data?.stage.slug ?? "";

  return {
    totalCount: data?.summary.count ?? 0,
    averageAgeDays: averageDays((data?.rows ?? []).map((row) => row.stageEnteredAt), now),
    isQualifiedPressureStage: QUALIFIED_PRESSURE_SLUGS.has(slug),
    isOpportunityStage: slug === "qualified_for_opportunity",
  };
}
