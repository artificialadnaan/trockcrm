import { isBidBoardDueDateReadbackEnabled } from "../../config/feature-flags.js";

/**
 * THE one place a deal's bid due date is resolved, so the deal-detail banner, the resolved-fields/scoping
 * surface and the RFP payload can never disagree about it.
 *
 * ★ THE CENTRAL RULE, and the thing to understand before editing anything here:
 *
 *   `deals.bid_board_due_date` IS NEVER READ AS A VALUE. It is read only as a SIGNAL.
 *
 * The value this resolver returns is ALWAYS one of `deals.bid_due_date` or `leads.bid_due_date` — never
 * the mirror column. The mirror only helps answer one question: "has the Bid Board's date actually LANDED
 * in the CRM column?", which requires BOTH
 *   1. PROVENANCE — `deals.bid_due_date_from_bid_board_at` is set, i.e. the sync itself wrote the column
 *      (migration 0225); and
 *   2. CURRENCY — `(deals.bid_due_date AT TIME ZONE 'UTC')::date` still equals `deals.bid_board_due_date`.
 * When both hold, the deal column WINS over the source lead. Otherwise the legacy precedence applies
 * untouched.
 *
 * ALL THREE are required because each alone is wrong. The day check alone accepts a COINCIDENCE — the
 * mirror has been populated on prod for months, so any deal whose pre-existing `bid_due_date` merely
 * shares the board's calendar day would look landed the instant the flag flipped, changing a lead-backed
 * deal's displayed date and, in a genuine estimating stage, its hold verdict and reported value, with no
 * sync having run. The timestamp alone goes stale the other way: it records that the sync wrote the column
 * once, and would keep the override on after a rep or the lead corrected the date. And NEITHER notices a
 * change of PROJECT: a deal detached and later linked to a new Bid Board project keeps its old dates and
 * stamp (the link path clears only `bid_board_detached_at`), so the override would fire again on
 * provenance earned from a project the deal is no longer on — the detached-deal leak returning where the
 * detach guard cannot see it. Neither stamp is ever cleared; the day check and the identity check revoke.
 *
 * WHY, because the obvious design (read the mirror's value directly, mirror-beats-lead-beats-column) was
 * written first and is wrong in two ways that only show up in production:
 *
 *  1. DETACH. "Move back to Opportunity" (migration 0200) severs a deal from Bid Board sync, and the
 *     write-through honours that — but `buildBidBoardDetachUpdate` never clears `bid_board_due_date`. A
 *     value-reading resolver would therefore keep sourcing a detached deal's bid due date, and so its hold
 *     horizon, at-risk verdict and effective value, from the board it was deliberately severed from —
 *     forever. Under the signal rule a detached deal's column was never rewritten, so it falls straight
 *     back to the legacy answer on its own. (Belt-and-braces, `bidBoardDetachedAt` also disables the
 *     override outright: the fallback is a consequence of the data, and an invariant this load-bearing
 *     should not depend on a consequence.)
 *
 *  2. TS/SQL DRIFT. Only these three TS read sites would move to the mirror; `holdHorizonDateSql` and its
 *     ~50 SQL consumers keep reading `deals.bid_due_date`. So the deal page would show one date and every
 *     board, dashboard, report and worker rollup another — not transiently, but PERMANENTLY for every deal
 *     the write-through skips: detached deals, deals no longer on the export, rows skipped for a null
 *     attributor, multi-match rows, template rows. Reading the same column SQL reads makes that class of
 *     drift impossible by construction, and makes the flag flip inert until data actually flows.
 *
 * So the read change is not "show the Bid Board's date". It is narrower and safer: "once the Bid Board's
 * date is in the CRM column, stop letting a stale lead value MASK it". That is the only reason a read
 * change was needed at all, and it is all this does.
 *
 * WHY ANY OF IT MATTERS BEYOND DISPLAY: since 2026-07-27 `deals.bid_due_date` is the auto-park HORIZON for
 * genuine estimating-stage deals ([[deal-hold-risk]] resolveHoldHorizonDay and its SQL twin
 * holdHorizonDateSql in [[deal-reporting]]). A horizon more than CLOSE_TARGET_HOLD_HORIZON_DAYS (90)
 * CT-days out makes a deal effectively on hold, which ZEROES its value on cards, dashboards, at-risk
 * counts and the worker rollups. So this resolver moves reported dollars, which is why every read site
 * goes through `resolveDealBidDueDateForRead` (flag-gated) and never the raw resolver.
 */

/**
 * Which source supplied the resolved value.
 *
 * `"bid_board"` does NOT mean "the mirror column's value was returned" — nothing ever returns that. It
 * means "the DEAL COLUMN was returned, and it beat the lead because it carries the Bid Board's landed
 * value". See the module doc.
 */
export type DealBidDueDateSource = "bid_board" | "lead" | "deal";

