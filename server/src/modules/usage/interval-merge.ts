// server/src/modules/usage/interval-merge.ts
import { HEARTBEAT_INTERVAL_S, HEARTBEAT_GRACE_S } from "./constants.js";

/**
 * Compute active seconds from heartbeat timestamps (already filtered to non-impersonated
 * sessions). Each heartbeat at time t covers the window [t - HEARTBEAT_INTERVAL_S, t]; windows
 * separated by <= HEARTBEAT_GRACE_S are merged. Idle gaps larger than that are never credited,
 * and overlapping windows from multiple tabs are counted once.
 */
export function mergeActiveSeconds(heartbeatTimes: Date[]): number {
  if (heartbeatTimes.length === 0) return 0;

  const windows = heartbeatTimes
    .map((d) => {
      const end = Math.floor(d.getTime() / 1000);
      return { start: end - HEARTBEAT_INTERVAL_S, end };
    })
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let curStart = windows[0].start;
  let curEnd = windows[0].end;

  for (let i = 1; i < windows.length; i++) {
    const w = windows[i];
    if (w.start - curEnd <= HEARTBEAT_GRACE_S) {
      if (w.end > curEnd) curEnd = w.end;
    } else {
      total += curEnd - curStart;
      curStart = w.start;
      curEnd = w.end;
    }
  }
  total += curEnd - curStart;
  return total;
}
