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
  for (const a of input.activities) {
    breakdown.activities[a.type] = (breakdown.activities[a.type] ?? 0) + 1;
  }

  const activitiesTotal = Object.values(breakdown.activities).reduce((s, n) => s + n, 0);
  const actionCount =
    breakdown.creates + breakdown.edits + breakdown.stage_moves + breakdown.uploads + activitiesTotal;

  return {
    userId: input.userId,
    date: input.date,
    activeSeconds,
    sessionCount: input.sessions.length,
    viewCount,
    actionCount,
    breakdown,
    firstActiveAt,
    lastActiveAt,
  };
}
