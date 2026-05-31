// Reports Part 4 -- B·1 Rep 1:1 Pack. ONE rep across the board: their Won/Sent/Estimating slice (lifted
// straight from the showcase payload so it reconciles to the office numbers), their projection ladder and
// active leads, plus their own 8-week trend (the SAME computeWeeklyTrend the office uses, rep-scoped). No
// new sources of truth -- a per-rep re-presentation of the canonical foundations; every figure drills.

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import {
  getMondayShowcaseData,
  computeWeeklyTrend,
  type ShowcasePeriod,
  type RepShowcaseRow,
  type ShowcaseWeek,
} from "./monday-showcase-service.js";
import type { WeekMode } from "../../lib/period.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface RepPackData {
  period: ShowcasePeriod;
  /** the selected rep's slice of the canonical showcase payload (closed / projection / sent / leads). */
  rep: RepShowcaseRow;
  /** this rep's own 8-week estimating/sent/won trend. */
  trend: ShowcaseWeek[];
  /** selector options -- the reps with activity this period (a 1:1 pack is for a person, not Unassigned). */
  allReps: Array<{ repId: string; repName: string }>;
}

export interface RepPackOptions {
  /** which rep; defaults to the top rep by closed value when omitted. */
  repId?: string;
  mode?: WeekMode;
  now?: Date;
}

/**
 * Build the 1:1 pack for one rep. Reuses getMondayShowcaseData for the rep's reconciling slice + the
 * selector list, then computes the rep-scoped 8-week trend. Returns null when there are no reps with
 * activity, or the requested rep has none this period (the page shows an empty state).
 */
export async function getRepPackData(tenantDb: TenantDb, options: RepPackOptions = {}): Promise<RepPackData | null> {
  const mode: WeekMode = options.mode ?? "to_date";
  const showcase = await getMondayShowcaseData(tenantDb, { mode, now: options.now });

  // reps[] is already sorted by closed value desc; keep only the named reps for the picker.
  const namedReps = showcase.reps.filter((r): r is RepShowcaseRow & { repId: string } => r.repId != null);
  const allReps = namedReps.map((r) => ({ repId: r.repId, repName: r.repName }));
  if (allReps.length === 0) return null;

  const targetId = options.repId ?? allReps[0].repId;
  const rep = namedReps.find((r) => r.repId === targetId);
  if (!rep) return null;

  const trend = await computeWeeklyTrend(tenantDb, {
    from: showcase.period.from,
    to: showcase.period.to,
    repId: targetId,
  });

  return { period: showcase.period, rep, trend, allReps };
}
