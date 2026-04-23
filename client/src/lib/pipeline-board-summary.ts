import type { DealBoardResponse } from "@/hooks/use-deals";
import type { LeadBoardResponse } from "@/hooks/use-leads";

const QUALIFIED_PRESSURE_SLUGS = new Set([
  "pre_qual_value_assigned",
  "lead_go_no_go",
  "qualified_for_opportunity",
]);

export interface DealBoardSummary {
  totalCount: number;
  liveStageCount: number;
  totalValue: number;
  averageAgeDays: number;
}

export interface LeadBoardSummary {
  totalCount: number;
  liveStageCount: number;
  averageAgeDays: number;
  qualifiedPressureCount: number;
  opportunityCount: number;
}

function averageDays(values: string[], now: Date) {
  if (values.length === 0) return 0;

  const total = values.reduce((sum, value) => {
    const entered = new Date(value);
    return sum + Math.floor((now.getTime() - entered.getTime()) / (1000 * 60 * 60 * 24));
  }, 0);

  return Math.round(total / values.length);
}

export function buildDealBoardSummary(board: DealBoardResponse | null, now = new Date()): DealBoardSummary {
  const columns = board?.columns ?? [];
  const enteredAt = columns.flatMap((column) => column.cards.map((card) => card.stageEnteredAt));

  return {
    totalCount: columns.reduce((sum, column) => sum + column.count, 0),
    liveStageCount: columns.filter((column) => column.count > 0).length,
    totalValue: columns.reduce((sum, column) => sum + (column.totalValue ?? 0), 0),
    averageAgeDays: averageDays(enteredAt, now),
  };
}

export function buildLeadBoardSummary(board: LeadBoardResponse | null, now = new Date()): LeadBoardSummary {
  const columns = board?.columns ?? [];
  const enteredAt = columns.flatMap((column) => column.cards.map((card) => card.stageEnteredAt));

  return {
    totalCount: columns.reduce((sum, column) => sum + column.count, 0),
    liveStageCount: columns.filter((column) => column.count > 0).length,
    averageAgeDays: averageDays(enteredAt, now),
    qualifiedPressureCount: columns
      .filter((column) => QUALIFIED_PRESSURE_SLUGS.has(column.stage.slug))
      .reduce((sum, column) => sum + column.count, 0),
    opportunityCount: columns
      .filter((column) => column.stage.slug === "qualified_for_opportunity")
      .reduce((sum, column) => sum + column.count, 0),
  };
}
