// server/src/modules/usage/read-service.ts
import type { UsageDailyShape } from "./types.js";
import { computeUsageDaily } from "./aggregate.js";
import { fetchRawUsageForDay, type QueryClient } from "./raw-fetch.js";
import { RAW_RETENTION_DAYS } from "./constants.js";
import { businessWeekDates, BUSINESS_TIMEZONE } from "../../lib/period.js";

export interface Requester { role: string; userId: string; }

/** Server-enforced scoping: reps are forced to self; admin/director may target one rep or all (null). */
export function resolveRepScope(req: Requester, requestedRep: string | undefined): string[] | null {
  if (req.role === "rep") return [req.userId];
  if (requestedRep) return [requestedRep];
  return null; // all reps
}

/** The 7 dates (Sun..Sat) of the canonical business week containing `anchor`. Matches period.ts. */
export function weekDates(anchor: string): string[] {
  return businessWeekDates(anchor);
}

/** The live "today" caller: fetch raw rows + fold. */
export async function buildLiveDay(
  client: QueryClient, schema: string, userId: string, date: string,
): Promise<UsageDailyShape> {
  const raw = await fetchRawUsageForDay(client, schema, userId, date);
  return computeUsageDaily(raw);
}

/** Sum a set of daily shapes into one (used for weekly grain). */
export function sumDays(userId: string, label: string, days: UsageDailyShape[]): UsageDailyShape {
  const acc: UsageDailyShape = {
    userId, date: label, activeSeconds: 0, sessionCount: 0, viewCount: 0, actionCount: 0,
    breakdown: { deal_views: 0, lead_views: 0, report_views: 0, page_views: 0, creates: 0, edits: 0, stage_moves: 0, uploads: 0, activities: {} },
    firstActiveAt: null, lastActiveAt: null,
  };
  let hasTime = false;
  const activityAcc: Record<string, number> = {};
  for (const d of days) {
    acc.activeSeconds += d.activeSeconds;
    acc.sessionCount += d.sessionCount;
    acc.viewCount += d.viewCount;
    acc.actionCount += d.actionCount;
    acc.breakdown.deal_views += d.breakdown.deal_views;
    acc.breakdown.lead_views += d.breakdown.lead_views;
    acc.breakdown.report_views += d.breakdown.report_views;
    acc.breakdown.page_views += d.breakdown.page_views;
    acc.breakdown.creates += d.breakdown.creates;
    acc.breakdown.edits += d.breakdown.edits;
    acc.breakdown.stage_moves += d.breakdown.stage_moves;
    acc.breakdown.uploads += d.breakdown.uploads;
    for (const [k, v] of Object.entries(d.breakdown.activities)) {
      activityAcc[k] = (activityAcc[k] ?? 0) + v;
    }
    if (d.firstActiveAt) { hasTime = true; if (!acc.firstActiveAt || d.firstActiveAt < acc.firstActiveAt) acc.firstActiveAt = d.firstActiveAt; }
    if (d.lastActiveAt) { if (!acc.lastActiveAt || d.lastActiveAt > acc.lastActiveAt) acc.lastActiveAt = d.lastActiveAt; }
  }
  // Canonical (sorted) activity key order — byte-identical-friendly, matches computeUsageDaily.
  acc.breakdown.activities = Object.fromEntries(Object.keys(activityAcc).sort().map((k) => [k, activityAcc[k]]));
  // Leaderboard time-sort treats "no data" as absent: keep activeSeconds 0 but null timestamps.
  if (!hasTime) { acc.firstActiveAt = null; acc.lastActiveAt = null; }
  return acc;
}

const SCHEMA_RE = /^office_[a-z0-9_]+$/;
export interface RepRef { id: string; displayName: string; }

const ZERO_BREAKDOWN = () => ({
  deal_views: 0, lead_views: 0, report_views: 0, page_views: 0,
  creates: 0, edits: 0, stage_moves: 0, uploads: 0, activities: {} as Record<string, number>,
});

