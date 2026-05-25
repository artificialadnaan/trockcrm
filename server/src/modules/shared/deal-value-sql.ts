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

export function positiveDealValueCandidateSql(value: unknown): SQL {
  return sql`CASE WHEN ${value} > 0 THEN ${value} END`;
}

function aliasedPositiveDealValueCandidateSql(alias: string, column: string): string {
  return `CASE WHEN ${alias}.${column} > 0 THEN ${alias}.${column} END`;
}

export function dealBestEstimateSql(table: DealValueTable): SQL {
  return sql`COALESCE(${positiveDealValueCandidateSql(table.bidBoardTotalSales ?? sql`NULL`)}, ${positiveDealValueCandidateSql(table.bidEstimate)}, ${positiveDealValueCandidateSql(table.ddEstimate)}, ${positiveDealValueCandidateSql(table.awardedAmount)}, 0)`;
}

export function dealAwardedAmountSql(table: DealValueTable): SQL {
  return sql`COALESCE(${positiveDealValueCandidateSql(table.awardedAmount)}, 0)`;
}

export function dealAwardedFirstWithFallbackSql(table: DealValueTable): SQL {
  return sql`COALESCE(${positiveDealValueCandidateSql(table.awardedAmount)}, ${positiveDealValueCandidateSql(table.bidBoardTotalSales ?? sql`NULL`)}, ${positiveDealValueCandidateSql(table.bidEstimate)}, ${positiveDealValueCandidateSql(table.ddEstimate)}, 0)`;
}

export function dealBestEstimateWithForecastSql(table: DealValueTable): SQL {
  return sql`COALESCE(${positiveDealValueCandidateSql(table.bidBoardTotalSales ?? sql`NULL`)}, ${positiveDealValueCandidateSql(table.bidEstimate)}, ${positiveDealValueCandidateSql(table.ddEstimate)}, ${positiveDealValueCandidateSql(table.forecastRevenue ?? sql`NULL`)}, ${positiveDealValueCandidateSql(table.awardedAmount)}, 0)`;
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

export function aliasedDealBestEstimateSql(alias: string): SQL {
  return sql.raw(
    `COALESCE(${aliasedPositiveDealValueCandidateSql(alias, "bid_board_total_sales")}, ${aliasedPositiveDealValueCandidateSql(alias, "bid_estimate")}, ${aliasedPositiveDealValueCandidateSql(alias, "dd_estimate")}, ${aliasedPositiveDealValueCandidateSql(alias, "awarded_amount")}, 0)`
  );
}

export function aliasedDealAwardedAmountSql(alias: string): SQL {
  return sql.raw(`COALESCE(${aliasedPositiveDealValueCandidateSql(alias, "awarded_amount")}, 0)`);
}

export function aliasedDealAwardedFirstWithFallbackSql(alias: string): SQL {
  return sql.raw(
    `COALESCE(${aliasedPositiveDealValueCandidateSql(alias, "awarded_amount")}, ${aliasedPositiveDealValueCandidateSql(alias, "bid_board_total_sales")}, ${aliasedPositiveDealValueCandidateSql(alias, "bid_estimate")}, ${aliasedPositiveDealValueCandidateSql(alias, "dd_estimate")}, 0)`
  );
}

export function aliasedDealBestEstimateWithForecastSql(alias: string): SQL {
  return sql.raw(
    `COALESCE(${aliasedPositiveDealValueCandidateSql(alias, "bid_board_total_sales")}, ${aliasedPositiveDealValueCandidateSql(alias, "bid_estimate")}, ${aliasedPositiveDealValueCandidateSql(alias, "dd_estimate")}, ${aliasedPositiveDealValueCandidateSql(alias, "forecast_revenue")}, ${aliasedPositiveDealValueCandidateSql(alias, "awarded_amount")}, 0)`
  );
}

export function aliasedForecastFirstDealValueSql(alias: string): SQL {
  return sql.raw(
    `COALESCE(${aliasedPositiveDealValueCandidateSql(alias, "forecast_revenue")}, ${aliasedPositiveDealValueCandidateSql(alias, "bid_board_total_sales")}, ${aliasedPositiveDealValueCandidateSql(alias, "bid_estimate")}, ${aliasedPositiveDealValueCandidateSql(alias, "dd_estimate")}, ${aliasedPositiveDealValueCandidateSql(alias, "awarded_amount")}, 0)`
  );
}

export function aliasedOpenPipelineForecastFirstDealValueSql(alias: string): SQL {
  return sql.raw(
    `COALESCE(${aliasedPositiveDealValueCandidateSql(alias, "forecast_revenue")}, ${aliasedPositiveDealValueCandidateSql(alias, "bid_estimate")}, ${aliasedPositiveDealValueCandidateSql(alias, "dd_estimate")}, 0)`
  );
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

export function reportableDealFilterSql(identifierPath?: string): SQL {
  return sql.raw(reportableDealSqlPredicate(identifierPath));
}

export function aliasedReportableDealFilterSql(alias: string): SQL {
  return reportableDealFilterSql(alias);
}

export function aliasedActiveDealCountFilterSql(alias: string): SQL {
  return aliasedReportableDealFilterSql(alias);
}
