import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { getDealAtRiskResult, type UserRole, type WorkflowRoute } from "@trock-crm/shared/types";
import { buildOfficeMatcher } from "./office-filter.js";
import {
  aliasedActiveDealCountFilterSql,
  aliasedEffectiveDealValueSql,
  aliasedEffectiveWonDealValueSql,
  aliasedForecastFirstDealValueSql,
  aliasedWonHsClosedWonDateSql,
} from "../shared/deal-value-sql.js";
import { aliasedHasUsableWonDateSql } from "../deals/service.js";
import { LOST_STAGE_SLUGS, WON_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";

type TenantDb = NodePgDatabase<typeof schema>;
type ExecuteRows = { rows: unknown[] } | unknown[];

const REPORT_CACHE_TTL_MS = 5 * 60 * 1000;
const COMMIT_STAGE_SLUGS = ["contract", "contract_signed", "service_contract_signed", "estimate_sent_to_client", "service_estimate_sent_to_client"] as const;
const BEST_CASE_STAGE_SLUGS = ["estimating", "estimate_in_progress", "service_estimating", "estimate_under_review", "service_estimate_under_review"] as const;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const reportCache = new Map<string, CacheEntry<unknown>>();

function rowsFromExecute<T>(result: ExecuteRows): T[] {
  return (Array.isArray(result) ? result : result.rows) as T[];
}

function numberValue(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

function round(value: number, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function defaultDateRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 90);
  return { dateFrom: dateOnly(from), dateTo: dateOnly(to) };
}

function sqlStringList(values: readonly string[]) {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

function titleCase(value: string | null | undefined) {
  return (value || "Other").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

type DealScopeAlias = "d";
type UserScopeAlias = "u";

export interface PerformanceReportFilters {
  dateFrom: string;
  dateTo: string;
  office?: string;
  ownerIds: string[];
  ownerNames: string[];
}

export function normalizePerformanceReportFilters(input: Record<string, unknown> = {}): PerformanceReportFilters {
  const defaults = defaultDateRange();
  const dateFrom = typeof input.dateFrom === "string" && input.dateFrom.trim() ? input.dateFrom.trim() : defaults.dateFrom;
  const dateTo = typeof input.dateTo === "string" && input.dateTo.trim() ? input.dateTo.trim() : defaults.dateTo;
  const office = typeof input.office === "string" ? input.office.trim() : "";
  const ownerValue = Array.isArray(input.ownerNames)
    ? input.ownerNames.join(",")
    : typeof input.ownerNames === "string"
      ? input.ownerNames
      : "";
  const ownerIdValue = Array.isArray(input.ownerIds)
    ? input.ownerIds.join(",")
    : typeof input.ownerIds === "string"
      ? input.ownerIds
      : "";

  return {
    dateFrom,
    dateTo,
    office: office && office !== "all" ? office : undefined,
    ownerIds: ownerIdValue.split(",").map((value) => value.trim()).filter(Boolean),
    ownerNames: ownerValue.split(",").map((value) => value.trim()).filter(Boolean),
  };
}

export function resolveRepActivityScope(user: { role: UserRole; userId: string; displayName?: string | null }, ownerIds: string[]) {
  return user.role === "rep" ? [user.userId] : ownerIds;
}

function cacheKey(reportName: string, tenantKey: string, scopeKey: string, filters: PerformanceReportFilters) {
  return JSON.stringify({ reportName, tenantKey, scopeKey, filters });
}

async function withReportCache<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cached = reportCache.get(key) as CacheEntry<T> | undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) reportCache.delete(key);
  const value = await load();
  reportCache.set(key, { value, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
  return value;
}

function dealScopeFull(filters: PerformanceReportFilters, alias: DealScopeAlias = "d", options: { requireActive?: boolean; includeArchivedWinsMarker?: boolean } = {}) {
  const clauses = [];
  if (options.includeArchivedWinsMarker) clauses.push(sql.raw("/* include_archived_wins */ true"));
  if (options.requireActive !== false) clauses.push(sql.raw(`${alias}.is_active = true`));
  clauses.push(sql.raw(`COALESCE(${alias}.is_test_data, false) = false`));
  clauses.push(aliasedActiveDealCountFilterSql(alias));
  const officeClause = buildOfficeMatcher(filters.office, {
    officeId: sql`o.id`,
    officeSlug: sql`o.slug`,
    officeName: sql`o.name`,
    dealOfficeCode: sql.raw(`${alias}.office_code`),
  });
  if (officeClause) clauses.push(officeClause);
  if (filters.ownerIds.length > 0) clauses.push(sql`u.id IN (${sqlStringList(filters.ownerIds)})`);
  return sql.join(clauses, sql` AND `);
}

function buildDealScopeSql(filters: PerformanceReportFilters, alias: DealScopeAlias = "d") {
  return dealScopeFull(filters, alias);
}

function buildClosedDealScopeSql(filters: PerformanceReportFilters, alias: DealScopeAlias = "d") {
  return dealScopeFull(filters, alias, { requireActive: false });
}

function buildArchivedWonDealScopeSql(filters: PerformanceReportFilters, alias: DealScopeAlias = "d") {
  return dealScopeFull(filters, alias, { requireActive: false, includeArchivedWinsMarker: true });
}

function buildResponsibleUserScopeSql(filters: PerformanceReportFilters, alias: UserScopeAlias = "u") {
  const clauses = [sql`COALESCE(${sql.raw(alias)}.is_active, true) = true`];
  const officeClause = buildOfficeMatcher(filters.office, {
    officeId: sql`o.id`,
    officeSlug: sql`o.slug`,
    officeName: sql`o.name`,
  });
  if (officeClause) clauses.push(officeClause);
  if (filters.ownerIds.length > 0) clauses.push(sql`${sql.raw(alias)}.id IN (${sqlStringList(filters.ownerIds)})`);
  return sql.join(clauses, sql` AND `);
}

function buildActivityScopeSql(filters: PerformanceReportFilters, ownerIds = filters.ownerIds) {
  const clauses = [
    sql`a.occurred_at >= ${filters.dateFrom}::date`,
    sql`a.occurred_at < (${filters.dateTo}::date + INTERVAL '1 day')`,
  ];
  const officeClause = buildOfficeMatcher(filters.office, {
    officeId: sql`o.id`,
    officeSlug: sql`o.slug`,
    officeName: sql`o.name`,
  });
  if (officeClause) clauses.push(officeClause);
  if (ownerIds.length > 0) clauses.push(sql`u.id IN (${sqlStringList(ownerIds)})`);
  return sql.join(clauses, sql` AND `);
}

// Terminal-outcome period window. WON-stage deals are windowed by the canonical
// app-owned column deals.won_closed_date — mirroring the dashboard getWonCloseSummary
// predicate byte-for-byte (IS NOT NULL guard + >= from::date + <= to::date) so every
// Won count/value this helper scopes reconciles to the protected 191 / $9,778,045.90
// card by construction. The old COALESCE(contract_signed_at, actual_close_date AT TIME
// ZONE 'UTC', updated_at) tail counted touched-in-period (updated_at) and reseed-
// contaminated (actual_close_date) deals as won-in-period.
//
// The non-WON (lost/open) branch is INTENTIONALLY left on the legacy window: this
// predicate also scopes the win-rate DENOMINATOR cohort (won + lost) in the director/
// rep/office CTEs, and migrating the Lost side to lost_at is a separate Lost-unification
// pass outside this Won sweep. Keeping it byte-identical means the lost-side denominator
// is unchanged — only the WON numerator/count/value move to the canonical basis. (At the
// forecast won-only call site the cohort is already psc.slug IN wonSlugs, so the non-WON
// branch is unreachable there and the window is purely canonical.)
export function buildWonDateSql(filters: PerformanceReportFilters) {
  const wonClosed = aliasedWonHsClosedWonDateSql("d");
  const wonSlugList = sqlStringList([...WON_STAGE_SLUGS]);
  return sql`
    (
      (
        psc.slug IN (${wonSlugList})
        AND ${aliasedHasUsableWonDateSql("d")}
        AND ${wonClosed} >= ${filters.dateFrom}::date
        AND ${wonClosed} <= ${filters.dateTo}::date
      )
      OR
      (
        psc.slug NOT IN (${wonSlugList})
        AND COALESCE(d.contract_signed_at, (d.actual_close_date AT TIME ZONE 'UTC'), d.updated_at) >= ${filters.dateFrom}::date
        AND COALESCE(d.contract_signed_at, (d.actual_close_date AT TIME ZONE 'UTC'), d.updated_at) < (${filters.dateTo}::date + INTERVAL '1 day')
      )
    )
  `;
}

// Month-bucket date for the forecast accuracy trend. WON deals land in the month of the
// canonical deals.won_closed_date (so a Jan-won deal with a Feb expected-close reports its
// won_actual in January, not February — fixing the variance %); OPEN/non-won deals fall
// through to expected_close_date (their forecast month) exactly as before, because
// won_closed_date IS NULL for them. Leading the COALESCE with won_closed_date is the only
// change — the legacy fallback chain is preserved for everything else.
export function buildForecastMonthBucketDateSql(alias: string) {
  return sql`COALESCE(${aliasedWonHsClosedWonDateSql(alias)}, ${sql.raw(alias)}.expected_close_date, ${sql.raw(alias)}.actual_close_date, ${sql.raw(alias)}.contract_signed_date, ${sql.raw(alias)}.updated_at::date)`;
}

interface DirectorKpiRow {
  total_pipeline_value: string | number | null;
  open_deal_count: string | number | null;
  forecast_commit: string | number | null;
  forecast_best_case: string | number | null;
  win_rate: string | number | null;
}
interface DirectorRiskRow {
  deals_at_risk: string | number | null;
  deals_at_risk_value: string | number | null;
  stalled_accounts: string | number | null;
  overdue_tasks: string | number | null;
  missed_follow_ups: string | number | null;
}
interface DirectorRepRow {
  rep_name: string | null;
  open_deals: string | number | null;
  pipeline_value: string | number | null;
  won_this_period: string | number | null;
  win_rate: string | number | null;
  activity_score: string | number | null;
}
interface DirectorOfficeRow {
  office_name: string | null;
  pipeline_value: string | number | null;
  open_count: string | number | null;
  win_rate: string | number | null;
}
interface AtRiskDealRow {
  deal_id: string;
  deal_name: string;
  owner_name: string | null;
  stage_name: string | null;
  days_in_stage: string | number | null;
  value: string | number | null;
  last_activity_date: string | null;
}

interface AtRiskDealCandidateRow extends AtRiskDealRow {
  [key: string]: unknown;
  stage_slug: string | null;
  workflow_route: WorkflowRoute | null;
  stage_entered_at: string | Date | null;
  bid_board_stage_entered_at: string | Date | null;
  on_hold: boolean | null;
  on_hold_started_at: string | Date | null;
  on_hold_accumulated_seconds: string | number | bigint | null;
  on_hold_accumulated_seconds_at_stage_entry: string | number | bigint | null;
}

export interface DirectorScorecardReport {
  kpis: {
    totalPipelineValue: number;
    openDealCount: number;
    forecastCommit: number;
    forecastBestCase: number;
    winRate: number;
  };
  risks: {
    dealsAtRisk: number;
    dealsAtRiskValue: number;
    stalledAccounts: number;
    overdueTasks: number;
    missedFollowUps: number;
  };
  repPerformance: Array<{
    repName: string;
    openDeals: number;
    pipelineValue: number;
    wonThisPeriod: number;
    winRate: number;
    activityScore: number;
  }>;
  officeComparison: Array<{
    officeName: string;
    pipelineValue: number;
    openCount: number;
    winRate: number;
  }>;
  topAtRiskDeals: Array<{
    dealId: string;
    dealName: string;
    ownerName: string;
    stageName: string;
    daysInStage: number;
    value: number;
    lastActivityDate: string | null;
  }>;
}

export function buildDirectorScorecardFromRows(input: {
  kpiRows: DirectorKpiRow[];
  riskRows: DirectorRiskRow[];
  repRows: DirectorRepRow[];
  officeRows: DirectorOfficeRow[];
  atRiskRows: AtRiskDealRow[];
}): DirectorScorecardReport {
  const kpi = input.kpiRows[0];
  const risk = input.riskRows[0];
  return {
    kpis: {
      totalPipelineValue: numberValue(kpi?.total_pipeline_value),
      openDealCount: numberValue(kpi?.open_deal_count),
      forecastCommit: numberValue(kpi?.forecast_commit),
      forecastBestCase: numberValue(kpi?.forecast_best_case),
      winRate: round(numberValue(kpi?.win_rate), 1),
    },
    risks: {
      dealsAtRisk: numberValue(risk?.deals_at_risk),
      dealsAtRiskValue: numberValue(risk?.deals_at_risk_value),
      stalledAccounts: numberValue(risk?.stalled_accounts),
      overdueTasks: numberValue(risk?.overdue_tasks),
      missedFollowUps: numberValue(risk?.missed_follow_ups),
    },
    repPerformance: input.repRows.map((row) => ({
      repName: row.rep_name || "Unassigned",
      openDeals: numberValue(row.open_deals),
      pipelineValue: numberValue(row.pipeline_value),
      wonThisPeriod: numberValue(row.won_this_period),
      winRate: round(numberValue(row.win_rate), 1),
      activityScore: numberValue(row.activity_score),
    })),
    officeComparison: input.officeRows.map((row) => ({
      officeName: row.office_name || "Unassigned Office",
      pipelineValue: numberValue(row.pipeline_value),
      openCount: numberValue(row.open_count),
      winRate: round(numberValue(row.win_rate), 1),
    })),
    topAtRiskDeals: input.atRiskRows.map((row) => ({
      dealId: row.deal_id,
      dealName: row.deal_name,
      ownerName: row.owner_name || "Unassigned",
      stageName: row.stage_name || "Unassigned Stage",
      daysInStage: numberValue(row.days_in_stage),
      value: numberValue(row.value),
      lastActivityDate: row.last_activity_date,
    })),
  };
}

function buildDirectorScorecardAtRiskRows(
  rows: AtRiskDealCandidateRow[],
  now: Date
): AtRiskDealRow[] {
  return rows
    .map((row) => {
      const atRisk = getDealAtRiskResult(
        {
          stageSlug: row.stage_slug,
          workflowRoute: row.workflow_route ?? "normal",
          stageEnteredAt: row.bid_board_stage_entered_at ?? row.stage_entered_at,
          onHold: row.on_hold,
          onHoldStartedAt: row.on_hold_started_at,
          onHoldAccumulatedSeconds:
            row.on_hold_accumulated_seconds == null
              ? null
              : Number(row.on_hold_accumulated_seconds),
          onHoldAccumulatedSecondsAtStageEntry:
            row.on_hold_accumulated_seconds_at_stage_entry == null
              ? null
              : Number(row.on_hold_accumulated_seconds_at_stage_entry),
        },
        "director",
        now
      );
      return { row, atRisk };
    })
    .filter(({ atRisk }) => atRisk.isAtRisk)
    .sort((left, right) => {
      if (right.atRisk.effectiveStageAgeDays !== left.atRisk.effectiveStageAgeDays) {
        return right.atRisk.effectiveStageAgeDays - left.atRisk.effectiveStageAgeDays;
      }
      return numberValue(right.row.value) - numberValue(left.row.value);
    })
    .map(({ row, atRisk }) => ({
      deal_id: row.deal_id,
      deal_name: row.deal_name,
      owner_name: row.owner_name,
      stage_name: row.stage_name,
      days_in_stage: atRisk.effectiveStageAgeDays,
      value: row.value,
      last_activity_date: row.last_activity_date,
    }));
}

export async function getDirectorScorecard(db: TenantDb, filters: PerformanceReportFilters, tenantKey: string) {
  return withReportCache(cacheKey("director-scorecard", tenantKey, "director", filters), async () => {
    const dealScope = buildDealScopeSql(filters);
    const closedDealScope = buildClosedDealScopeSql(filters);
    const wonDate = buildWonDateSql(filters);
    const terminalSlugs = [...WON_STAGE_SLUGS, ...LOST_STAGE_SLUGS];
    const commitSlugs = [...COMMIT_STAGE_SLUGS];
    const bestCaseSlugs = [...COMMIT_STAGE_SLUGS, ...BEST_CASE_STAGE_SLUGS];

    const kpis = await db.execute(sql`
        WITH open_deals AS (
          SELECT d.*, psc.slug
          FROM deals d
          JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${dealScope}
            AND psc.slug NOT IN (${sqlStringList(terminalSlugs)})
            AND ${aliasedActiveDealCountFilterSql("d")}
        ),
        won_lost AS (
          SELECT d.id, psc.slug
          FROM deals d
          JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${closedDealScope} AND ${wonDate}
        )
        SELECT
          COALESCE(SUM(${aliasedEffectiveDealValueSql("open_deals")}), 0)::numeric AS total_pipeline_value,
          COUNT(*)::int AS open_deal_count,
          COALESCE(SUM(${aliasedEffectiveDealValueSql("open_deals")}) FILTER (WHERE slug IN (${sqlStringList(commitSlugs)})), 0)::numeric AS forecast_commit,
          COALESCE(SUM(${aliasedEffectiveDealValueSql("open_deals")}) FILTER (WHERE slug IN (${sqlStringList(bestCaseSlugs)})), 0)::numeric AS forecast_best_case,
          CASE WHEN (SELECT COUNT(*) FROM won_lost WHERE slug IN (${sqlStringList([...WON_STAGE_SLUGS, ...LOST_STAGE_SLUGS])})) = 0 THEN 0
            ELSE ((SELECT COUNT(*) FROM won_lost WHERE slug IN (${sqlStringList([...WON_STAGE_SLUGS])}))::numeric / (SELECT COUNT(*) FROM won_lost WHERE slug IN (${sqlStringList([...WON_STAGE_SLUGS, ...LOST_STAGE_SLUGS])}))::numeric) * 100
          END AS win_rate
        FROM open_deals
      `);
    const risks = await db.execute(sql`
        WITH scoped_deals AS (
          SELECT d.*
          FROM deals d
          JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${dealScope}
            AND psc.slug NOT IN (${sqlStringList(terminalSlugs)})
            AND ${aliasedActiveDealCountFilterSql("d")}
        ),
        task_deals AS (
          SELECT d.id
          FROM deals d
          JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
          WHERE ${dealScope}
            AND ${aliasedActiveDealCountFilterSql("d")}
        )
        SELECT
          0::int AS deals_at_risk,
          0::numeric AS deals_at_risk_value,
          COUNT(DISTINCT d.company_id) FILTER (WHERE d.last_activity_at IS NULL OR d.last_activity_at < now() - INTERVAL '14 days')::int AS stalled_accounts,
          (
            SELECT COUNT(*)::int
            FROM tasks t
            LEFT JOIN task_deals td ON td.id = t.deal_id
            LEFT JOIN users u ON u.id = t.assigned_to
            LEFT JOIN offices o ON o.id = u.office_id
            WHERE COALESCE(t.is_test_data, false) = false
              AND t.status IN ('pending', 'scheduled', 'in_progress')
              AND t.due_date < CURRENT_DATE
              AND (
                (t.deal_id IS NOT NULL AND td.id IS NOT NULL)
                OR (t.deal_id IS NULL AND ${buildResponsibleUserScopeSql(filters)})
              )
          ) AS overdue_tasks,
          COUNT(*) FILTER (WHERE d.last_activity_at IS NULL OR d.last_activity_at < now() - INTERVAL '14 days')::int AS missed_follow_ups
        FROM scoped_deals d
      `);
    const reps = await db.execute(sql`
        WITH rep_open AS (
          SELECT u.id, u.display_name, d.id AS deal_id, ${aliasedEffectiveDealValueSql("d")} AS value, psc.slug
          FROM deals d
          JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${dealScope}
            AND psc.slug NOT IN (${sqlStringList(terminalSlugs)})
            AND ${aliasedActiveDealCountFilterSql("d")}
        ),
        rep_won AS (
          SELECT u.id, COUNT(*) FILTER (WHERE psc.slug IN (${sqlStringList([...WON_STAGE_SLUGS])}))::int AS won_count,
            CASE WHEN COUNT(*) FILTER (WHERE psc.slug IN (${sqlStringList([...WON_STAGE_SLUGS, ...LOST_STAGE_SLUGS])})) = 0 THEN 0
              ELSE (COUNT(*) FILTER (WHERE psc.slug IN (${sqlStringList([...WON_STAGE_SLUGS])}))::numeric / COUNT(*) FILTER (WHERE psc.slug IN (${sqlStringList([...WON_STAGE_SLUGS, ...LOST_STAGE_SLUGS])}))::numeric) * 100 END AS win_rate
          FROM deals d
          JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${closedDealScope} AND ${wonDate}
          GROUP BY u.id
        ),
        rep_activity AS (
          SELECT a.responsible_user_id AS id, COUNT(*)::int AS activity_score
          FROM activities a
          JOIN users u ON u.id = a.responsible_user_id
          JOIN offices o ON o.id = u.office_id
          WHERE ${buildActivityScopeSql(filters)}
          GROUP BY a.responsible_user_id
        )
        SELECT ro.display_name AS rep_name, COUNT(ro.deal_id)::int AS open_deals,
          COALESCE(SUM(ro.value), 0)::numeric AS pipeline_value,
          COALESCE(rw.won_count, 0)::int AS won_this_period,
          COALESCE(rw.win_rate, 0)::numeric AS win_rate,
          COALESCE(ra.activity_score, 0)::int AS activity_score
        FROM rep_open ro
        LEFT JOIN rep_won rw ON rw.id = ro.id
        LEFT JOIN rep_activity ra ON ra.id = ro.id
        GROUP BY ro.id, ro.display_name, rw.won_count, rw.win_rate, ra.activity_score
        ORDER BY pipeline_value DESC
      `);
    const offices = await db.execute(sql`
        WITH office_open AS (
          SELECT o.id AS office_id, o.name AS office_name,
            COALESCE(SUM(${aliasedEffectiveDealValueSql("d")}), 0)::numeric AS pipeline_value,
            COUNT(*)::int AS open_count
          FROM deals d
          JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${dealScope}
            AND psc.slug NOT IN (${sqlStringList(terminalSlugs)})
            AND ${aliasedActiveDealCountFilterSql("d")}
          GROUP BY o.id, o.name
        ),
        office_outcomes AS (
          SELECT o.id AS office_id,
            COUNT(*) FILTER (WHERE psc.slug IN (${sqlStringList([...WON_STAGE_SLUGS])}))::int AS won_count,
            COUNT(*) FILTER (WHERE psc.slug IN (${sqlStringList([...LOST_STAGE_SLUGS])}))::int AS lost_count
          FROM deals d
          JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${closedDealScope} AND ${wonDate} AND psc.slug IN (${sqlStringList(terminalSlugs)})
          GROUP BY o.id
        )
        SELECT oo.office_name,
          oo.pipeline_value,
          oo.open_count,
          CASE WHEN COALESCE(outcomes.won_count, 0) + COALESCE(outcomes.lost_count, 0) = 0 THEN 0
            ELSE (COALESCE(outcomes.won_count, 0)::numeric / (COALESCE(outcomes.won_count, 0) + COALESCE(outcomes.lost_count, 0))::numeric) * 100
          END AS win_rate
        FROM office_open oo
        LEFT JOIN office_outcomes outcomes ON outcomes.office_id = oo.office_id
        ORDER BY oo.office_name ASC
      `);
    const atRiskCandidates = await db.execute<AtRiskDealCandidateRow>(sql`
        SELECT d.id AS deal_id, d.name AS deal_name, u.display_name AS owner_name, psc.name AS stage_name,
          COALESCE(d.bid_board_stage_slug, psc.slug) AS stage_slug,
          d.workflow_route,
          d.stage_entered_at,
          d.bid_board_stage_entered_at,
          d.on_hold,
          d.on_hold_started_at,
          d.on_hold_accumulated_seconds,
          d.on_hold_accumulated_seconds_at_stage_entry,
          ${aliasedEffectiveDealValueSql("d")} AS value,
          d.last_activity_at::text AS last_activity_date
        FROM deals d
        JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE ${dealScope}
          AND psc.slug NOT IN (${sqlStringList(terminalSlugs)})
          AND ${aliasedActiveDealCountFilterSql("d")}
        ORDER BY d.stage_entered_at ASC
      `);
    const atRiskRows = buildDirectorScorecardAtRiskRows(
      rowsFromExecute<AtRiskDealCandidateRow>(atRiskCandidates),
      new Date()
    );
    const riskRows = rowsFromExecute<DirectorRiskRow>(risks);
    const riskBase = riskRows[0];
    const riskRowsWithEngineAtRisk: DirectorRiskRow[] = [
      {
        deals_at_risk: atRiskRows.length,
        deals_at_risk_value: atRiskRows.reduce((sum, row) => sum + numberValue(row.value), 0),
        stalled_accounts: riskBase?.stalled_accounts ?? 0,
        overdue_tasks: riskBase?.overdue_tasks ?? 0,
        missed_follow_ups: riskBase?.missed_follow_ups ?? 0,
      },
    ];

    return buildDirectorScorecardFromRows({
      kpiRows: rowsFromExecute<DirectorKpiRow>(kpis),
      riskRows: riskRowsWithEngineAtRisk,
      repRows: rowsFromExecute<DirectorRepRow>(reps),
      officeRows: rowsFromExecute<DirectorOfficeRow>(offices),
      atRiskRows: atRiskRows.slice(0, 5),
    });
  });
}

interface RepActivitySummaryRow {
  total_touchpoints: string | number | null;
  deals_worked: string | number | null;
  calls: string | number | null;
  emails: string | number | null;
  meetings: string | number | null;
  follow_ups_completed: string | number | null;
}
interface TimelineRow { day: string; touchpoints: string | number | null }
interface TypeRow { type: string | null; count: string | number | null }
interface StalledAccountRow {
  account_name: string | null;
  owner_name: string | null;
  last_activity_date: string | null;
  days_stalled: string | number | null;
  open_deals: string | number | null;
  total_open_value: string | number | null;
}
interface RepSummaryRow {
  rep_name: string | null;
  touchpoints: string | number | null;
  active_deals: string | number | null;
  stalled_accounts: string | number | null;
}

export interface RepActivityReport {
  kpis: {
    totalTouchpoints: number;
    dealsWorked: number;
    calls: number;
    emails: number;
    meetings: number;
    followUpsCompleted: number;
  };
  timeline: Array<{ date: string; touchpoints: number }>;
  stalledAccounts: Array<{
    accountName: string;
    ownerName: string;
    lastActivityDate: string | null;
    daysStalled: number;
    openDeals: number;
    totalOpenValue: number;
  }>;
  activityByType: Array<{ type: string; count: number }>;
  repSummary: Array<{ repName: string; touchpoints: number; activeDeals: number; stalledAccounts: number }>;
}

export function buildRepActivityFromRows(input: {
  summaryRows: RepActivitySummaryRow[];
  timelineRows: TimelineRow[];
  typeRows: TypeRow[];
  stalledRows: StalledAccountRow[];
  repRows: RepSummaryRow[];
}): RepActivityReport {
  const summary = input.summaryRows[0];
  return {
    kpis: {
      totalTouchpoints: numberValue(summary?.total_touchpoints),
      dealsWorked: numberValue(summary?.deals_worked),
      calls: numberValue(summary?.calls),
      emails: numberValue(summary?.emails),
      meetings: numberValue(summary?.meetings),
      followUpsCompleted: numberValue(summary?.follow_ups_completed),
    },
    timeline: input.timelineRows.map((row) => ({ date: String(row.day), touchpoints: numberValue(row.touchpoints) })),
    stalledAccounts: input.stalledRows.map((row) => ({
      accountName: row.account_name || "Unassigned Account",
      ownerName: row.owner_name || "Unassigned",
      lastActivityDate: row.last_activity_date,
      daysStalled: numberValue(row.days_stalled),
      openDeals: numberValue(row.open_deals),
      totalOpenValue: numberValue(row.total_open_value),
    })),
    activityByType: input.typeRows.map((row) => ({ type: titleCase(row.type), count: numberValue(row.count) })),
    repSummary: input.repRows.map((row) => ({
      repName: row.rep_name || "Unassigned",
      touchpoints: numberValue(row.touchpoints),
      activeDeals: numberValue(row.active_deals),
      stalledAccounts: numberValue(row.stalled_accounts),
    })),
  };
}

export async function getRepActivityReport(db: TenantDb, filters: PerformanceReportFilters, user: { role: UserRole; userId: string; displayName: string }, tenantKey: string) {
  const ownerIds = resolveRepActivityScope(user, filters.ownerIds);
  const scopedFilters = { ...filters, ownerIds };
  return withReportCache(cacheKey("rep-activity", tenantKey, `${user.role}:${user.userId}`, scopedFilters), async () => {
    const activityScope = buildActivityScopeSql(scopedFilters, ownerIds);
    const dealScope = buildDealScopeSql(scopedFilters);

    const summary = await db.execute(sql`
        SELECT COUNT(*)::int AS total_touchpoints,
          COUNT(DISTINCT a.deal_id)::int AS deals_worked,
          COUNT(*) FILTER (WHERE a.type = 'call')::int AS calls,
          COUNT(*) FILTER (WHERE a.type = 'email')::int AS emails,
          COUNT(*) FILTER (WHERE a.type = 'meeting')::int AS meetings,
          COUNT(*) FILTER (WHERE a.type IN ('follow_up', 'task_completed'))::int AS follow_ups_completed
        FROM activities a
        JOIN users u ON u.id = a.responsible_user_id
          JOIN offices o ON o.id = u.office_id
        WHERE ${activityScope}
      `);
    const timeline = await db.execute(sql`
        SELECT a.occurred_at::date::text AS day, COUNT(*)::int AS touchpoints
        FROM activities a
        JOIN users u ON u.id = a.responsible_user_id
          JOIN offices o ON o.id = u.office_id
        WHERE ${activityScope}
        GROUP BY a.occurred_at::date
        ORDER BY day ASC
      `);
    const types = await db.execute(sql`
        SELECT a.type::text AS type, COUNT(*)::int AS count
        FROM activities a
        JOIN users u ON u.id = a.responsible_user_id
          JOIN offices o ON o.id = u.office_id
        WHERE ${activityScope}
        GROUP BY a.type
        ORDER BY count DESC
      `);
    const stalled = await db.execute(sql`
        SELECT COALESCE(c.name, d.name) AS account_name, u.display_name AS owner_name,
          MAX(d.last_activity_at)::text AS last_activity_date,
          EXTRACT(DAY FROM now() - MAX(COALESCE(d.last_activity_at, d.created_at)))::int AS days_stalled,
          COUNT(d.id)::int AS open_deals,
          COALESCE(SUM(${aliasedEffectiveDealValueSql("d")}), 0)::numeric AS total_open_value
        FROM deals d
        JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        LEFT JOIN companies c ON c.id = d.company_id
        WHERE ${dealScope}
          AND psc.slug NOT IN (${sqlStringList([...WON_STAGE_SLUGS, ...LOST_STAGE_SLUGS])})
          AND ${aliasedActiveDealCountFilterSql("d")}
          AND (d.last_activity_at IS NULL OR d.last_activity_at < now() - INTERVAL '14 days')
        GROUP BY COALESCE(c.name, d.name), u.display_name
        ORDER BY days_stalled DESC
        LIMIT 25
      `);
    const reps = await db.execute(sql`
        WITH activity AS (
          SELECT a.responsible_user_id, COUNT(*)::int AS touchpoints
          FROM activities a
          JOIN users u ON u.id = a.responsible_user_id
          JOIN offices o ON o.id = u.office_id
          WHERE ${activityScope}
          GROUP BY a.responsible_user_id
        ),
        active_deals AS (
          SELECT d.assigned_rep_id, COUNT(*)::int AS active_deals,
            COUNT(*) FILTER (WHERE d.last_activity_at IS NULL OR d.last_activity_at < now() - INTERVAL '14 days')::int AS stalled_accounts
          FROM deals d
          JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${dealScope}
            AND psc.slug NOT IN (${sqlStringList([...WON_STAGE_SLUGS, ...LOST_STAGE_SLUGS])})
            AND ${aliasedActiveDealCountFilterSql("d")}
          GROUP BY d.assigned_rep_id
        )
        SELECT u.display_name AS rep_name, COALESCE(a.touchpoints, 0)::int AS touchpoints,
          COALESCE(ad.active_deals, 0)::int AS active_deals,
          COALESCE(ad.stalled_accounts, 0)::int AS stalled_accounts
        FROM users u
        LEFT JOIN activity a ON a.responsible_user_id = u.id
        LEFT JOIN active_deals ad ON ad.assigned_rep_id = u.id
        WHERE (${ownerIds.length === 0 ? sql`true` : sql`u.id IN (${sqlStringList(ownerIds)})`})
          AND (a.touchpoints IS NOT NULL OR ad.active_deals IS NOT NULL)
        ORDER BY touchpoints DESC, active_deals DESC
      `);

    return buildRepActivityFromRows({
      summaryRows: rowsFromExecute<RepActivitySummaryRow>(summary),
      timelineRows: rowsFromExecute<TimelineRow>(timeline),
      typeRows: rowsFromExecute<TypeRow>(types),
      stalledRows: rowsFromExecute<StalledAccountRow>(stalled),
      repRows: rowsFromExecute<RepSummaryRow>(reps),
    });
  });
}

interface ForecastSummaryRow {
  commit: string | number | null;
  best_case: string | number | null;
  pipeline_weighted: string | number | null;
  won_actual: string | number | null;
  variance_percent: string | number | null;
}
interface ForecastMonthlyRow {
  month: string;
  commit: string | number | null;
  best_case: string | number | null;
  pipeline_weighted: string | number | null;
  won_actual: string | number | null;
}
interface ForecastAtRiskRow {
  deal_id: string;
  deal_name: string;
  owner_name: string | null;
  stage_name: string | null;
  value: string | number | null;
  expected_close_date: string | null;
}

export interface ForecastAccuracyReport {
  kpis: {
    commit: number;
    bestCase: number;
    pipelineWeighted: number;
    wonActual: number;
  };
  monthly: Array<{ month: string; commit: number; bestCase: number; pipelineWeighted: number; wonActual: number }>;
  accuracy: { variancePercent: number };
  pipelineAtRisk: Array<{
    dealId: string;
    dealName: string;
    ownerName: string;
    stageName: string;
    value: number;
    expectedCloseDate: string | null;
  }>;
}

export function buildForecastAccuracyFromRows(input: {
  summaryRows: ForecastSummaryRow[];
  monthlyRows: ForecastMonthlyRow[];
  atRiskRows: ForecastAtRiskRow[];
}): ForecastAccuracyReport {
  const summary = input.summaryRows[0];
  return {
    kpis: {
      commit: numberValue(summary?.commit),
      bestCase: numberValue(summary?.best_case),
      pipelineWeighted: numberValue(summary?.pipeline_weighted),
      wonActual: numberValue(summary?.won_actual),
    },
    monthly: input.monthlyRows.map((row) => ({
      month: row.month,
      commit: numberValue(row.commit),
      bestCase: numberValue(row.best_case),
      pipelineWeighted: numberValue(row.pipeline_weighted),
      wonActual: numberValue(row.won_actual),
    })),
    accuracy: {
      variancePercent: round(numberValue(summary?.variance_percent), 1),
    },
    pipelineAtRisk: input.atRiskRows.map((row) => ({
      dealId: row.deal_id,
      dealName: row.deal_name,
      ownerName: row.owner_name || "Unassigned",
      stageName: row.stage_name || "Unassigned Stage",
      value: numberValue(row.value),
      expectedCloseDate: row.expected_close_date,
    })),
  };
}

export async function getForecastAccuracyReport(db: TenantDb, filters: PerformanceReportFilters, tenantKey: string) {
  return withReportCache(cacheKey("forecast-accuracy", tenantKey, "director", filters), async () => {
    const dealScope = buildDealScopeSql(filters);
    const archivedWonDealScope = buildArchivedWonDealScopeSql(filters);
    const commitSlugs = [...COMMIT_STAGE_SLUGS];
    const bestCaseSlugs = [...COMMIT_STAGE_SLUGS, ...BEST_CASE_STAGE_SLUGS];
    const wonSlugs = [...WON_STAGE_SLUGS];
    const terminalSlugs = [...WON_STAGE_SLUGS, ...LOST_STAGE_SLUGS];

    const forecastValue = aliasedEffectiveDealValueSql("d", aliasedForecastFirstDealValueSql("d"));
    const weightedValue = sql`(${forecastValue}) * CASE
      WHEN psc.slug = 'opportunity' THEN 0.10
      WHEN psc.slug IN ('estimating', 'estimate_in_progress', 'service_estimating', 'estimate_under_review', 'service_estimate_under_review') THEN 0.25
      WHEN psc.slug IN ('estimate_sent_to_client', 'service_estimate_sent_to_client') THEN 0.50
      WHEN psc.slug IN ('contract', 'contract_signed', 'service_contract_signed') THEN 0.75
      ELSE COALESCE(d.win_probability, 10)::numeric / 100
    END`;

    const summary = await db.execute(sql`
        WITH won_period AS (
          SELECT COALESCE(SUM(${aliasedEffectiveWonDealValueSql("d")}), 0)::numeric AS won_actual
          FROM deals d
          JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
          JOIN pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE ${archivedWonDealScope} AND psc.slug IN (${sqlStringList(wonSlugs)}) AND ${buildWonDateSql(filters)}
        )
        SELECT
          COALESCE(SUM(${forecastValue}) FILTER (WHERE psc.slug IN (${sqlStringList(commitSlugs)})), 0)::numeric AS commit,
          COALESCE(SUM(${forecastValue}) FILTER (WHERE psc.slug IN (${sqlStringList(bestCaseSlugs)})), 0)::numeric AS best_case,
          COALESCE(SUM(${weightedValue}) FILTER (WHERE psc.slug NOT IN (${sqlStringList(terminalSlugs)})), 0)::numeric AS pipeline_weighted,
          (SELECT won_actual FROM won_period) AS won_actual,
          CASE WHEN COALESCE(SUM(${forecastValue}) FILTER (WHERE psc.slug IN (${sqlStringList(commitSlugs)})), 0) = 0 THEN 0
            ELSE (((SELECT won_actual FROM won_period) - COALESCE(SUM(${forecastValue}) FILTER (WHERE psc.slug IN (${sqlStringList(commitSlugs)})), 0))
              / NULLIF(COALESCE(SUM(${forecastValue}) FILTER (WHERE psc.slug IN (${sqlStringList(commitSlugs)})), 0), 0)) * 100
          END AS variance_percent
        FROM deals d
        JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE ${dealScope}
      `);
    const monthly = await db.execute(sql`
        WITH months AS (
          SELECT generate_series(date_trunc('month', ${filters.dateFrom}::date), date_trunc('month', ${filters.dateTo}::date), INTERVAL '1 month')::date AS month_start
        )
        SELECT to_char(m.month_start, 'YYYY-MM') AS month,
          COALESCE(SUM(${forecastValue}) FILTER (WHERE psc.slug IN (${sqlStringList(commitSlugs)})), 0)::numeric AS commit,
          COALESCE(SUM(${forecastValue}) FILTER (WHERE psc.slug IN (${sqlStringList(bestCaseSlugs)})), 0)::numeric AS best_case,
          COALESCE(SUM(${weightedValue}) FILTER (WHERE psc.slug NOT IN (${sqlStringList(terminalSlugs)})), 0)::numeric AS pipeline_weighted,
          COALESCE(SUM(${aliasedEffectiveWonDealValueSql("d")}) FILTER (WHERE psc.slug IN (${sqlStringList(wonSlugs)})), 0)::numeric AS won_actual
        FROM months m
        LEFT JOIN deals d ON ${buildForecastMonthBucketDateSql("d")} >= m.month_start
          AND ${buildForecastMonthBucketDateSql("d")} < (m.month_start + INTERVAL '1 month')
        LEFT JOIN users u ON u.id = d.assigned_rep_id
        LEFT JOIN offices o ON o.id = u.office_id
        LEFT JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE d.id IS NULL OR (${dealScope}) OR (${archivedWonDealScope} AND psc.slug IN (${sqlStringList(wonSlugs)}))
        GROUP BY m.month_start
        ORDER BY m.month_start
      `);
    const atRisk = await db.execute(sql`
        SELECT d.id AS deal_id, d.name AS deal_name, u.display_name AS owner_name, psc.name AS stage_name,
          ${forecastValue} AS value,
          d.expected_close_date::text AS expected_close_date
        FROM deals d
        JOIN users u ON u.id = d.assigned_rep_id
          JOIN offices o ON o.id = u.office_id
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE ${dealScope}
          AND psc.slug NOT IN (${sqlStringList(terminalSlugs)})
          AND d.expected_close_date >= ${filters.dateFrom}::date
          AND d.expected_close_date <= ${filters.dateTo}::date
        ORDER BY d.expected_close_date ASC NULLS LAST, value DESC
        LIMIT 25
      `);

    return buildForecastAccuracyFromRows({
      summaryRows: rowsFromExecute<ForecastSummaryRow>(summary),
      monthlyRows: rowsFromExecute<ForecastMonthlyRow>(monthly),
      atRiskRows: rowsFromExecute<ForecastAtRiskRow>(atRisk),
    });
  });
}
