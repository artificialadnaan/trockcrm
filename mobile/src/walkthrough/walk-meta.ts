/**
 * Auto-derives the `title` / `siteLabel` a completed walk enqueues under (upload-core.ts's
 * `WalkQueueMeta`, sent verbatim as `WalkCompletionRequest.title` / `.siteLabel`).
 *
 * The owner's decision, recorded on the walk screen: NEVER prompt for these. The estimator is
 * gloved, outdoors, one-handed, and about to start talking — a text field before recording is
 * friction at exactly the worst moment. So this is real logic (a date format, a fallback) that has
 * to live somewhere pure and testable rather than inline in a component; this is that somewhere.
 */

/** The server 400s a `title` over this (glasses-walkthrough-service.ts's MAX_TITLE_CHARS) — after
 *  every artifact is already in R2. A real target name never gets close, but this guards the one
 *  case where an unusually long name would otherwise turn a captured site visit into a walk stuck
 *  retrying a completion call that can never succeed. */
const MAX_TITLE_CHARS = 300;

/** The server 400s a `siteLabel` over this too (glasses-walkthrough-service.ts's
 *  MAX_SITE_LABEL_CHARS) — same failure mode as MAX_TITLE_CHARS above, but for `siteLabel`:
 *  `deals.property_address` is unrestricted free text, and an imported record can carry an
 *  unusually long one. Without a clamp here, a long address would strand an otherwise fully
 *  uploaded walk in the terminal queue when the completion call permanently rejects it. */
const MAX_SITE_LABEL_CHARS = 300;

/** "30 Jul 2026, 9:15 PM" — day-month-year (unambiguous across locales, unlike MM/DD) plus a
 *  12-hour clock time, both read in the DEVICE's own timezone: `atMs` is the instant the walk
 *  actually happened, and the estimator's local wall-clock time is what makes that instant
 *  recognizable later, not a UTC offset nobody on site was looking at.
 *
 *  Exported because Profile's recovery card shows an orphaned walk's recorded time so the estimator
 *  can work out which job it was, and that is the SAME question this format already answers inside
 *  the title the office reads. Two formats would have the card and the filed walk describing one
 *  recording with two different-looking timestamps — the exact ambiguity day-month-year is here to
 *  avoid. */