/** Resolve the rep roster for the request. scope=null → all active reps; else exactly those ids. */
export async function resolveReps(client: QueryClient, scope: string[] | null): Promise<RepRef[]> {
  if (scope) {
    if (scope.length === 0) return [];
    const placeholders = scope.map((_, i) => `$${i + 1}`).join(",");
    const { rows } = await client.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM public.users WHERE id IN (${placeholders}) AND role = 'rep' AND is_active = true AND COALESCE(is_test_data, false) = false`, scope,
    );
    return rows.map((r) => ({ id: r.id, displayName: r.display_name }));
  }
  const { rows } = await client.query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM public.users WHERE role = 'rep' AND is_active = true AND COALESCE(is_test_data, false) = false ORDER BY display_name`,
  );
  return rows.map((r) => ({ id: r.id, displayName: r.display_name }));
}

/** Read one rolled-up day; returns a zeroed shape when no usage_daily row exists (pre-launch days). */
export async function readUsageDaily(client: QueryClient, schema: string, userId: string, date: string): Promise<UsageDailyShape> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const { rows } = await client.query<{
    active_seconds: number; session_count: number; view_count: number; action_count: number;
    breakdown: UsageDailyShape["breakdown"]; first_active_at: Date | null; last_active_at: Date | null;
  }>(
    `SELECT active_seconds, session_count, view_count, action_count, breakdown, first_active_at, last_active_at
       FROM ${schema}.usage_daily WHERE user_id = $1 AND date = $2`,
    [userId, date],
  );
  const r = rows[0];
  if (!r) return { userId, date, activeSeconds: 0, sessionCount: 0, viewCount: 0, actionCount: 0, breakdown: ZERO_BREAKDOWN(), firstActiveAt: null, lastActiveAt: null };
  // Normalize breakdown key order to match computeUsageDaily's canonical insertion order.
  // Postgres JSONB may return keys in alphabetical/storage order; the byte-identical invariant
  // requires readUsageDaily to reconstruct them in the same sequence computeUsageDaily uses.
  const bd = r.breakdown;
  const normalizedBreakdown: UsageDailyShape["breakdown"] = {
    deal_views: Number(bd.deal_views),
    lead_views: Number(bd.lead_views),
    report_views: Number(bd.report_views),
    page_views: Number(bd.page_views),
    creates: Number(bd.creates),
    edits: Number(bd.edits),
    stage_moves: Number(bd.stage_moves),
    uploads: Number(bd.uploads),
    activities: Object.fromEntries(Object.keys(bd.activities ?? {}).sort().map((k) => [k, Number(bd.activities[k])])),
  };
  return {
    userId, date, activeSeconds: Number(r.active_seconds), sessionCount: Number(r.session_count),
    viewCount: Number(r.view_count), actionCount: Number(r.action_count),
    breakdown: normalizedBreakdown,
    firstActiveAt: r.first_active_at ? new Date(r.first_active_at).toISOString() : null,
    lastActiveAt: r.last_active_at ? new Date(r.last_active_at).toISOString() : null,
  };
}

/** Team summary strip. "active today" := activeSeconds > 0 (>=1 heartbeat) — applied consistently. */
export function buildTeamSummary(rows: { rep: RepRef; usage: UsageDailyShape }[]) {
  let activeSeconds = 0, actionCount = 0, activeReps = 0;
  for (const { usage } of rows) {
    activeSeconds += usage.activeSeconds;
    actionCount += usage.actionCount;
    if (usage.activeSeconds > 0) activeReps++;
  }
  return { activeSeconds, actionCount, activeReps, totalReps: rows.length };
}

/** Classify a report date relative to today (all YYYY-MM-DD; lexicographic == chronological). */
export function resolveDayKind(date: string, today: string): "past" | "live" | "future" {
  if (date < today) return "past";
  if (date > today) return "future";
  return "live";
}

/** A canonical zeroed day shape (no DB query) — used for future dates in the current week. */
export function emptyUsageDay(userId: string, date: string): UsageDailyShape {
  return { userId, date, activeSeconds: 0, sessionCount: 0, viewCount: 0, actionCount: 0, breakdown: ZERO_BREAKDOWN(), firstActiveAt: null, lastActiveAt: null };
}

/** Returns true when `date` falls within the raw-event retention window (0..RAW_RETENTION_DAYS-1 days old). */
export function isWithinDrilldownWindow(date: string, today: string): boolean {
  const ms = new Date(`${today}T00:00:00Z`).getTime() - new Date(`${date}T00:00:00Z`).getTime();
  const days = Math.floor(ms / 86_400_000);
  return days >= 0 && days < RAW_RETENTION_DAYS;
}

