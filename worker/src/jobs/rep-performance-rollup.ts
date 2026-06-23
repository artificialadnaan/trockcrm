import {
  closeTargetFarOutSqlPredicate,
  getDealAtRiskResult,
  isReportableDeal,
  reportableDealSqlPredicate,
  LOST_DEAL_STAGE_SLUGS,
  type WorkflowRoute,
  WON_DEAL_STAGE_SLUGS,
} from "@trock-crm/shared/types";
import { pool } from "../db.js";

export const STALE_ACCOUNT_THRESHOLD_DAYS = 30;
const REPORTABLE_DEAL_SQL = reportableDealSqlPredicate("d");
const currentDealValueSql = `COALESCE(
  CASE WHEN d.bid_board_total_sales > 0 THEN d.bid_board_total_sales END,
  CASE WHEN d.bid_estimate > 0 THEN d.bid_estimate END,
  CASE WHEN d.dd_estimate > 0 THEN d.dd_estimate END,
  CASE WHEN d.awarded_amount > 0 THEN d.awarded_amount END,
  0
)`;
const awardedFirstDealValueSql = `COALESCE(
  CASE WHEN d.awarded_amount > 0 THEN d.awarded_amount END,
  CASE WHEN d.bid_board_total_sales > 0 THEN d.bid_board_total_sales END,
  CASE WHEN d.bid_estimate > 0 THEN d.bid_estimate END,
  CASE WHEN d.dd_estimate > 0 THEN d.dd_estimate END,
  0
)`;
// pipeline_value sums an OPEN population (NOT psc.is_terminal), so a far-out (90+ day) auto-held deal must
// read as $0 to match the deals list/kanban totals. on_hold is already excluded via REPORTABLE_DEAL_SQL, so
// only the far-out leg is added (Codex P2). closed_value/awardedFirst stays raw — it sums realized won deals.
const effectiveCurrentDealValueSql = `CASE WHEN (${closeTargetFarOutSqlPredicate("d")}) THEN 0 ELSE ${currentDealValueSql} END`;
const wonStageSqlList = WON_DEAL_STAGE_SLUGS.map((slug) => `'${slug}'`).join(", ");
const lostStageSqlList = LOST_DEAL_STAGE_SLUGS.map((slug) => `'${slug}'`).join(", ");
const terminalStageSqlList = [...WON_DEAL_STAGE_SLUGS, ...LOST_DEAL_STAGE_SLUGS]
  .map((slug) => `'${slug}'`)
  .join(", ");

const PERIOD_KINDS = [
  "mtd",
  "qtd",
  "ytd",
  "last_month",
  "last_quarter",
  "last_year",
  "week_8back",
] as const;

type PeriodKind = (typeof PERIOD_KINDS)[number];

interface PeriodRange {
  kind: PeriodKind;
  start: string;
  end: string;
}

interface RepAtRiskInputRow {
  rep_id: string | null;
  stage_slug: string | null;
  workflow_route: string | null;
  stage_entered_at: string | Date | null;
  expected_close_date: string | Date | null;
  on_hold: boolean | null;
  on_hold_started_at: string | Date | null;
  on_hold_accumulated_seconds: string | number | bigint | null;
  on_hold_accumulated_seconds_at_stage_entry: string | number | bigint | null;
}

interface RepAtRiskCount {
  repId: string;
  atRiskCount: number;
}

export function toDateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 1));
}

function endOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0));
}