export function formatWalkDateTime(atMs: number): string {
  const d = new Date(atMs);
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

/**
 * e.g. `deriveWalkTitle("Post RE Group - Building C", <30 Jul 2026, 9:15 PM>)` ->
 * `"Post RE Group - Building C — 30 Jul 2026, 9:15 PM"`.
 *
 * `targetName` is whatever the capture screen already resolved for this deal (falls back to
 * "this project" there, same as the walk screen's headline) — this function never second-guesses
 * it. `atMs` should be the walk's own `startedAt`; a walk with captured artifacts always has one
 * (session.ts only reaches "recording" — where stills/video become possible — after `startedAt`
 * is set), so callers only need a defensive fallback for the type, not the real-world case.
 */
export function deriveWalkTitle(targetName: string, atMs: number): string {
  return clampedTitle(targetName, ` — ${formatWalkDateTime(atMs)}`);
}

/**
 * `name + suffix` within MAX_TITLE_CHARS, taking the overflow out of the NAME.
 *
 * Slicing the composed string is the obvious way and it removes the wrong end. Everything these
 * titles append — the timestamp, and "(recovered)" — sits at the tail, so exactly the case
 * MAX_TITLE_CHARS exists for (a name long enough to need clamping at all) silently deleted the one
 * part of the title that is not recoverable from anywhere else. The target name IS recoverable: it
 * sits in full on the deal the walk files against, while the office reads this line to learn WHEN
 * the visit happened and whether it was reconstructed. So the name is what gets cut, and the suffix
 * survives intact rather than half-formed.
 *
 * `trimEnd` so a cut landing mid-word does not leave "Building  — 30 Jul 2026" with the name's own
 * trailing space doubling the separator. The degenerate `budget <= 0` branch is unreachable with any
 * suffix this module composes (the longest is a few dozen characters) and exists only so a future
 * caller with a pathological suffix gets a clamped string rather than one over the server's cap —
 * which is the failure this whole clamp is here to prevent.
 */
function clampedTitle(name: string, suffix: string): string {
  const budget = MAX_TITLE_CHARS - suffix.length;
  if (budget <= 0) return `${name}${suffix}`.slice(0, MAX_TITLE_CHARS);
  return name.length <= budget ? `${name}${suffix}` : `${name.slice(0, budget).trimEnd()}${suffix}`;
}

/** What the office reads where a date would be, when nobody can say. Shared verbatim with the
 *  recovery card for the same reason formatWalkDateTime is: one recording, described one way, in the
 *  place the estimator saw it and in the place the office later reads it. */
export const UNKNOWN_WALK_TIME = "Time unknown";

/**
 * The title for a walk reconstructed from files on disk, with no reducer history behind it — see
 * upload-core.ts's toRecoveredQueuedWalk, which leaves startedAt null because there is no truthful
 * value for it.
 *
 * Separate from deriveWalkTitle because `atMs` here is genuinely NULLABLE, and that is the whole
 * point. A recovered walk's completion call falls back to the drain moment for capturedAt, so THIS
 * STRING is the only place the office ever learns when the visit actually happened. Passing
 * `Date.now()` in place of a timestamp iOS could not report does not produce a slightly-vaguer
 * title; it produces a confident, wrong one, dating a site visit from last week to today — and the
 * recovery card is deliberately built to omit rather than guess (it labels a span "at least N min"
 * and drops it entirely when one instant is all it has). An unknown time has to survive the whole
 * way through, or the card's honesty stops at the screen.
 *
 * "(recovered)" and the time are composed BEFORE the clamp, never appended after one, and the clamp
 * itself (clampedTitle) takes its bytes out of `targetName` so both survive whatever the name is.
 * Either half alone loses the property: appending after the clamp pushes a maximal title one
 * character over MAX_TITLE_CHARS — a permanent 400 on the completion call, hit only after every
 * artifact is already in R2, which is exactly when the walk can no longer be saved by retrying —
 * while clamping the composed string throws away the marker and the time, i.e. everything this
 * function exists to say, on a walk whose project happens to have a long name.
 */
export function deriveRecoveredWalkTitle(targetName: string, atMs: number | null): string {
  const when = atMs === null ? UNKNOWN_WALK_TIME : formatWalkDateTime(atMs);
  return clampedTitle(targetName, ` (recovered) — ${when}`);
}

/**
 * Add a note to an ALREADY-COMPOSED title — for a fact that only becomes true after the walk was
 * enqueued, which is the one case the derive functions above cannot cover. Today that is exactly one
 * thing: an artifact the upload queue found it can never file (upload-core.ts's
 * `dropUnfilableArtifact`), where the title is the only channel that reaches the office alongside
 * the walk.
 *
 * Appended ONLY when it fits, and left off entirely when it does not — deliberately NOT clamped.
 * `clampedTitle` takes its overflow out of the front, which is right when the front is a project
 * name (recoverable in full from the deal the walk files against) and the tail is the timestamp. But
 * everything handed to THIS function is already "the front", so making room would cut exactly the
 * timestamp `deriveRecoveredWalkTitle` goes to such lengths to preserve — and for a recovered walk
 * that string is the only record of when the site visit happened. A title already within a note's
 * length of the cap keeps its timestamp and loses the note; the alternative trades a fact nothing
 * else carries for one the missing artifact itself implies.
 */
export function withWalkTitleNote(title: string, note: string): string {
  const suffix = ` ${note}`;
  return title.length + suffix.length <= MAX_TITLE_CHARS ? `${title}${suffix}` : title;
}

/** The deal's property address when known, else "" (never undefined/null — the wire type is a
 *  plain `string`; the server treats "" the same as absent). Trimmed so a whitespace-only address
 *  from an incomplete deal record reads as "unknown" rather than a blank-looking label. Clamped
 *  the same way deriveWalkTitle clamps `title` — property_address is unrestricted text, so an
 *  imported record can exceed the server's cap even though a normal address never gets close. */
export function deriveWalkSiteLabel(propertyAddress: string | null | undefined): string {
  const trimmed = propertyAddress?.trim() ?? "";
  return trimmed.length <= MAX_SITE_LABEL_CHARS ? trimmed : trimmed.slice(0, MAX_SITE_LABEL_CHARS);
}
