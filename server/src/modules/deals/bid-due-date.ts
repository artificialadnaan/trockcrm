import { isBidBoardDueDateReadbackEnabled } from "../../config/feature-flags.js";

/**
 * THE one place a deal's bid due date is resolved from its three possible sources, so the deal-detail
 * banner, the resolved-fields/scoping surface and the RFP payload can never disagree about it.
 *
 * Precedence: Bid Board mirror -> source lead (when the deal is lead-backed) -> the deal's own column.
 *
 * WHY THE MIRROR IS READ DIRECTLY, not inferred from the deal column: `deals.bid_board_due_date` IS the
 * Bid Board's answer (the ingest mirror writes it on every sync). Guessing provenance from
 * `deals.bid_due_date` — "it looks bid-board-shaped, so it probably came from the board" — would make the
 * rule dishonest the first time a rep hand-edited the field.
 *
 * WHY THE RULE MATTERS BEYOND DISPLAY: since 2026-07-27 `deals.bid_due_date` is the auto-park HORIZON for
 * genuine estimating-stage deals ([[deal-hold-risk]] resolveHoldHorizonDay and its SQL twin
 * holdHorizonDateSql in [[deal-reporting]]). A horizon more than CLOSE_TARGET_HOLD_HORIZON_DAYS (90)
 * CT-days out makes a deal effectively on hold, which ZEROES its value on cards, dashboards, at-risk
 * counts and the worker rollups. So this resolver moves reported dollars, which is why every read site
 * goes through `resolveDealBidDueDateForRead` (flag-gated) and never the raw resolver.
 */

/** Which of the three sources supplied the resolved value (or would have, when all three are empty). */
export type DealBidDueDateSource = "bid_board" | "lead" | "deal";

export interface DealBidDueDateInput {
  /**
   * `deals.bid_board_due_date` — the Bid Board export's Due Date, mirrored on every sync. A date-only
   * column, so node-pg/Drizzle hand it back as "YYYY-MM-DD".
   */
  bidBoardDueDate?: Date | string | null;
  /**
   * Whether the deal has a source lead AT ALL — deliberately NOT "whether that lead has a bid due date".
   * A lead-backed deal's CLEARED (null) lead value must still beat the deal column: the lead owns the
   * field (DEAL_FIELD_OWNERSHIP.bidDueDate === "lead") and the deal column is only a compatibility
   * snapshot, so a deliberate clear must not be masked by a stale pre-write-through mirror.
   */
  hasSourceLead: boolean;
  /** `leads.bid_due_date` — a date-only column ("YYYY-MM-DD"). */
  leadBidDueDate?: Date | string | null;
  /** `deals.bid_due_date` — a timestamptz stored at UTC midnight (migration 0132). */
  dealBidDueDate?: Date | string | null;
}

export interface ResolvedDealBidDueDate {
  /**
   * The resolved value as a date-only "YYYY-MM-DD" calendar day, or null. This is the comparison /
   * date-math form and the shape the resolved-fields consumers guard on (`typeof === "string"`).
   */
  day: string | null;
  /**
   * The winning source's value EXACTLY AS STORED — a date-only string for the mirror and the lead, a
   * `Date` for `deals.bid_due_date`. Present so a caller that already publishes the raw column shape on
   * the wire (getDealDetail) keeps doing so byte-for-byte instead of silently narrowing an ISO instant to
   * a date-only string for every non-lead-backed deal the moment this resolver is introduced.
   */
  raw: Date | string | null;
  source: DealBidDueDateSource;
}

/**
 * Normalize any bid-due-date value to its "YYYY-MM-DD" calendar day, or null when absent/unparseable.
 *
 * `deals.bid_due_date` is a timestamptz pinned to UTC midnight, so the UTC calendar day is the business
 * day — matching the SQL twin's `(bid_due_date AT TIME ZONE 'UTC')::date`. Reading it locally would land
 * on the PREVIOUS day anywhere west of UTC, which for an estimating deal flips the auto-park verdict and
 * therefore the deal's dollar value.
 *
 * An exact date-only string is returned verbatim rather than round-tripped through `Date`: that is what
 * the lead column and the Bid Board mirror already are, and a timestamptz string carrying a non-UTC
 * offset must NOT be prefix-sliced (its UTC day can differ), so the two cases are kept apart on purpose.
 *
 * Moved here from `lineage-resolver.ts` (where it was `dealBidDueDateToDateOnly`) so there is exactly one
 * copy: the resolver and the resolved-fields read must agree on the calendar day by construction.
 */
export function bidDueDateToDateOnly(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }
  return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
}

/**
 * The UTC-midnight instant every `deals.bid_due_date` writer stores for a date-only business value
 * (migration 0132; `normalizeOptionalDealBidDueDate` in deals/service.ts produces the same instant from
 * HTTP input). Kept in this leaf module so the bid-board-sync write-through can reuse it without pulling
 * in the whole deals service, and so the write shape can never drift from what `holdHorizonDateSql` reads
 * back with `AT TIME ZONE 'UTC'`.
 */
export function dateOnlyToUtcMidnightIso(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/**
 * PURE and FLAG-FREE so it is trivially unit-testable. Every read site must call
 * `resolveDealBidDueDateForRead` instead — see that function for why the flag lives one level up.
 */
export function resolveDealBidDueDate(input: DealBidDueDateInput): ResolvedDealBidDueDate {
  const bidBoardDay = bidDueDateToDateOnly(input.bidBoardDueDate);
  if (bidBoardDay != null) {
    // Normalized rather than passed through raw: the mirror is a date-only column, so its stored shape and
    // its calendar day are the same string anyway, and normalizing means a Date-valued mirror (a future
    // caller, a test fixture typed as timestamptz) can never publish an instant here.
    return { day: bidBoardDay, raw: bidBoardDay, source: "bid_board" };
  }

  if (input.hasSourceLead) {
    const leadRaw = input.leadBidDueDate ?? null;
    return { day: bidDueDateToDateOnly(leadRaw), raw: leadRaw, source: "lead" };
  }

  const dealRaw = input.dealBidDueDate ?? null;
  return { day: bidDueDateToDateOnly(dealRaw), raw: dealRaw, source: "deal" };
}

/**
 * The read wrapper EVERY read site uses. Consults `BID_BOARD_DUE_DATE_READBACK` exactly once and, when it
 * is off, hands the pure resolver `bidBoardDueDate: null` — so flag-off reproduces today's behaviour
 * exactly on every surface, including the at-risk / effective-value verdicts getDealDetail derives from
 * this date. The mirror column is already populated on prod, so this gate is what makes the PR inert.
 */
export function resolveDealBidDueDateForRead(
  input: DealBidDueDateInput,
  env: NodeJS.ProcessEnv = process.env
): ResolvedDealBidDueDate {
  if (!isBidBoardDueDateReadbackEnabled(env)) {
    return resolveDealBidDueDate({ ...input, bidBoardDueDate: null });
  }
  return resolveDealBidDueDate(input);
}
