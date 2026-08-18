/**
 * The canonical form of a field-scorecard CONTENT GENERATION, and the comparison that decides whether a
 * stored PDF artifact still represents the card.
 *
 * A scorecard's content generation is `field_scorecards.updated_at`; the generation the stored bytes were
 * rendered from is `field_scorecards.pdf_content_generation` (migration 0200). Both are `timestamptz`, which
 * Postgres stores to the MICROSECOND.
 *
 * `pg` / Drizzle materialise a `timestamptz` as a JavaScript `Date`, which holds MILLISECONDS. Every digit
 * below the millisecond is gone before any TypeScript in this repo sees the value, and a comparison made on
 * what survives is a comparison at a coarser resolution than the database stores:
 *
 *   • WRITTEN as a `Date`, `pdf_content_generation` lands as `.mmm000` — the column then does not hold the
 *     value its own documentation says it holds, permanently, for every row whose `updated_at` carries
 *     microseconds.
 *   • COMPARED as a `Date` (or via `date_trunc('milliseconds', …)` in the publication CAS), two genuinely
 *     different generations less than a millisecond apart compare EQUAL. The CAS matches and publishes a PDF
 *     of the PREVIOUS content; the read side then agrees the artifact is current; and the corrective-action
 *     email attaches exactly the pre-response document migration 0200 exists to prevent. It is not
 *     self-healing when the losing write is the card's last one, which for a completed corrective action is
 *     the ordinary case.
 *
 * The answer is to carry a generation as TEXT at Postgres's own resolution — `scorecardGenerationSql` is the
 * only way to read one — and to make the SAME string the value read, the value compared, the value bound in
 * the publication CAS, and the value written back. They cannot drift when they are one string.
 *
 * Lives in `shared` rather than beside the server's artifact rules because the ATTACHMENT decision is made
 * in the worker (`field-scorecard-email`, `scorecard-corrective-action-oversight-email`) and the DOWNLOAD
 * decision in the server. Those two must agree exactly — a worker that classifies an artifact current when
 * the server calls it stale emails the very bytes the download refuses to hand out — and three hand-written
 * copies of one comparison is how they came to disagree by a factor of a thousand in the first place.
 *
 * The weekly-report PDF cache (`server/src/modules/weekly-reports/pdf-artifact.ts`, PR #1075) solves the
 * identical problem with the identical representation. It is deliberately NOT imported here and this is
 * deliberately not imported there: that module is server-only, and coupling the two would make each fix wait
 * on the other's release. If weekly reports ever grow a worker-side consumer, collapse them here.
 */

/**
 * The two halves of the canonical generation expression, exported so a caller that must splice a query
 * builder's own column reference into the middle uses the SAME formatter as one writing raw SQL.
 *
 * `US` is microseconds, zero-padded to six digits, so the text is fixed-width and orders correctly. The
 * offset is pinned to a literal `Z` rather than emitted with `OF` because `to_char` renders a `timestamptz`
 * in the SESSION TimeZone: `AT TIME ZONE 'UTC'` converts to a naive UTC timestamp first, which makes the
 * `Z` true on every connection regardless of what `SET TimeZone` says. Without it the same instant produces
 * different text on different connections and the CAS compares a value against a differently-spelled copy
 * of itself.
 */
