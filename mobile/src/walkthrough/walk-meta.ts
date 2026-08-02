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
 *  recognizable later, not a UTC offset nobody on site was looking at. */
function formatWalkDateTime(atMs: number): string {
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

/** The deal's property address when known, else "" (never undefined/null — the wire type is a
 *  plain `string`; the server treats "" the same as absent). Trimmed so a whitespace-only address
 *  from an incomplete deal record reads as "unknown" rather than a blank-looking label. Clamped
 *  the same way deriveWalkTitle clamps `title` — property_address is unrestricted text, so an
 *  imported record can exceed the server's cap even though a normal address never gets close. */
export function deriveWalkSiteLabel(propertyAddress: string | null | undefined): string {
  const trimmed = propertyAddress?.trim() ?? "";
  return trimmed.length <= MAX_SITE_LABEL_CHARS ? trimmed : trimmed.slice(0, MAX_SITE_LABEL_CHARS);
}