export function buildRepPerformancePeriodRanges(now = new Date()): PeriodRange[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const quarterStartMonth = Math.floor(month / 3) * 3;
  const previousQuarterStartMonth = quarterStartMonth === 0 ? 9 : quarterStartMonth - 3;
  const previousQuarterYear = quarterStartMonth === 0 ? year - 1 : year;
  const lastMonth = month === 0 ? 11 : month - 1;
  const lastMonthYear = month === 0 ? year - 1 : year;
  const today = toDateString(now);
  const eightWeeksAgo = new Date(now);
  eightWeeksAgo.setUTCDate(eightWeeksAgo.getUTCDate() - 55);

  return [
    { kind: "mtd", start: toDateString(startOfMonth(year, month)), end: today },
    { kind: "qtd", start: toDateString(startOfMonth(year, quarterStartMonth)), end: today },
    { kind: "ytd", start: `${year}-01-01`, end: today },
    {
      kind: "last_month",
      start: toDateString(startOfMonth(lastMonthYear, lastMonth)),
      end: toDateString(endOfMonth(lastMonthYear, lastMonth)),
    },
    {
      kind: "last_quarter",
      start: toDateString(startOfMonth(previousQuarterYear, previousQuarterStartMonth)),
      end: toDateString(endOfMonth(previousQuarterYear, previousQuarterStartMonth + 2)),
    },
    { kind: "last_year", start: `${year - 1}-01-01`, end: `${year - 1}-12-31` },
    { kind: "week_8back", start: toDateString(eightWeeksAgo), end: today },
  ];
}

function periodEndAsOfDate(period: PeriodRange) {
  const [year, month, day] = period.end.split("-").map((part) => Number(part));
  if (!year || !month || !day) {
    throw new Error(`Invalid rollup period end date: ${period.end}`);
  }

  return new Date(Date.UTC(year, month - 1, day));
}

function normalizeWorkflowRoute(value: string | null | undefined): WorkflowRoute {
  return value === "service" ? "service" : "normal";
}

function numberOrNull(value: string | number | bigint | null | undefined) {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function computeRepAtRiskCountsFromRows(
  rows: RepAtRiskInputRow[],
  asOf: Date
): RepAtRiskCount[] {
  const countsByRep = new Map<string, number>();

  for (const row of rows) {
    if (!row.rep_id) continue;
    if (!isReportableDeal({ onHold: row.on_hold })) continue;

    const atRisk = getDealAtRiskResult(
      {
        stageSlug: row.stage_slug,
        workflowRoute: normalizeWorkflowRoute(row.workflow_route),
        stageEnteredAt: row.stage_entered_at,
        // Match the app's aggregate at-risk (applyCloseTargetSuppression:false): exclude the 90+ day
        // auto-held case only, not a near close target, so the rep rollup mirrors the deals list/dashboard
        // (Codex P2).
        expectedCloseDate: row.expected_close_date,
        applyCloseTargetSuppression: false,
        onHold: row.on_hold,
        onHoldStartedAt: row.on_hold_started_at,
        onHoldAccumulatedSeconds: numberOrNull(row.on_hold_accumulated_seconds),
        onHoldAccumulatedSecondsAtStageEntry: numberOrNull(
          row.on_hold_accumulated_seconds_at_stage_entry
        ),
      },
      "rep",
      asOf
    );

    if (atRisk.isAtRisk) {
      countsByRep.set(row.rep_id, (countsByRep.get(row.rep_id) ?? 0) + 1);
    }
  }

  return Array.from(countsByRep.entries())
    .map(([repId, atRiskCount]) => ({ repId, atRiskCount }))
    .sort((a, b) => a.repId.localeCompare(b.repId));
}

async function getRepAtRiskCountsForPeriod(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> },
  schemaName: string,
  period: PeriodRange
): Promise<RepAtRiskCount[]> {
  const result = await client.query(
    `SELECT
       d.assigned_rep_id AS rep_id,
       COALESCE(d.bid_board_stage_slug, psc.slug) AS stage_slug,
       d.workflow_route,
       COALESCE(
         d.bid_board_stage_entered_at,
         d.stage_entered_at,
         latest_current_stage_entered_at.entered_at
       ) AS stage_entered_at,
       d.expected_close_date,
       d.on_hold,
       d.on_hold_started_at,
       d.on_hold_accumulated_seconds,
       d.on_hold_accumulated_seconds_at_stage_entry
     FROM ${schemaName}.deals d
     JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
     LEFT JOIN LATERAL (
       SELECT dsh.entered_at
       FROM ${schemaName}.deal_stage_history dsh
       WHERE dsh.deal_id = d.id
         AND dsh.to_stage_id = d.stage_id
       ORDER BY dsh.entered_at DESC NULLS LAST, dsh.created_at DESC
       LIMIT 1
     ) latest_current_stage_entered_at ON true
     WHERE d.assigned_rep_id IS NOT NULL
       AND d.is_active = true
       AND NOT psc.is_terminal
       AND COALESCE(d.is_test_data, false) = false
       AND ${REPORTABLE_DEAL_SQL}
       AND d.created_at::date <= $1::date`,
    [period.end]
  );

  return computeRepAtRiskCountsFromRows(
    result.rows as RepAtRiskInputRow[],
    periodEndAsOfDate(period)
  );
}

