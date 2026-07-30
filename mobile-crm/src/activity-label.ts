/**
 * An activity's type, in the rep's words.
 *
 * The deal feed rendered the raw column — a rep read `site_visit`, `voicemail`, `stage_change`. The
 * capture screen already had the right words for the five types it can WRITE, but it kept them in a
 * local array shaped for its chip picker, so the feed could not reach them.
 *
 * THE VOCABULARY IS WIDER THAN ANY ONE LIST. `api-spec.ts` documents six types (call, email, note,
 * meeting, site_visit, text) and the server also emits `voicemail`, `stage_change` and `task` — the
 * spec is simply behind. So the map below is a courtesy for the ones worth phrasing deliberately, and
 * the FALLBACK is the actual contract: anything unknown is humanised rather than dropped or shown raw.
 * A feed that hides an activity it does not recognise is worse than one that says "Stage change".
 */

const KNOWN: Record<string, string> = {
  site_visit: "Site visit",
  call: "Call",
  meeting: "Meeting",
  voicemail: "Voicemail",
  note: "Note",
  email: "Email",
  text: "Text",
  task: "Task",
  stage_change: "Stage change",
};

/**
 * `snake_case` or `camelCase` to "Sentence case".
 *
 * Same shape as `fieldLabel` on the move screen, and for the same reason: an unmapped key still has to
 * read as English. Kept lowercase after the first word so "stage_change" is "Stage change" rather than
 * the "Stage Change" title-casing that makes a feed look like a spreadsheet header.
 */
function humanise(raw: string): string {
  const spaced = raw.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  if (!spaced) return "Activity";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function activityTypeLabel(type: string | null | undefined): string {
  if (typeof type !== "string" || type.trim() === "") return "Activity";
  const key = type.trim();
  return KNOWN[key] ?? humanise(key);
}
