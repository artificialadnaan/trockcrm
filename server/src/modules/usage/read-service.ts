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