/**
 * The latest period date that is not in the future, for the views retention check. A current week's
 * range includes a future Saturday; `isWithinDrilldownWindow` treats future dates as out-of-window,
 * which would wrongly mark the current week's views "expired". Clamp to the newest non-future day
 * (today, for the current week) so only genuinely-old periods read as expired.
 */
export function latestNonFutureDate(dates: string[], today: string): string {
  const past = dates.filter((d) => d <= today);
  return past.length > 0 ? past[past.length - 1] : dates[0];
}

export interface ViewEventRow {
  at: string;
  entity_type: string;
  entity_id: string | null;
  route: string;
  label_snapshot: string | null;
}

/** Raw view events for one user+day, optionally filtered by entity_type, ordered chronologically. */
export async function readViewEvents(
  client: QueryClient,
  schema: string,
  userId: string,
  date: string,
  type?: string,
): Promise<ViewEventRow[]> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const params: unknown[] = [userId, date];
  let typeClause = "";
  if (type) { params.push(type); typeClause = ` AND v.entity_type = $3`; }
  const { rows } = await client.query<ViewEventRow>(
    `SELECT v.at, v.entity_type, v.entity_id, v.route, v.label_snapshot
       FROM ${schema}.usage_view_event v
       JOIN ${schema}.usage_session s ON s.id = v.session_id AND s.user_id = v.user_id
      WHERE v.user_id = $1
        AND s.impersonator_id IS NULL
        AND v.at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        AND v.at < (($2::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')${typeClause}
      ORDER BY v.at`,
    params,
  );
  return rows;
}

/**
 * Raw view events for a user over the half-open business-tz range [fromDate, toExclusiveDate),
 * newest first. Reuses the same impersonation + ownership join as the single-day drilldown; used
 * by the rep-detail page so a week's views come back in one query.
 */
export async function readViewEventsRange(
  client: QueryClient,
  schema: string,
  userId: string,
  fromDate: string,
  toExclusiveDate: string,
): Promise<ViewEventRow[]> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const { rows } = await client.query<ViewEventRow>(
    `SELECT v.at, v.entity_type, v.entity_id, v.route, v.label_snapshot
       FROM ${schema}.usage_view_event v
       JOIN ${schema}.usage_session s ON s.id = v.session_id AND s.user_id = v.user_id
      WHERE v.user_id = $1
        AND s.impersonator_id IS NULL
        AND v.at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        AND v.at < ($3::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
      ORDER BY v.at DESC`,
    [userId, fromDate, toExclusiveDate],
  );
  return rows;
}

export type ActionDetailType = "create" | "edit" | "stage_move" | "upload" | "note";

export interface ActionDetailItem {
  type: ActionDetailType;
  label: string;
  entityType: string | null;
  at: string;
}

export interface ActionDetail {
  breakdown: Record<ActionDetailType, number>;
  items: ActionDetailItem[];
  truncated: boolean;
}

const ACTION_DETAIL_LIMIT = 500;

/** Classify an audit_log row into one of the five detail buckets. Pure — exported for testing. */
export function classifyAction(tableName: string, action: string, isStage: boolean): ActionDetailType {
  if (tableName === "activities") return "note";
  if (tableName === "files") return "upload";
  if (isStage) return "stage_move";
  return action === "insert" ? "create" : "edit";
}

// Detail actions mirror the AGGREGATE's action sources so the breakdown reconciles with the
// leaderboard's action count:
//  - creates/edits  -> non-activities/files inserts+updates in audit_log, EXCLUDING stage updates
//  - stage_move     -> deal_stage_history (one row per change; the aggregate's source). Sourcing from
//                      audit would double-count: a stage change writes BOTH a trigger row (changes
//                      .stage_id) and an explicit logActivity row (changes.stageId).
//  - upload / note  -> activities/files INSERTS only (the aggregate counts those source tables once;
//                      their audit UPDATES are metadata edits, NOT new upload/note actions)
//  - impersonated writes are excluded (impersonator_id IS NULL), matching the aggregate and the views.
//    deal_stage_history has no impersonator column (documented aggregate caveat), so stage moves are
//    not impersonation-filtered either — consistent with the rollup.
const IS_STAGE_SQL =
  `(al.table_name = 'deals' AND al.changes IS NOT NULL AND (al.changes ? 'stage_id' OR al.changes ? 'stageId'))`;
