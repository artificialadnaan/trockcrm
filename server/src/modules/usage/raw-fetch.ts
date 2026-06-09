// server/src/modules/usage/raw-fetch.ts
import type { UsageRawInput } from "./types.js";
import { BUSINESS_TIMEZONE } from "../../lib/period.js";

/** A minimal pg-like client (works for both the request client and the rollup script client). */
export interface QueryClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Fetch one user+day's raw rows from a single tenant schema. Day bounds are [date, date+1) on the
 * relevant timestamp column. `schema` is a validated office_* identifier. Used by BOTH the live
 * read path and the nightly rollup.
 */
export async function fetchRawUsageForDay(
  client: QueryClient,
  schema: string,
  userId: string,
  date: string, // YYYY-MM-DD
): Promise<UsageRawInput> {
  if (!/^office_[a-z0-9_]+$/.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const s = schema;
  const dayStart = date;

  const sessions = (await client.query<{ id: string; impersonator_id: string | null }>(
    `SELECT id, impersonator_id FROM ${s}.usage_session
       WHERE user_id = $1
         AND (
           -- session started on this day (business tz)
           (started_at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND started_at < (($2::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}'))
           -- or session has a heartbeat on this day (handles NULL started_at)
           OR id IN (
             SELECT session_id FROM ${s}.usage_heartbeat
             WHERE user_id = $1 AND at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND at < (($2::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
           )
           -- or session has a view_event on this day
           OR id IN (
             SELECT session_id FROM ${s}.usage_view_event
             WHERE user_id = $1 AND at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND at < (($2::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
           )
         )`,
    [userId, dayStart],
  )).rows;

  const heartbeats = (await client.query<{ session_id: string; at: string }>(
    `SELECT session_id, at FROM ${s}.usage_heartbeat
       WHERE user_id = $1 AND at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND at < (($2::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
       ORDER BY at`,
    [userId, dayStart],
  )).rows;

  const viewEvents = (await client.query<{ session_id: string; at: string; entity_type: string }>(
    `SELECT session_id, at, entity_type FROM ${s}.usage_view_event
       WHERE user_id = $1 AND at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND at < (($2::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')`,
    [userId, dayStart],
  )).rows;

  const auditRows = (await client.query<{ action: string; table_name: string; created_at: string; impersonator_id: string | null }>(
    `SELECT action, table_name, created_at, impersonator_id FROM ${s}.audit_log
       WHERE changed_by = $1
         AND table_name NOT IN ('activities', 'files')
         AND NOT (table_name = 'deals' AND changes IS NOT NULL AND changes ? 'stage_id')
         AND created_at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND created_at < (($2::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')`,
    [userId, dayStart],
  )).rows;

  const stageMoves = (await client.query<{ created_at: string }>(
    `SELECT created_at FROM ${s}.deal_stage_history
       WHERE changed_by = $1 AND created_at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND created_at < (($2::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')`,
    [userId, dayStart],
  )).rows;

  const activities = (await client.query<{ type: string; at: string }>(
    `SELECT type, COALESCE(occurred_at, created_at) AS at FROM ${s}.activities
       WHERE COALESCE(performed_by_user_id, responsible_user_id) = $1
         AND COALESCE(occurred_at, created_at) >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
         AND COALESCE(occurred_at, created_at) < (($2::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')`,
    [userId, dayStart],
  )).rows;

  const uploads = (await client.query<{ at: string }>(
    `SELECT created_at AS at FROM ${s}.files
       WHERE uploaded_by = $1 AND created_at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}') AND created_at < (($2::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')`,
    [userId, dayStart],
  )).rows;

  return {
    userId,
    date,
    sessions: sessions.map((r) => ({ id: r.id, impersonatorId: r.impersonator_id })),
    heartbeats: heartbeats.map((r) => ({ sessionId: r.session_id, at: new Date(r.at) })),
    viewEvents: viewEvents.map((r) => ({ sessionId: r.session_id, at: new Date(r.at), entityType: r.entity_type })),
    auditRows: auditRows.map((r) => ({ action: r.action, tableName: r.table_name, createdAt: new Date(r.created_at), impersonatorId: r.impersonator_id })),
    stageMoves: stageMoves.map((r) => ({ createdAt: new Date(r.created_at) })),
    activities: activities.map((r) => ({ type: r.type, at: new Date(r.at) })),
    uploads: uploads.map((r) => ({ at: new Date(r.at) })),
  };
}