async function refreshOfficePeriod(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> },
  schemaName: string,
  officeId: string,
  officeName: string,
  period: PeriodRange
) {
  await client.query(
    `DELETE FROM public.rep_performance_snapshots
     WHERE period_kind = $1
       AND period_start = $2::date
       AND period_end = $3::date
       AND rep_id IN (SELECT id FROM public.users WHERE office_id = $4)`,
    [period.kind, period.start, period.end, officeId]
  );

  const atRiskCounts = await getRepAtRiskCountsForPeriod(client, schemaName, period);

  const insertResult = await client.query(
    `WITH rep_deals AS (
       SELECT
         d.assigned_rep_id AS rep_id,
         COUNT(*) FILTER (
           WHERE CASE
             -- Note: current-period metrics use the deal's current stage state
             -- (psc.is_terminal, psc.is_active_pipeline) because "as of now" is
             -- a meaningful frame for live dashboards. Historical periods use
             -- lifecycle-only filters to preserve determinism. This means
             -- deals_count for "this month" vs "last month" answer slightly
             -- different product questions, by design.
             WHEN $1::text IN ('last_month', 'last_quarter', 'last_year') THEN
               -- Historical periods use lifecycle-only filters (created/closed
               -- window) to preserve period determinism. We deliberately do NOT
               -- filter on current stage flags (psc.is_terminal,
               -- psc.is_active_pipeline) because those reflect the deal's stage
               -- as of NOW, not as of period_end. A deal open during the period
               -- but now terminal would otherwise be retroactively excluded from
               -- historical snapshots. See: PR #160, Codex review on 3dab1ef212.
                ${REPORTABLE_DEAL_SQL}
                AND d.created_at::date <= $3::date
                AND (
                  COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) IS NULL
                  OR COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) >= $2::date
               )
              ELSE d.is_active = true AND NOT psc.is_terminal AND ${REPORTABLE_DEAL_SQL}
            END
         )::int AS deals_count,
         COALESCE(SUM(${effectiveCurrentDealValueSql})
           FILTER (
             WHERE CASE
               -- Historical pipeline_value follows the same deterministic
               -- lifecycle-only rule as historical deals_count above.
               WHEN $1::text IN ('last_month', 'last_quarter', 'last_year') THEN
                  ${REPORTABLE_DEAL_SQL}
                  AND d.created_at::date <= $3::date
                  AND (
                   COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) IS NULL
                   OR COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) >= $2::date
                 )
                ELSE d.is_active = true AND NOT psc.is_terminal AND psc.is_active_pipeline AND ${REPORTABLE_DEAL_SQL}
              END
           ), 0)::numeric AS pipeline_value,
         COUNT(*) FILTER (
         WHERE psc.slug IN (${wonStageSqlList})
              AND ${REPORTABLE_DEAL_SQL}
              AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.updated_at::date) >= $2::date
             AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.updated_at::date) <= $3::date
         )::int AS wins_count,
         COUNT(*) FILTER (
         WHERE psc.slug IN (${lostStageSqlList})
              AND ${REPORTABLE_DEAL_SQL}
              AND COALESCE(d.actual_close_date, d.lost_at::date, d.updated_at::date) >= $2::date
             AND COALESCE(d.actual_close_date, d.lost_at::date, d.updated_at::date) <= $3::date
         )::int AS losses_count,
         COALESCE(SUM(${awardedFirstDealValueSql})
           FILTER (
             WHERE psc.slug IN (${wonStageSqlList})
                AND ${REPORTABLE_DEAL_SQL}
                AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.updated_at::date) >= $2::date
               AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.updated_at::date) <= $3::date
           ), 0)::numeric AS closed_value,
         COALESCE(ROUND(AVG(
           COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date)
             - d.created_at::date
         ) FILTER (
          WHERE psc.slug IN (${terminalStageSqlList})
              AND ${REPORTABLE_DEAL_SQL}
              AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) >= $2::date
             AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) <= $3::date
         ), 2), 0)::numeric AS avg_days_to_close,
         0::int AS legacy_at_risk_count
       FROM ${schemaName}.deals d
       JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
       GROUP BY d.assigned_rep_id
     ),
     at_risk_counts AS (
       SELECT
         "repId"::uuid AS rep_id,
         "atRiskCount"::int AS at_risk_count
       FROM jsonb_to_recordset($7::jsonb) AS counts("repId" text, "atRiskCount" int)
     ),
     -- stale_accounts deliberately does NOT filter on companies.is_active or
     -- properties.is_active. There is no deactivated_at timestamp on those tables,
     -- so applying the current-state is_active flag to historical periods would
     -- retroactively change historical stale counts when accounts are deactivated.
     -- The metric becomes "accounts with stale activity timestamps as of period_end"
     -- rather than "currently-active accounts with stale activity," which is less
     -- semantically rich but deterministic. See: PR #160, Codex review on 3dab1ef212.
     stale_accounts AS (
       SELECT
         accounts.rep_id,
         COUNT(*)::int AS stale_account_count
       FROM (
         SELECT DISTINCT
           d.assigned_rep_id AS rep_id,
           'company' AS account_type,
           c.id AS account_id
         FROM ${schemaName}.deals d
         JOIN public.users account_rep
           ON account_rep.id = d.assigned_rep_id
          AND account_rep.office_id = $4
         JOIN ${schemaName}.companies c
           ON c.id = d.company_id
         WHERE d.assigned_rep_id IS NOT NULL
           AND ${REPORTABLE_DEAL_SQL}
           AND d.created_at::date <= $3::date
           AND c.last_activity_at IS NOT NULL
           -- Treat period_end as inclusive end-of-day before subtracting the
           -- staleness threshold, so cutoff-date evening activity is stale by
           -- the period boundary instead of being excluded by midnight casting.
           AND c.last_activity_at < ($3::date + interval '1 day')::timestamptz - ($6::int || ' days')::interval
         UNION
         SELECT DISTINCT
           d.assigned_rep_id AS rep_id,
           'property' AS account_type,
           p.id AS account_id
         FROM ${schemaName}.deals d
         JOIN public.users account_rep
           ON account_rep.id = d.assigned_rep_id
          AND account_rep.office_id = $4
         JOIN ${schemaName}.properties p
           ON p.id = d.property_id
         WHERE d.assigned_rep_id IS NOT NULL
           AND ${REPORTABLE_DEAL_SQL}
           AND d.created_at::date <= $3::date
           AND p.last_activity_at IS NOT NULL
           -- Treat period_end as inclusive end-of-day before subtracting the
           -- staleness threshold, so cutoff-date evening activity is stale by
           -- the period boundary instead of being excluded by midnight casting.
           AND p.last_activity_at < ($3::date + interval '1 day')::timestamptz - ($6::int || ' days')::interval
       ) accounts
       GROUP BY accounts.rep_id
     ),
     activity AS (
       SELECT
         responsible_user_id AS rep_id,
         COUNT(*)::int AS activity_total,
         COUNT(*) FILTER (WHERE type = 'call')::int AS calls,
         COUNT(*) FILTER (WHERE type = 'email')::int AS emails,
         COUNT(*) FILTER (WHERE type = 'meeting')::int AS meetings,
         COUNT(*) FILTER (WHERE type = 'note')::int AS notes
       FROM ${schemaName}.activities
       WHERE occurred_at >= $2::date
         AND occurred_at < ($3::date + INTERVAL '1 day')
       GROUP BY responsible_user_id
     )
     INSERT INTO public.rep_performance_snapshots (
       rep_id,
       period_kind,
       period_start,
       period_end,
       pipeline_value,
       closed_value,
       deals_count,
       wins_count,
       losses_count,
       win_rate,
       avg_days_to_close,
       at_risk_count,
       stale_account_count,
       activity_total,
       calls,
       emails,
       meetings,
       notes,
       sparkline_8w,
       region,
       computed_at
     )
     SELECT
       u.id,
       $1::perf_period_kind,
       $2::date,
       $3::date,
       COALESCE(rd.pipeline_value, 0),
       COALESCE(rd.closed_value, 0),
       COALESCE(rd.deals_count, 0),
       COALESCE(rd.wins_count, 0),
       COALESCE(rd.losses_count, 0),
       CASE
         WHEN COALESCE(rd.wins_count, 0) + COALESCE(rd.losses_count, 0) = 0 THEN 0
         ELSE ROUND((COALESCE(rd.wins_count, 0)::numeric / (COALESCE(rd.wins_count, 0) + COALESCE(rd.losses_count, 0))::numeric) * 100, 2)
       END,
       COALESCE(rd.avg_days_to_close, 0),
       COALESCE(arc.at_risk_count, 0),
       COALESCE(sa.stale_account_count, 0),
       COALESCE(a.activity_total, 0),
       COALESCE(a.calls, 0),
       COALESCE(a.emails, 0),
       COALESCE(a.meetings, 0),
       COALESCE(a.notes, 0),
       '[]'::jsonb,
       $5,
       -- Snapshot write timestamp: intentionally wall-clock, not period-bounded.
       NOW()
     FROM public.users u
     LEFT JOIN rep_deals rd ON rd.rep_id = u.id
     LEFT JOIN at_risk_counts arc ON arc.rep_id = u.id
     LEFT JOIN stale_accounts sa ON sa.rep_id = u.id
     LEFT JOIN activity a ON a.rep_id = u.id
     WHERE u.office_id = $4
       AND u.is_active = true
       AND u.role = 'rep'`,
    [
      period.kind,
      period.start,
      period.end,
      officeId,
      officeName,
      STALE_ACCOUNT_THRESHOLD_DAYS,
      JSON.stringify(atRiskCounts),
    ]
  );

  return insertResult.rowCount ?? 0;
}

