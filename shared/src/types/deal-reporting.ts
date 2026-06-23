import { CLOSE_TARGET_HOLD_HORIZON_DAYS } from "./deal-hold-risk.js";

type DealReportabilityLike = {
  onHold?: boolean | null;
};

const SQL_IDENTIFIER_PATH = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

// The America/Chicago "today" anchor — the SAME boundary the forecast SQL and the at-risk close-target
// rule use, so the On Hold filter and the forecast never disagree by a day.
const CT_TODAY_SQL = "(now() AT TIME ZONE 'America/Chicago')::date";

export function isDealActivelyOnHold(deal: DealReportabilityLike): boolean {
  return deal.onHold === true;
}

export function isReportableDeal(deal: DealReportabilityLike): boolean {
  return !isDealActivelyOnHold(deal);
}

export function reportableDealSqlPredicate(identifierPath?: string): string {
  if (!identifierPath) {
    return "COALESCE(on_hold, false) = false";
  }

  if (!SQL_IDENTIFIER_PATH.test(identifierPath)) {
    throw new Error(`Invalid reportable deal SQL identifier: ${identifierPath}`);
  }

  return `COALESCE(${identifierPath}.on_hold, false) = false`;
}

/**
 * "Effectively on hold" = the stored `on_hold` flag OR a close target far enough out (more than
 * CLOSE_TARGET_HOLD_HORIZON_DAYS CT-days) that the deal is treated as parked. This is what the deals
 * "On Hold" filter pill matches; the horizon constant is shared with the at-risk module so the SQL day
 * boundary and the TS day-math can never drift. Pure string builder (no drizzle dep), consumed via
 * `sql.raw` like reportableDealSqlPredicate.
 */
export function effectiveOnHoldSqlPredicate(identifierPath?: string): string {
  if (identifierPath && !SQL_IDENTIFIER_PATH.test(identifierPath)) {
    throw new Error(`Invalid effective on-hold SQL identifier: ${identifierPath}`);
  }
  const onHold = identifierPath ? `${identifierPath}.on_hold` : "on_hold";
  const closeDate = identifierPath ? `${identifierPath}.expected_close_date` : "expected_close_date";
  const farOut =
    `${closeDate} IS NOT NULL AND ` +
    `${closeDate} > ${CT_TODAY_SQL} + INTERVAL '${CLOSE_TARGET_HOLD_HORIZON_DAYS} days'`;
  return `(COALESCE(${onHold}, false) = true OR (${farOut}))`;
}
