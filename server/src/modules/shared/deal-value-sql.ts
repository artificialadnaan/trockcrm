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

export function dealBestEstimateSql(table: DealValueTable): SQL {
  return sql`COALESCE(NULLIF(${table.bidBoardTotalSales ?? sql`NULL`}, 0), NULLIF(${table.bidEstimate}, 0), NULLIF(${table.ddEstimate}, 0), ${table.awardedAmount}, 0)`;
}

export function dealAwardedAmountSql(table: DealValueTable): SQL {
  return sql`COALESCE(${table.awardedAmount}, 0)`;
}

export function dealBestEstimateWithForecastSql(table: DealValueTable): SQL {
  return sql`COALESCE(NULLIF(${table.bidBoardTotalSales ?? sql`NULL`}, 0), NULLIF(${table.bidEstimate}, 0), NULLIF(${table.ddEstimate}, 0), NULLIF(${table.forecastRevenue ?? sql`NULL`}, 0), ${table.awardedAmount}, 0)`;
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
    `COALESCE(NULLIF(${alias}.bid_board_total_sales, 0), NULLIF(${alias}.bid_estimate, 0), NULLIF(${alias}.dd_estimate, 0), ${alias}.awarded_amount, 0)`
  );
}

export function aliasedDealAwardedAmountSql(alias: string): SQL {
  return sql.raw(`COALESCE(${alias}.awarded_amount, 0)`);
}

export function aliasedDealBestEstimateWithForecastSql(alias: string): SQL {
  return sql.raw(
    `COALESCE(NULLIF(${alias}.bid_board_total_sales, 0), NULLIF(${alias}.bid_estimate, 0), NULLIF(${alias}.dd_estimate, 0), NULLIF(${alias}.forecast_revenue, 0), ${alias}.awarded_amount, 0)`
  );
}

export function aliasedForecastFirstDealValueSql(alias: string): SQL {
  return sql.raw(
    `COALESCE(NULLIF(${alias}.forecast_revenue, 0), NULLIF(${alias}.bid_board_total_sales, 0), NULLIF(${alias}.bid_estimate, 0), NULLIF(${alias}.dd_estimate, 0), ${alias}.awarded_amount, 0)`
  );
}

export function aliasedOpenPipelineForecastFirstDealValueSql(alias: string): SQL {
  return sql.raw(`COALESCE(${alias}.forecast_revenue, ${alias}.bid_estimate, ${alias}.dd_estimate, 0)`);
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
