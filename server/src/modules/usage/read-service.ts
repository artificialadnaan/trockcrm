// server/src/modules/usage/read-service.ts
import type { UsageDailyShape } from "./types.js";
import { computeUsageDaily } from "./aggregate.js";
import { fetchRawUsageForDay, type QueryClient } from "./raw-fetch.js";

export interface Requester { role: string; userId: string; }

/** Server-enforced scoping: reps are forced to self; admin/director may target one rep or all (null). */
export function resolveRepScope(req: Requester, requestedRep: string | undefined): string[] | null {
  if (req.role === "rep") return [req.userId];
  if (requestedRep) return [requestedRep];
  return null; // all reps
}

/** ISO dates (Mon..Sun) of the week containing `anchor` (YYYY-MM-DD), in UTC. */
export function weekDates(anchor: string): string[] {
  const d = new Date(`${anchor}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - dow);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + i);
    return day.toISOString().slice(0, 10);
  });
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
      `SELECT id, display_name FROM public.users WHERE id IN (${placeholders})`, scope,
    );
    return rows.map((r) => ({ id: r.id, displayName: r.display_name }));
  }
  const { rows } = await client.query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM public.users WHERE role = 'rep' AND is_active = true ORDER BY display_name`,
  );
  return rows.map((r) => ({ id: r.id, displayName: r.display_name }));
}

/** Read one rolled-up day; returns a zeroed shape when no usage_daily row exists (pre-launch days). */
export async function readUsageDaily(client: QueryClient, schema: string, userId: string, date: string): Promise<UsageDailyShape> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const { rows } = await client.query<{
    active_seconds: number; session_count: number; view_count: number; action_count: number;
    breakdown: UsageDailyShape["breakdown"]; first_active_at: string | null; last_active_at: string | null;
  }>(
    `SELECT active_seconds, session_count, view_count, action_count, breakdown, first_active_at, last_active_at
       FROM ${schema}.usage_daily WHERE user_id = $1 AND date = $2`,
    [userId, date],
  );
  const r = rows[0];
  if (!r) return { userId, date, activeSeconds: 0, sessionCount: 0, viewCount: 0, actionCount: 0, breakdown: ZERO_BREAKDOWN(), firstActiveAt: null, lastActiveAt: null };
  return {
    userId, date, activeSeconds: Number(r.active_seconds), sessionCount: Number(r.session_count),
    viewCount: Number(r.view_count), actionCount: Number(r.action_count),
    breakdown: r.breakdown, firstActiveAt: r.first_active_at, lastActiveAt: r.last_active_at,
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