const AUDIT_DETAIL_WHERE = `al.changed_by = $1
        AND al.impersonator_id IS NULL
        AND NOT ${IS_STAGE_SQL}
        AND (
          (al.table_name IN ('activities', 'files') AND al.action = 'insert')
          OR (al.table_name NOT IN ('activities', 'files') AND al.action IN ('insert', 'update'))
        )
        AND al.created_at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        AND al.created_at < ($3::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')`;
const STAGE_DETAIL_WHERE = `sh.changed_by = $1
        AND sh.created_at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        AND sh.created_at < ($3::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')`;

/**
 * Itemized actions for a user over [fromDate, toExclusiveDate) (business-tz), newest first, plus a
 * by-type breakdown. Audit rows are NOT pruned, so this is always available regardless of period age
 * (unlike views). creates/edits/uploads/notes from audit_log; stage moves from deal_stage_history.
 */
export async function readActionDetail(
  client: QueryClient,
  schema: string,
  userId: string,
  fromDate: string,
  toExclusiveDate: string,
): Promise<ActionDetail> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const params = [userId, fromDate, toExclusiveDate];

  // Breakdown over the FULL period (never truncated) so the chips reconcile with the leaderboard.
  const auditCounts = (
    await client.query<{ c_create: number; c_edit: number; c_upload: number; c_note: number }>(
      `SELECT
          count(*) FILTER (WHERE al.action = 'insert' AND al.table_name NOT IN ('activities', 'files'))::int AS c_create,
          count(*) FILTER (WHERE al.action = 'update' AND al.table_name NOT IN ('activities', 'files'))::int AS c_edit,
          count(*) FILTER (WHERE al.table_name = 'files')::int AS c_upload,
          count(*) FILTER (WHERE al.table_name = 'activities')::int AS c_note
         FROM ${schema}.audit_log al
        WHERE ${AUDIT_DETAIL_WHERE}`,
      params,
    )
  ).rows[0];
  const stageCount = Number(
    (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${schema}.deal_stage_history sh WHERE ${STAGE_DETAIL_WHERE}`, params)).rows[0]?.n ?? 0,
  );
  const breakdown: Record<ActionDetailType, number> = {
    create: Number(auditCounts?.c_create ?? 0),
    edit: Number(auditCounts?.c_edit ?? 0),
    stage_move: stageCount,
    upload: Number(auditCounts?.c_upload ?? 0),
    note: Number(auditCounts?.c_note ?? 0),
  };

  // Itemized display: audit items + stage-history items, merged newest-first, capped. (The chips
  // above stay full-period accurate even when the list is truncated.)
  const auditRows = (
    await client.query<{ action: string; table_name: string; entity_type: string | null; created_at: string; label: string | null }>(
      `SELECT al.action, al.table_name, al.entity_type, al.created_at,
              COALESCE(al.entity_name_snapshot, d.name, l.name, al.entity_type, al.table_name) AS label
         FROM ${schema}.audit_log al
         LEFT JOIN ${schema}.deals d ON al.table_name = 'deals' AND al.record_id = d.id
         LEFT JOIN ${schema}.leads l ON al.table_name = 'leads' AND al.record_id = l.id
        WHERE ${AUDIT_DETAIL_WHERE}
        ORDER BY al.created_at DESC
        LIMIT ${ACTION_DETAIL_LIMIT + 1}`,
      params,
    )
  ).rows;
  const stageRows = (
    await client.query<{ created_at: string; label: string | null }>(
      `SELECT sh.created_at, d.name AS label
         FROM ${schema}.deal_stage_history sh
         LEFT JOIN ${schema}.deals d ON sh.deal_id = d.id
        WHERE ${STAGE_DETAIL_WHERE}
        ORDER BY sh.created_at DESC
        LIMIT ${ACTION_DETAIL_LIMIT + 1}`,
      params,
    )
  ).rows;

  const merged: ActionDetailItem[] = [
    ...auditRows.map((r) => ({
      type: classifyAction(r.table_name, r.action, false),
      label: r.label ?? r.table_name,
      entityType: r.entity_type,
      at: r.created_at,
    })),
    ...stageRows.map((r) => ({
      type: "stage_move" as ActionDetailType,
      label: r.label ?? "Stage move",
      entityType: "deal" as string | null,
      at: r.created_at,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const truncated = merged.length > ACTION_DETAIL_LIMIT;
  const items = merged.slice(0, ACTION_DETAIL_LIMIT);
  return { breakdown, items, truncated };
}
