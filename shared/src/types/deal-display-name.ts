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
const CHANGE_ORDER_NAME_SUFFIX = /\s*—\s*Change Order\s+(\d+)\s*$/;

// An already-prefixed name — i.e. this helper's own output, or a name that is nothing but the label.
// Guards idempotency directly rather than relying on the suffix pattern happening not to match again.
const CHANGE_ORDER_NAME_PREFIX = /^\s*Change Order\s+\d+\s*(?:—|$)/;

/**
 * The display form of a deal name: for a generated change-order child, "Change Order N" is moved from
 * the end of the stored name to the front; every other name is returned byte for byte.
 *
 *     "Tides Park Lane — Change Order 1"  ->  "Change Order 1 — Tides Park Lane"
 *     "Tides Park Lane"                   ->  "Tides Park Lane"          (untouched)
 *     "Change Order 1 — Tides Park Lane"  ->  "Change Order 1 — Tides Park Lane"  (idempotent)
 *     "Change Order Backlog Review"       ->  "Change Order Backlog Review"       (mid-string, untouched)
 *
 * Total and non-throwing: null/undefined pass straight through, and an empty or whitespace-only name is
 * returned exactly as given. Nullish is preserved rather than coerced to "" so call sites that supply
 * their own fallback (`formatDealDisplayName(deal.name) ?? "Untitled"`) keep working.
 */
export function formatDealDisplayName(name: string): string;
export function formatDealDisplayName(name: string | null | undefined): string | null | undefined;
export function formatDealDisplayName(name: string | null | undefined): string | null | undefined {
  if (typeof name !== "string" || name.length === 0) return name;

  // Already in display form (or a bare "Change Order 3") — nothing to move. Checked FIRST so a
  // hypothetical double-suffixed name can never be rotated a second time into a different string.
  if (CHANGE_ORDER_NAME_PREFIX.test(name)) return name;

  const match = CHANGE_ORDER_NAME_SUFFIX.exec(name);
  if (!match) return name;

  const label = `Change Order ${match[1]}`;
  // Everything before the suffix. Trimmed because the suffix pattern already absorbed the whitespace
  // that ran up to the em-dash, and a stored name may carry its own leading padding.
  const base = name.slice(0, match.index).trim();
  // A name that is ONLY the suffix (" — Change Order 1") has no parent part left: show the bare label
  // rather than emitting a dangling separator.
  return base.length === 0 ? label : `${label} ${EM_DASH} ${base}`;
}
