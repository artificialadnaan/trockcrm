// Canonical resolver for the human-facing DEAL NAME — THE single source of truth shared by the CRM
// web app (client), TROCK Cam's web app (client-field) and the field projects API (server).
//
// Why this exists: a change order is a real CHILD deal, and server/src/modules/deals/change-order-service.ts
// stores its name by APPENDING a suffix to the parent's name:
//
//     const childNameSuffix = ` — Change Order ${ordinal}`;   // note: em-dash, not a hyphen
//     const childName = `${parent.name}${childNameSuffix}`;   // "Tides Park Lane — Change Order 1"
//
// In every list view — most painfully TROCK Cam's project list, where the row is narrow — a long parent
// name truncates before the suffix is reached, so a change order is visually indistinguishable from the
// project it belongs to. Moving "Change Order N" to the FRONT puts the distinguishing part inside the
// characters that actually survive truncation.
//
// This is DISPLAY-ONLY and deliberately so. The stored `deals.name` is NOT changed, there is NO backfill,
// and change-order-service.ts keeps writing the suffixed form: the stored value stays the one thing every
// non-display consumer (search, exports, Procore/SyncHub matching, audit history, emails) has always seen.
// Everything here is a pure function over a string; nothing reads or writes the database.

// U+2014 EM DASH — the exact separator change-order-service.ts emits, and the only one we recognise.
// A hyphen "-" or an en-dash "–" is a name someone typed, not a name we generated.
const EM_DASH = "—";

// The generated trailing suffix, and ONLY that: optional whitespace, the em-dash, the exact literal
// "Change Order" (case-sensitive — that is what the generator writes), the ordinal, end of string.
// Anchored at `$` on purpose: a name that merely CONTAINS "Change Order" somewhere in the middle
// ("Change Order Backlog Review", "Tides — Change Order 1 Addendum") is NOT a generated child name and
// is left alone. A hyphen or en-dash separator is likewise not ours and is left alone.
//
// The ordinal is `[1-9]\d*`, matching exactly what the generator can emit: nextChildOrdinal() returns
// `COUNT(*)::int + 1`, so it is always a positive, unpadded decimal. "Change Order 0" and a zero-padded
// "Change Order 01" are therefore names a HUMAN typed, and must survive byte for byte.
const CHANGE_ORDER_NAME_SUFFIX = /\s*—\s*Change Order\s+([1-9]\d*)\s*$/;

/**
 * The display form of a deal name: for a generated change-order child, "Change Order N" is moved from
 * the end of the stored name to the front; every other name is returned byte for byte.
 *
 *     "Tides Park Lane — Change Order 1"        ->  "Change Order 1 — Tides Park Lane"
 *     "Tides Park Lane"                         ->  "Tides Park Lane"                    (untouched)
 *     "Change Order 1 — Tides Park Lane"        ->  "Change Order 1 — Tides Park Lane"   (idempotent)
 *     "Change Order Backlog Review"             ->  "Change Order Backlog Review"        (mid-string)
 *     "Change Order 7 — Lobby — Change Order 1" ->  "Change Order 1 — Change Order 7 — Lobby"
 *
 * It peels every generated trailing suffix rather than short-circuiting when the name merely LOOKS
 * already-formatted, because prefix-shaped text cannot identify this function's own output: a parent a
 * human named "Change Order 7 — Lobby" gets a child stored "Change Order 7 — Lobby — Change Order 1", and
 * a prefix test fires on it and returns it unchanged, stranding the child's real label at the end.
 *
 * POST-CONDITION — the output never ends in a generated suffix. This is the ONE invariant that makes the
 * function idempotent, and it is enforced (below), not assumed. Peeling alone does not give it: rejoining
 * the pieces can RE-CREATE a trailing suffix whenever what precedes it is itself label-shaped, e.g.
 *   " — Change Order 1 — Change Order 2"  peels to labels[2] + an EMPTY base -> "Change Order 2 — Change Order 1"
 *   "Change Order 1 — Change Order 2"     peels to labels[1] + base "Change Order 1" -> the same string
 * and both of those then peel again on the next pass, oscillating forever between two spellings. When the
 * rejoined candidate would still end in a suffix we return the name UNCHANGED instead: the input is
 * degenerate, leaving it exactly as stored is defensible, and "unchanged" is trivially a fixed point.
 *
 * Idempotency then follows for every input, by cases: either the result does not end in a suffix (so a
 * second pass peels nothing and returns it untouched), or we returned the input itself (a fixed point).
 *
 * Total and non-throwing: null/undefined pass straight through, and an empty or whitespace-only name is
 * returned exactly as given. Nullish is preserved rather than coerced to "" so call sites that supply
 * their own fallback (`formatDealDisplayName(deal.name) ?? "Untitled"`) keep working.
 */
export function formatDealDisplayName(name: string): string;
export function formatDealDisplayName(name: string | null | undefined): string | null | undefined;
export function formatDealDisplayName(name: string | null | undefined): string | null | undefined {
  if (typeof name !== "string" || name.length === 0) return name;

  // Peel generated suffixes off the tail, outermost first. Each match consumes at least "—Change Order N",
  // so `rest` strictly shrinks and the loop always terminates.
  const labels: string[] = [];
  let rest = name;
  for (;;) {
    const match = CHANGE_ORDER_NAME_SUFFIX.exec(rest);
    if (!match) break;
    labels.push(`Change Order ${match[1]}`);
    rest = rest.slice(0, match.index);
  }
  // Nothing we generated — return the caller's string untouched, byte for byte.
  if (labels.length === 0) return name;

  // Whatever is left is the parent part. Trimmed because a stored name may carry its own padding.
  // A name that is ONLY the suffix (" — Change Order 1") leaves nothing, so we emit the bare label(s)
  // rather than a dangling separator.
  const base = rest.trim();
  const candidate = (base.length === 0 ? labels : [...labels, base]).join(` ${EM_DASH} `);
  // Enforce the post-condition. See the note above: a rejoin can re-create a trailing suffix, and
  // returning such a string would make this function oscillate instead of settle.
  return CHANGE_ORDER_NAME_SUFFIX.test(candidate) ? name : candidate;
}