export async function runRepPerformanceRollup(now = new Date()): Promise<number> {
  console.log("[Worker:rep-performance-rollup] Starting rep performance rollup...");

  const client = await pool.connect();
  try {
    const offices = await client.query(
      "SELECT id, slug, name FROM public.offices WHERE is_active = true ORDER BY name ASC"
    );
    const periods = buildRepPerformancePeriodRanges(now);
    let inserted = 0;

    for (const office of offices.rows) {
      const slug = String(office.slug ?? "");
      if (!/^[a-z][a-z0-9_]*$/.test(slug)) {
        console.error(`[Worker:rep-performance-rollup] Invalid office slug: "${slug}" - skipping`);
        continue;
      }

      const schemaName = `office_${slug}`;
      let officeInserted = 0;
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`rep-performance-rollup:${office.id}`]);
        for (const period of periods) {
          officeInserted += await refreshOfficePeriod(
            client,
            schemaName,
            String(office.id),
            String(office.name ?? "Unassigned"),
            period
          );
        }
        await client.query("COMMIT");
        inserted += officeInserted;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[Worker:rep-performance-rollup] Office ${office.id} failed:`, err);
      }
    }

    console.log(`[Worker:rep-performance-rollup] Inserted ${inserted} snapshot row(s)`);
    return inserted;
  } finally {
    client.release();
  }
}