export interface DealBidDueDateInput {
  /**
   * `deals.bid_board_due_date` — the Bid Board export's Due Date, mirrored on every sync. A date-only
   * column, so node-pg/Drizzle hand it back as "YYYY-MM-DD".
   *
   * SIGNAL ONLY. Its value is never returned; it is only compared against the deal column's calendar day.
   */
  bidBoardDueDate?: Date | string | null;
  /**
   * `deals.bid_due_date_from_bid_board_at` (migration 0225) — when the Bid Board sync last WROTE
   * `deals.bid_due_date`. NULL means the value did not come from the board, whatever the dates look like.
   * Required for the override; see the module doc for why a day match alone is not provenance.
   */
  bidDueDateFromBidBoardAt?: Date | string | null;
  /**
   * `deals.bid_due_date_bid_board_project_number` (migration 0225) — the Bid Board project the stamp was
   * earned on, compared against `bidBoardProjectNumber` below. See the module doc.
   */
  bidDueDateBidBoardProjectNumber?: string | null;
  /** `deals.bid_board_project_number` — the project the deal is on RIGHT NOW (NULL once detached). */
  bidBoardProjectNumber?: string | null;
  /**
   * `deals.bid_board_detached_at` (migration 0200) — non-null once "Move back to Opportunity" severed this
   * deal from Bid Board sync. Disables the override outright.
   */
  bidBoardDetachedAt?: Date | string | null;
  /**
   * Whether the deal has a source lead AT ALL — deliberately NOT "whether that lead has a bid due date".
   * A lead-backed deal's CLEARED (null) lead value must still beat the deal column: the lead owns the
   * field (DEAL_FIELD_OWNERSHIP.bidDueDate === "lead") and the deal column is only a compatibility
   * snapshot, so a deliberate clear must not be masked by a stale deal snapshot.
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
   * The winning source's value EXACTLY AS STORED — a date-only string from the lead, a `Date` from
   * `deals.bid_due_date`. Present so a caller that already publishes the raw column shape on the wire
   * (getDealDetail) keeps doing so byte-for-byte instead of silently narrowing an ISO instant to a
   * date-only string for every non-lead-backed deal the moment this resolver is introduced.
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
  const dealRaw = input.dealBidDueDate ?? null;
  const dealDay = bidDueDateToDateOnly(dealRaw);

  // THE SIGNAL. Not "what does the board say?" but "did the SYNC put what the board says into the column
  // every SQL surface reads, and is it still there?".
  //
  // PROVENANCE first: without the 0225 stamp this is a deal the sync has never written, whatever its dates
  // happen to look like. This is the condition that makes the flag flip inert — at flip time no deal
  // carries a stamp (the write-through is gated by the same flag), so the override fires for NOBODY until
  // a sync writes, and thereafter only for the deals the census counted. A day match alone would accept a
  // COINCIDENCE: the mirror has been populated on prod for months, so a pre-existing bid_due_date that
  // merely shares the board's calendar day would look landed the instant the flag flipped.
  //
  // IDENTITY second: the stamp has to have been earned on the project this deal is on RIGHT NOW. A deal
  // that was detached and later linked to a genuinely NEW Bid Board project keeps its old dates and its
  // old stamp — the link callback clears only bid_board_detached_at — so without this the override would
  // fire on provenance from a retired project, which is the detached-deal leak arriving through the front
  // door. The detach itself NULLs bid_board_project_number, so a stamped deal stops matching the moment it
  // leaves its project and stays non-matching until a sync re-earns the stamp for the new one.
  //
  // Both sides must be present: a NULL == NULL comparison is not identity, and would re-admit exactly the
  // detached case (both columns NULL) this exists to exclude.
  //
  // CURRENCY third, on the CALENDAR DAY, because the column is a timestamptz at UTC midnight and the
  // mirror is a date — the same comparison holdHorizonDateSql makes with
  // `(bid_due_date AT TIME ZONE 'UTC')::date`. This is what REVOKES the override when a rep or the lead
  // later corrects the date, instead of latching it on forever behind stamps that are never cleared.
  //
  // The detach check is belt-and-braces on top of the identity check — it states the invariant locally
  // instead of leaving it to be inferred from which columns a detach happens to clear.
  const mirrorDay = bidDueDateToDateOnly(input.bidBoardDueDate);
  const detached = input.bidBoardDetachedAt != null;
  const writtenByBidBoard = input.bidDueDateFromBidBoardAt != null;
  const stampedProject = input.bidDueDateBidBoardProjectNumber ?? null;
  const currentProject = input.bidBoardProjectNumber ?? null;
  const sameProject = stampedProject != null && currentProject != null && stampedProject === currentProject;
  if (
    !detached &&
    writtenByBidBoard &&
    sameProject &&
    mirrorDay != null &&
    dealDay != null &&
    dealDay === mirrorDay
  ) {
    // The DEAL COLUMN is returned — never the mirror. All this branch decides is that it outranks the
    // lead, so a stale lead value stops masking a bid date the Bid Board has already delivered.
    return { day: dealDay, raw: dealRaw, source: "bid_board" };
  }

  if (input.hasSourceLead) {
    const leadRaw = input.leadBidDueDate ?? null;
    return { day: bidDueDateToDateOnly(leadRaw), raw: leadRaw, source: "lead" };
  }

  return { day: dealDay, raw: dealRaw, source: "deal" };
}

/**
 * The read wrapper EVERY read site uses. Consults `BID_BOARD_DUE_DATE_READBACK` exactly once and, when it
 * is off, hands the pure resolver `bidBoardDueDate: null` — erasing the SIGNAL, so flag-off reproduces
 * today's behaviour exactly on every surface, including the at-risk / effective-value verdicts
 * getDealDetail derives from this date.
 *
 * Note what the flag buys, given the signal rule: at flip time nothing moves, because the write-through is
 * gated by the same flag and has therefore never run, so NO deal carries the 0225 provenance stamp. The
 * read side follows the write side rather than racing ahead of it, and the census measures exactly the
 * change the flip causes.
 */
export function resolveDealBidDueDateForRead(
  input: DealBidDueDateInput,
  env: NodeJS.ProcessEnv = process.env
): ResolvedDealBidDueDate {
  if (!isBidBoardDueDateReadbackEnabled(env)) {
    // Erase the SIGNAL, not merely one of its inputs: with the flag off neither the mirror nor the
    // provenance stamp may influence the answer.
    return resolveDealBidDueDate({
      ...input,
      bidBoardDueDate: null,
      bidDueDateFromBidBoardAt: null,
      bidDueDateBidBoardProjectNumber: null,
    });
  }
  return resolveDealBidDueDate(input);
}

/**
 * The RFP payload's bid due date — the ONE read site whose flag-OFF branch is NOT the shared precedence.
 *
 * `loadRfpPayloadDeal` has always preferred the deal's OWN column and fallen back to the source lead,
 * which is backwards relative to the other two read sites: the lead owns the field
 * (DEAL_FIELD_OWNERSHIP.bidDueDate === "lead") and the deal column is only a compatibility snapshot. That
 * IS a bug, and the flag-ON branch below fixes it.
 *
 * ⚠️ DO NOT "simplify" this to `resolveDealBidDueDateForRead`. The legacy branch is DELIBERATE PARITY, not
 * an oversight someone forgot to clean up.
 *
 * Two reasons the correction does not ship ahead of the flag:
 *  1. This PR's whole contract is "flag off ⇒ zero delta on every surface". That is what makes the census
 *     numbers meaningful (they describe the only change the flip causes) and the rollout reversible by
 *     flipping an env var rather than by shipping a deploy.
 *  2. Unlike the deal-detail banner and the scoping field, this value LEAVES the CRM: it travels to
 *     SyncHub and is typed into the Procore Bid Board project's Due Date field. Correcting it ungated
 *     would write a new date into an external system before anyone had looked at the census.
 *
 * Being the more correct precedence buys no exemption — it just means the fix rides along when the flag
 * flips. Returns the winning source's value AS STORED in both branches, so the flag changes only WHICH
 * source wins, never the shape (`cleanIso` in rfp-payload.ts normalizes either one identically).
 *
 * Given the signal rule, the two branches differ on a NARROW set: when the deal column already carries the
 * Bid Board's landed date both branches return that column, so only a lead-backed deal whose column has
 * NOT received the write-through can differ — which is exactly the lead-vs-column ordering being gated.
 */
export function resolveRfpPayloadDueDates(
  input: DealBidDueDateInput,
  env: NodeJS.ProcessEnv = process.env
): { bidDueDate: Date | string | null; bidBoardDueDate: Date | string | null } {
  if (!isBidBoardDueDateReadbackEnabled(env)) {
    // Verbatim legacy: `row.bid_due_date ?? row.sourceLeadBidDueDate ?? null`, and the mirror passed
    // through untouched so buildNormalizedRfpRequestBody's existing
    // `cleanIso(bidDueDate) ?? cleanIso(bidBoardDueDate)` fallback behaves exactly as it does on main.
    return {
      bidDueDate: input.dealBidDueDate ?? input.leadBidDueDate ?? null,
      bidBoardDueDate: input.bidBoardDueDate ?? null,
    };
  }
  // Flag ON, the resolver's decision is FINAL — which means withholding the mirror.
  //
  // buildNormalizedRfpRequestBody falls back to `bidBoardDueDate` when `bidDueDate` is null. Passing the
  // mirror here would let a value the resolver just REJECTED as non-authoritative reach the payload
  // anyway: a lead-backed deal with a cleared lead value and an UNLANDED mirror resolves to null (the rep
  // deliberately has no bid date), and the fallback would then send the board's date to SyncHub, where it
  // is typed into the Procore Bid Board project's Due Date field. A rejected value must not come back in
  // through a side door — the payload's fallback has to agree with the decision, not second-guess it.
  //
  // Note the landed case needs no fallback anyway: `raw` is then the deal column, which already carries
  // the board's date.
  return { bidDueDate: resolveDealBidDueDate(input).raw, bidBoardDueDate: null };
}
