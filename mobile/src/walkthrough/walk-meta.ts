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
  const title = `${targetName} — ${formatWalkDateTime(atMs)}`;
  return title.length <= MAX_TITLE_CHARS ? title : title.slice(0, MAX_TITLE_CHARS);
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
 * "(recovered)" and the time are composed BEFORE the clamp, never appended after one. deriveWalkTitle
 * clamps to the server's MAX_TITLE_CHARS, and anything added past that clamp pushes a maximal title
 * one character over — a permanent 400 on the completion call, hit only after every artifact is
 * already in R2, which is exactly when the walk can no longer be saved by retrying.
 */
export function deriveRecoveredWalkTitle(targetName: string, atMs: number | null): string {
  const when = atMs === null ? UNKNOWN_WALK_TIME : formatWalkDateTime(atMs);
  const title = `${targetName} (recovered) — ${when}`;
  return title.length <= MAX_TITLE_CHARS ? title : title.slice(0, MAX_TITLE_CHARS);
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
