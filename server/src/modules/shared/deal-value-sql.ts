import { sql, type SQL } from "drizzle-orm";

type DealValueTable = {
  onHold: unknown;
  awardedAmount: unknown;
  bidEstimate: unknown;
  ddEstimate: unknown;
  forecastRevenue?: unknown;
};

export function dealBestEstimateSql(table: DealValueTable): SQL {
  return sql`COALESCE(${table.awardedAmount}, ${table.bidEstimate}, ${table.ddEstimate}, 0)`;
}

export function dealBestEstimateWithForecastSql(table: DealValueTable): SQL {
  return sql`COALESCE(${table.awardedAmount}, ${table.bidEstimate}, ${table.ddEstimate}, ${table.forecastRevenue ?? null}, 0)`;
}

export function effectiveDealValueSql(table: DealValueTable, rawValueSql: SQL = dealBestEstimateSql(table)): SQL {
  return sql`CASE WHEN COALESCE(${table.onHold}, false) THEN 0 ELSE COALESCE(${rawValueSql}, 0) END`;
}

export function aliasedDealBestEstimateSql(alias: string): SQL {
  return sql.raw(`COALESCE(${alias}.awarded_amount, ${alias}.bid_estimate, ${alias}.dd_estimate, 0)`);
}

export function aliasedDealBestEstimateWithForecastSql(alias: string): SQL {
  return sql.raw(
    `COALESCE(${alias}.awarded_amount, ${alias}.bid_estimate, ${alias}.dd_estimate, ${alias}.forecast_revenue, 0)`
  );
}

export function aliasedEffectiveDealValueSql(
  alias: string,
  rawValueSql: SQL = aliasedDealBestEstimateSql(alias)
): SQL {
  return sql`CASE WHEN COALESCE(${sql.raw(`${alias}.on_hold`)}, false) THEN 0 ELSE COALESCE(${rawValueSql}, 0) END`;
}

export function aliasedActiveDealCountFilterSql(alias: string): SQL {
  return sql`COALESCE(${sql.raw(`${alias}.on_hold`)}, false) = false`;
}