export const SCORECARD_GENERATION_SQL_PREFIX = "to_char(";
export const SCORECARD_GENERATION_SQL_SUFFIX = ` AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Read a `timestamptz` expression as canonical generation text: `YYYY-MM-DDTHH:MM:SS.ffffffZ`.
 *
 * Give it a `timestamptz`. On a naive `timestamp` the same `AT TIME ZONE 'UTC'` converts the OTHER way — to
 * a `timestamptz`, which `to_char` then renders in the session TimeZone — and the `Z` becomes a lie. Both
 * columns this is used on (`updated_at`, `pdf_content_generation`) are `timestamptz`; check the type before
 * pointing it at anything else.
 *
 * `$n::timestamptz` parses the result back to the exact microsecond it came from, so the text is equally
 * usable as a comparison operand, a CAS parameter and a value to store.
 */
export function scorecardGenerationSql(expression: string): string {
  return `${SCORECARD_GENERATION_SQL_PREFIX}${expression}${SCORECARD_GENERATION_SQL_SUFFIX}`;
}

const CANONICAL_GENERATION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Normalise whatever a caller holds into canonical generation text, or null when it is not a time at all.
 *
 * A `Date` is accepted and WIDENED with three zero microseconds — a JS `Date` never had them, so `.123000`
 * is the honest reading of `.123`. That path exists for callers with genuinely nothing better (a test
 * fixture, a legacy row already stored at millisecond resolution). It is NOT a licence to load one side of
 * a comparison as a `Date` and the other through `scorecardGenerationSql`: the text side keeps `.123456`
 * while the widened side claims `.123000`, and the artifact then reads stale on every single download.
 * Read BOTH sides the same way.
 */
export function scorecardGeneration(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (CANONICAL_GENERATION.test(trimmed)) return trimmed;
    // A non-canonical string carrying SUB-MILLISECOND digits is refused rather than widened. `new Date`
    // parses at millisecond resolution, so `…123456+00:00` would come back `.123000Z` — three zeros this
    // value never had, silently standing in for `456`. Widening is honest for a Date, which genuinely had
    // no microseconds; for a string that HAD them it manufactures a match against a real `.123000Z` and
    // reports two different instants as the same one, which is the unsafe direction. Null instead: every
    // caller treats it as "not provably the same" and re-renders.
    if (SUB_MILLISECOND_FRACTION.test(trimmed)) return null;
    return widenToMicroseconds(new Date(trimmed));
  }
  return widenToMicroseconds(value);
}

/** A fractional-seconds field with more digits than `new Date` can carry. */
const SUB_MILLISECOND_FRACTION = /\.\d{4,}/;

function widenToMicroseconds(value: Date): string | null {
  if (Number.isNaN(value.getTime())) return null;
  return `${value.toISOString().slice(0, -1)}000Z`;
}

/**
 * Epoch MICROSECONDS for a canonical generation, or NaN when it is not one.
 *
 * A number rather than a lexicographic comparison of the text: the canonical shape does order correctly
 * under `<`, but only while every value is a four-digit year with the same offset, and a comparison that is
 * right by coincidence of formatting is the kind that fails silently later. Epoch microseconds for a
 * contemporary timestamp are ~1.8e15, comfortably inside Number.MAX_SAFE_INTEGER (9.0e15, reached in 2255).
 */
export function scorecardGenerationEpochMicroseconds(generation: string): number {
  const match = /^(.*)\.(\d{6})Z$/.exec(generation);
  if (!match) return Number.NaN;
  const wholeSecondsMs = Date.parse(`${match[1]!}Z`);
  if (Number.isNaN(wholeSecondsMs)) return Number.NaN;
  return wholeSecondsMs * 1000 + Number(match[2]!);
}

/**
 * Are these two generations the SAME instant, to the microsecond?
 *
 * EXACT equality, not `rendered >= current`. A scorecard's content generation is one column written by one
 * rule — every writer advances `updated_at` strictly forward (`GREATEST(updated_at + 1ms, NOW())`, and the
 * edit path's JS equivalent) — so nothing can legitimately leave the stored generation AHEAD of the live
 * one. If it ever is, the row was restored, rolled back or hand-edited beneath the artifact, and the stored
 * bytes were rendered from content the card no longer has: re-rendering is the correct answer and costs one
 * render, whereas an ordering comparison would keep serving that artifact forever. (The weekly-report cache
 * uses `current <= rendered` because ITS current generation is a maximum over several rows, one of which
 * can legitimately drop out of the maximum and lower it. A scorecard has no such input.)
 *
 * False for a null or unparseable operand on either side — "not provably the same" is the safe direction,
 * and every caller's own null policy is documented at its call site rather than smuggled in here.
 */
export function scorecardGenerationsMatch(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined,
): boolean {
  const leftGeneration = scorecardGeneration(left);
  const rightGeneration = scorecardGeneration(right);
  if (leftGeneration == null || rightGeneration == null) return false;
  const leftMicros = scorecardGenerationEpochMicroseconds(leftGeneration);
  const rightMicros = scorecardGenerationEpochMicroseconds(rightGeneration);
  if (Number.isNaN(leftMicros) || Number.isNaN(rightMicros)) return false;
  return leftMicros === rightMicros;
}
