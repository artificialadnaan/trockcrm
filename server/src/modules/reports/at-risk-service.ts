// Reports Part 4 -- A·3 At-Risk & Value-at-Stake Watchlist. The forecast's BLIND SPOTS: open, active,
// non-terminal, reportable deals whose expected_close_date is missing or already past -- i.e. exactly the
// (M − N) the projection coverage caption warns about. Built on the SAME open-deal scope as
// buildProjectionCoverageSql (so the watchlist count reconciles to M − N) + F2's future-dated predicate
// (negated) + F3 best-estimate $. Each row IS its own evidence; the summary equals the listed rows.

import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { aliasedReportableDealFilterSql } from "../shared/deal-value-sql.js";
import { dealValueSqlForBasis, futureDatedCloseDatePredicateSql } from "./foundations.js";

const { deals, pipelineStageConfig, users } = schema;
type TenantDb = NodePgDatabase<typeof schema>;

const BUSINESS_TODAY_SQL = "(now() AT TIME ZONE 'America/Chicago')::date";
const openValueSql = (alias: string) => dealValueSqlForBasis(alias, "open_best_estimate");

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}
const num = (v: unknown): number => Number(v ?? 0);

/** Optional per-rep narrowing: undefined = office; null = the Unassigned bucket; string = a rep UUID. */
function repScopeSql(alias: string, repId?: string | null): SQL {
  if (repId === undefined) return sql``;
  if (repId === null) return sql` AND ${sql.raw(alias)}.assigned_rep_id IS NULL`;
  return sql` AND ${sql.raw(alias)}.assigned_rep_id = ${repId}::uuid`;
}

export type AtRiskReason = "no_date" | "stale_dated";

export interface AtRiskRecord {
  id: string;
  dealNumber: string | null;
  name: string;
  repId: string | null;
  repName: string;
  stageLabel: string;
  /** best-estimate $ at risk (F3). */
  value: number;
  /** the stale expected close date, or null when the deal has no maintained date. */
  expectedCloseDate: string | null;
  reason: AtRiskReason;
  daysInStage: number | null;
}

/**
 * Open deals that are NOT future-dated -- the exact complement of the projection's N within the same M
 * scope. Same FROM/WHERE as buildProjectionCoverageSql, plus `NOT (future-dated)`, so COUNT(rows) === M − N.
 */
export function buildAtRiskDealsSql(repId?: string | null): SQL {
  return sql`
    SELECT d.id AS id,
           d.deal_number AS deal_number,
           d.name AS name,
           d.assigned_rep_id AS rep_id,
           COALESCE(u.display_name, '') AS rep_name,
           COALESCE(psc.name, '') AS stage_label,
           COALESCE(${openValueSql("d")}, 0)::numeric AS value,
           d.expected_close_date AS expected_close_date,
           CASE WHEN d.expected_close_date IS NULL THEN 'no_date' ELSE 'stale_dated' END AS reason,
           (${sql.raw(BUSINESS_TODAY_SQL)} - d.stage_entered_at::date)::int AS days_in_stage
    FROM ${deals} d
    JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
    LEFT JOIN ${users} u ON u.id = d.assigned_rep_id
    WHERE COALESCE(d.is_test_data, false) = false
      AND ${aliasedReportableDealFilterSql("d")}
      AND d.is_active = true
      AND psc.is_terminal = false
      AND NOT (${futureDatedCloseDatePredicateSql("d.expected_close_date")})${repScopeSql("d", repId)}
    ORDER BY value DESC, days_in_stage DESC NULLS LAST
  `;
}

export interface AtRiskSummary {
  count: number;
  valueAtRisk: number;
}

export interface AtRiskWatchlist {
  scope: { kind: "office" } | { kind: "rep"; repId: string | null; repName: string };
  summary: AtRiskSummary;
  /** the two honest reasons a deal is a blind spot. */
  byReason: Record<AtRiskReason, AtRiskSummary>;
  records: AtRiskRecord[];
}

interface AtRiskRow {
  id: string;
  deal_number: string | null;
  name: string;
  rep_id: string | null;
  rep_name: string;
  stage_label: string;
  value: unknown;
  expected_close_date: unknown;
  reason: AtRiskReason;
  days_in_stage: unknown;
}

export interface AtRiskOptions {
  /** undefined = office-wide; null = Unassigned; string = a rep UUID. */
  repId?: string | null;
}

export async function getAtRiskWatchlist(tenantDb: TenantDb, options: AtRiskOptions = {}): Promise<AtRiskWatchlist> {
  const { repId } = options;
  const rows = rowsFromExecute<AtRiskRow>(await tenantDb.execute(buildAtRiskDealsSql(repId)));

  const records: AtRiskRecord[] = rows.map((r) => ({
    id: String(r.id),
    dealNumber: r.deal_number == null ? null : String(r.deal_number),
    name: r.name,
    repId: r.rep_id == null ? null : String(r.rep_id),
    repName: r.rep_name || (r.rep_id ? "Unknown rep" : "Unassigned"),
    stageLabel: r.stage_label,
    value: num(r.value),
    expectedCloseDate: r.expected_close_date == null ? null : String(r.expected_close_date).slice(0, 10),
    reason: r.reason,
    daysInStage: r.days_in_stage == null ? null : num(r.days_in_stage),
  }));

  const blank = (): AtRiskSummary => ({ count: 0, valueAtRisk: 0 });
  const byReason: Record<AtRiskReason, AtRiskSummary> = { no_date: blank(), stale_dated: blank() };
  const summary = blank();
  for (const rec of records) {
    summary.count += 1;
    summary.valueAtRisk += rec.value;
    byReason[rec.reason].count += 1;
    byReason[rec.reason].valueAtRisk += rec.value;
  }

  let scope: AtRiskWatchlist["scope"];
  if (repId === undefined) {
    scope = { kind: "office" };
  } else {
    const repName = records.find((r) => r.repId === (repId ?? null))?.repName ?? (await resolveRepName(tenantDb, repId));
    scope = { kind: "rep", repId: repId ?? null, repName };
  }

  return { scope, summary, byReason, records };
}

async function resolveRepName(tenantDb: TenantDb, repId: string | null): Promise<string> {
  if (repId == null) return "Unassigned";
  const rows = rowsFromExecute<{ name: string }>(
    await tenantDb.execute(sql`SELECT ${users.displayName} AS name FROM ${users} WHERE ${users.id} = ${repId}::uuid`)
  );
  return rows[0]?.name ?? "Unknown rep";
}
