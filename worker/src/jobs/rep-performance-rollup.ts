import { pool } from "../db.js";

export const STALE_ACCOUNT_THRESHOLD_DAYS = 30;

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
               d.created_at::date <= $3::date
               AND (
                  COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) IS NULL
                  OR COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) >= $2::date
               )
             ELSE d.is_active = true AND NOT psc.is_terminal
           END
         )::int AS deals_count,
         COALESCE(SUM(COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0))
           FILTER (
             WHERE CASE
               -- Historical pipeline_value follows the same deterministic
               -- lifecycle-only rule as historical deals_count above.
               WHEN $1::text IN ('last_month', 'last_quarter', 'last_year') THEN
                 d.created_at::date <= $3::date
                 AND (
                   COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) IS NULL
                   OR COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) >= $2::date
                 )
               ELSE d.is_active = true AND NOT psc.is_terminal AND psc.is_active_pipeline
             END
           ), 0)::numeric AS pipeline_value,
         COUNT(*) FILTER (
           WHERE psc.slug IN ('won', 'sent_to_production', 'service_sent_to_production', 'closed_won')
             AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.updated_at::date) >= $2::date
             AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.updated_at::date) <= $3::date
         )::int AS wins_count,
         COUNT(*) FILTER (
           WHERE psc.slug IN ('lost', 'production_lost', 'service_lost', 'closed_lost')
             AND COALESCE(d.actual_close_date, d.lost_at::date, d.updated_at::date) >= $2::date
             AND COALESCE(d.actual_close_date, d.lost_at::date, d.updated_at::date) <= $3::date
         )::int AS losses_count,
         COALESCE(SUM(COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0))
           FILTER (
             WHERE psc.slug IN ('won', 'sent_to_production', 'service_sent_to_production', 'closed_won')
               AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.updated_at::date) >= $2::date
               AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.updated_at::date) <= $3::date
           ), 0)::numeric AS closed_value,
         COALESCE(ROUND(AVG(
           COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date)
             - d.created_at::date
         ) FILTER (
           WHERE psc.slug IN (
               'won',
               'sent_to_production',
               'service_sent_to_production',
               'closed_won',
               'lost',
               'production_lost',
               'service_lost',
               'closed_lost'
             )
             AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) >= $2::date
             AND COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) <= $3::date
         ), 2), 0)::numeric AS avg_days_to_close,
         COUNT(*) FILTER (
           WHERE d.is_active = true
             AND NOT psc.is_terminal
             AND psc.stale_threshold_days IS NOT NULL
             AND d.stage_entered_at < $3::timestamptz - (psc.stale_threshold_days || ' days')::interval
         )::int AS at_risk_count
       FROM ${schemaName}.deals d
       JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
       GROUP BY d.assigned_rep_id
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
       COALESCE(rd.at_risk_count, 0),
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
     LEFT JOIN stale_accounts sa ON sa.rep_id = u.id
     LEFT JOIN activity a ON a.rep_id = u.id
     WHERE u.office_id = $4
       AND u.is_active = true
       AND u.role = 'rep'`,
    [period.kind, period.start, period.end, officeId, officeName, STALE_ACCOUNT_THRESHOLD_DAYS]
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
