// server/src/modules/usage/aggregate.ts
import { mergeActiveSeconds } from "./interval-merge.js";
import { USAGE_ACTION_SOURCES } from "./action-sources.js";
import type { UsageRawInput, UsageDailyShape, UsageBreakdown } from "./types.js";

/**
 * Pure: fold one (user, date)'s raw rows into the usage_daily shape. Both the live "today"
 * read path and the nightly rollup call this, so a completed day reconciles byte-for-byte.
 * No I/O.
 */
export function computeUsageDaily(input: UsageRawInput): UsageDailyShape {
  // impersonation exclusion: time + views are scoped to non-impersonated sessions
  const realSessionIds = new Set(
    input.sessions.filter((s) => s.impersonatorId === null).map((s) => s.id),
  );

  // Heartbeats/views referencing a sessionId not in input.sessions are dropped; callers must include all of the day's sessions.
  const realHeartbeats = input.heartbeats.filter((h) => realSessionIds.has(h.sessionId));
  const activeSeconds = mergeActiveSeconds(realHeartbeats.map((h) => h.at));

  const heartbeatTimes = realHeartbeats.map((h) => h.at.getTime());
  const firstActiveAt = heartbeatTimes.length
    ? new Date(Math.min(...heartbeatTimes)).toISOString()
    : null;
  const lastActiveAt = heartbeatTimes.length
    ? new Date(Math.max(...heartbeatTimes)).toISOString()
    : null;

  const realViews = input.viewEvents.filter((v) => realSessionIds.has(v.sessionId));
  const breakdown: UsageBreakdown = {
    deal_views: 0, lead_views: 0, report_views: 0, page_views: 0,
    creates: 0, edits: 0, stage_moves: 0, uploads: 0, activities: {},
  };
  for (const v of realViews) {
    if (v.entityType === "deal") breakdown.deal_views++;
    else if (v.entityType === "lead") breakdown.lead_views++;
    else if (v.entityType === "report") breakdown.report_views++;
    else breakdown.page_views++;
  }
  const viewCount = realViews.length;

  // actions: multi-source per USAGE_ACTION_SOURCES
  // creates/edits from auditLog (impersonation-excludable)
  for (const row of input.auditRows) {
    if (row.impersonatorId !== null) continue;
    if (row.action === USAGE_ACTION_SOURCES.creates.auditAction) breakdown.creates++;
    else if (row.action === USAGE_ACTION_SOURCES.edits.auditAction) breakdown.edits++;
  }
  // stage_moves / uploads / activities — no impersonator column (documented caveat)
  breakdown.stage_moves = input.stageMoves.length;
  breakdown.uploads = input.uploads.length;
  const activityCounts: Record<string, number> = {};
  for (const a of input.activities) {
    activityCounts[a.type] = (activityCounts[a.type] ?? 0) + 1;
  }
  // Canonical (sorted) key order so the persisted JSON is byte-identical regardless of input order.
  breakdown.activities = Object.fromEntries(
    Object.keys(activityCounts).sort().map((k) => [k, activityCounts[k]]),
  );

  const activitiesTotal = Object.values(breakdown.activities).reduce((s, n) => s + n, 0);
  // Keep in sync with all breakdown action fields if a new action source is added.
  const actionCount =
    breakdown.creates + breakdown.edits + breakdown.stage_moves + breakdown.uploads + activitiesTotal;

  return {
    userId: input.userId,
    date: input.date,
    activeSeconds,
    sessionCount: realSessionIds.size,
    viewCount,
    actionCount,
    breakdown,
    firstActiveAt,
    lastActiveAt,
  };
}
