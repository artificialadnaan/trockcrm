import { sql, type SQL } from "drizzle-orm";
import { reportableDealSqlPredicate } from "@trock-crm/shared/types";

type DealValueTable = {
  onHold: unknown;
  awardedAmount: unknown;
  bidBoardTotalSales?: unknown;
  bidEstimate: unknown;
  ddEstimate: unknown;
  forecastRevenue?: unknown;
};

type DealValueColumn =
  | "forecast_revenue"
  | "bid_board_total_sales"
  | "bid_estimate"
  | "dd_estimate"
  | "awarded_amount";

const OPEN_CURRENT_VALUE_CHAIN = [
  "bid_board_total_sales",
  "bid_estimate",
  "dd_estimate",
  "awarded_amount",
] as const satisfies readonly DealValueColumn[];

const FORECAST_FIRST_VALUE_CHAIN = [
  "forecast_revenue",
  ...OPEN_CURRENT_VALUE_CHAIN,
] as const satisfies readonly DealValueColumn[];

const AWARDED_FIRST_VALUE_CHAIN = [
  "awarded_amount",
  "bid_board_total_sales",
  "bid_estimate",
  "dd_estimate",
] as const satisfies readonly DealValueColumn[];

export function positiveDealValueCandidateSql(value: unknown): SQL {
  return sql`CASE WHEN ${value} > 0 THEN ${value} END`;
}

function aliasedPositiveDealValueCandidateSql(alias: string, column: string): string {
  return `CASE WHEN ${alias}.${column} > 0 THEN ${alias}.${column} END`;
}

function tableColumnSql(table: DealValueTable, column: DealValueColumn): unknown {
  switch (column) {
    case "forecast_revenue":
      return table.forecastRevenue ?? sql`NULL`;
    case "bid_board_total_sales":
      return table.bidBoardTotalSales ?? sql`NULL`;
    case "bid_estimate":
      return table.bidEstimate;
    case "dd_estimate":
      return table.ddEstimate;
    case "awarded_amount":
      return table.awardedAmount;
  }
}

function dealValueChainSql(table: DealValueTable, columns: readonly DealValueColumn[]): SQL {
  return sql`COALESCE(${sql.join(
    columns.map((column) => positiveDealValueCandidateSql(tableColumnSql(table, column))),
    sql`, `
  )}, 0)`;
}

function aliasedDealValueChainSql(alias: string, columns: readonly DealValueColumn[]): SQL {
  return sql.raw(
    `COALESCE(${columns
      .map((column) => aliasedPositiveDealValueCandidateSql(alias, column))
      .join(", ")}, 0)`
  );
}

export function dealBestEstimateSql(table: DealValueTable): SQL {
  return dealValueChainSql(table, OPEN_CURRENT_VALUE_CHAIN);
}

export function dealAwardedAmountSql(table: DealValueTable): SQL {
  return sql`COALESCE(${positiveDealValueCandidateSql(table.awardedAmount)}, 0)`;
}

export function dealAwardedFirstWithFallbackSql(table: DealValueTable): SQL {
  return dealValueChainSql(table, AWARDED_FIRST_VALUE_CHAIN);
}

export function dealBestEstimateWithForecastSql(table: DealValueTable): SQL {
  return dealValueChainSql(table, FORECAST_FIRST_VALUE_CHAIN);
}

export function effectiveDealValueSql(table: DealValueTable, rawValueSql: SQL = dealBestEstimateSql(table)): SQL {
  return sql`CASE WHEN COALESCE(${table.onHold}, false) THEN 0 ELSE COALESCE(${rawValueSql}, 0) END`;
}

export function effectiveAwardedDealValueSql(
  table: DealValueTable,
  rawValueSql: SQL = dealAwardedAmountSql(table)
): SQL {
  return effectiveDealValueSql(table, rawValueSql);
}

export function effectiveWonDealValueSql(table: DealValueTable): SQL {
  return effectiveDealValueSql(table, dealAwardedFirstWithFallbackSql(table));
}

export function aliasedDealBestEstimateSql(alias: string): SQL {
  return aliasedDealValueChainSql(alias, OPEN_CURRENT_VALUE_CHAIN);
}

export function aliasedDealAwardedAmountSql(alias: string): SQL {
  return sql.raw(`COALESCE(${aliasedPositiveDealValueCandidateSql(alias, "awarded_amount")}, 0)`);
}

export function aliasedDealAwardedFirstWithFallbackSql(alias: string): SQL {
  return aliasedDealValueChainSql(alias, AWARDED_FIRST_VALUE_CHAIN);
}

export function aliasedDealBestEstimateWithForecastSql(alias: string): SQL {
  return aliasedDealValueChainSql(alias, FORECAST_FIRST_VALUE_CHAIN);
}

export function aliasedForecastFirstDealValueSql(alias: string): SQL {
  return aliasedDealValueChainSql(alias, FORECAST_FIRST_VALUE_CHAIN);
}

export function aliasedOpenPipelineForecastFirstDealValueSql(alias: string): SQL {
  return aliasedDealValueChainSql(alias, FORECAST_FIRST_VALUE_CHAIN);
}

export function aliasedEffectiveDealValueSql(
  alias: string,
  rawValueSql: SQL = aliasedDealBestEstimateSql(alias)
): SQL {
  return sql`CASE WHEN COALESCE(${sql.raw(`${alias}.on_hold`)}, false) THEN 0 ELSE COALESCE(${rawValueSql}, 0) END`;
}

export function aliasedEffectiveAwardedDealValueSql(
  alias: string,
  rawValueSql: SQL = aliasedDealAwardedAmountSql(alias)
): SQL {
  return aliasedEffectiveDealValueSql(alias, rawValueSql);
}

export function aliasedEffectiveWonDealValueSql(alias: string): SQL {
  return aliasedEffectiveDealValueSql(alias, aliasedDealAwardedFirstWithFallbackSql(alias));
}

export function reportableDealFilterSql(identifierPath?: string): SQL {
  return sql.raw(reportableDealSqlPredicate(identifierPath));
}

export function aliasedReportableDealFilterSql(alias: string): SQL {
  return reportableDealFilterSql(alias);
}

export function aliasedActiveDealCountFilterSql(alias: string): SQL {
  return aliasedReportableDealFilterSql(alias);
}
