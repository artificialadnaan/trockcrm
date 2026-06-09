// server/src/scripts/usage-rollup.ts
import pg from "pg";
import { fetchRawUsageForDay, type QueryClient } from "../modules/usage/raw-fetch.js";
import { computeUsageDaily } from "../modules/usage/aggregate.js";
import { RAW_RETENTION_DAYS } from "../modules/usage/constants.js";
import { businessToday, shiftBusinessDate, BUSINESS_TIMEZONE } from "../lib/period.js";

const SCHEMA_RE = /^office_[a-z0-9_]+$/;

/** Roll up one completed day for one office: fold each active user and upsert usage_daily. */
export async function rollupOfficeDay(client: QueryClient, schema: string, date: string): Promise<void> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const { rows: users } = await client.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM (
        SELECT user_id FROM ${schema}.usage_session  WHERE started_at >= ($1::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND started_at < (($1::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        UNION SELECT changed_by FROM ${schema}.audit_log WHERE table_name NOT IN ('activities', 'files') AND created_at >= ($1::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND created_at < (($1::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        UNION SELECT changed_by FROM ${schema}.deal_stage_history WHERE created_at >= ($1::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND created_at < (($1::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        UNION SELECT COALESCE(performed_by_user_id, responsible_user_id) FROM ${schema}.activities WHERE COALESCE(occurred_at, created_at) >= ($1::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND COALESCE(occurred_at, created_at) < (($1::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        UNION SELECT uploaded_by FROM ${schema}.files WHERE created_at >= ($1::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND created_at < (($1::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        UNION SELECT user_id FROM ${schema}.usage_heartbeat WHERE at >= ($1::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND at < (($1::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        UNION SELECT user_id FROM ${schema}.usage_view_event WHERE at >= ($1::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND at < (($1::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
      ) u WHERE user_id IS NOT NULL`,
    [date],
  );

  for (const { user_id } of users) {
    const raw = await fetchRawUsageForDay(client, schema, user_id, date);
    const shape = computeUsageDaily(raw);
    await client.query(
      `INSERT INTO ${schema}.usage_daily
         (user_id, date, active_seconds, session_count, view_count, action_count, breakdown, first_active_at, last_active_at, rolled_up_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9, now())
       ON CONFLICT (user_id, date) DO UPDATE SET
         active_seconds=EXCLUDED.active_seconds, session_count=EXCLUDED.session_count,
         view_count=EXCLUDED.view_count, action_count=EXCLUDED.action_count,
         breakdown=EXCLUDED.breakdown, first_active_at=EXCLUDED.first_active_at,
         last_active_at=EXCLUDED.last_active_at, rolled_up_at=now()`,
      [shape.userId, shape.date, shape.activeSeconds, shape.sessionCount, shape.viewCount,
       shape.actionCount, JSON.stringify(shape.breakdown), shape.firstActiveAt, shape.lastActiveAt],
    );
  }
}

/**
 * Gated prune: delete raw heartbeats/view-events only for days that (a) have a usage_daily
 * rolled-up row and (b) are older than RAW_RETENTION_DAYS relative to `asOf`.
 */
export async function pruneRolledUpRaw(client: QueryClient, schema: string, asOf: string): Promise<void> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  for (const table of ["usage_heartbeat", "usage_view_event"]) {
    await client.query(
      `DELETE FROM ${schema}.${table} raw
        WHERE raw.at < (($1::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') - ($2 || ' days')::interval)
          AND EXISTS (
            SELECT 1 FROM ${schema}.usage_daily d
             WHERE d.user_id = raw.user_id AND d.date = (raw.at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date
          )`,
      [asOf, String(RAW_RETENTION_DAYS)],
    );
  }
}

/** Entry point: fan out across all office schemas. */
export async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pgClient = new pg.Client({ connectionString });
  await pgClient.connect();
  const client: QueryClient = { query: (sql, params) => pgClient.query(sql, params as unknown[]) as any };
  try {
    const { rows: schemas } = await client.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'office_%' ORDER BY schema_name`,
    );
    const today = businessToday();
    let anyFailed = false;
    for (const { schema_name } of schemas) {
      if (!SCHEMA_RE.test(schema_name)) continue;
      // Re-roll the entire retained window so any missed/late cron day self-heals.
      // rollupOfficeDay is an idempotent upsert, so re-rolling is always safe.
      try {
        for (let i = 1; i <= RAW_RETENTION_DAYS; i++) {
          await rollupOfficeDay(client, schema_name, shiftBusinessDate(today, -i));
        }
        await pruneRolledUpRaw(client, schema_name, today);
      } catch (err) {
        anyFailed = true;
        console.error(`[usage-rollup] failed for ${schema_name}:`, err);
      }
    }
    if (anyFailed) throw new Error("usage-rollup: one or more offices failed (see logs above)");
  } finally {
    await pgClient.end();
  }
}

// Allow direct execution as compiled JS or TS source.
if (process.argv[1] && /usage-rollup\.(?:js|ts)$/.test(process.argv[1])) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
