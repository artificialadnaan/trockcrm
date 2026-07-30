/**
 * What a task row has to SAY beyond its title and date.
 *
 * The list groups by date, which answers "when" and nothing else. Two rows with the same title and the
 * same date can be an urgent item and a low-priority one; a pending item and one blocked on somebody
 * else. Rendering neither made the list look sorted when it was only grouped, and a rep working top to
 * bottom had no way to tell the difference — the whole point of the screen is deciding what to do next.
 *
 * Pure, and here rather than inline, because both the visible row and the spoken label need the same
 * answer. Every time this app has phrased one fact twice, the two copies drifted.
 */

/**
 * Priority, but only when it CHANGES the decision.
 *
 * `normal` is the default the server stamps on almost everything, so rendering it puts a word on every
 * row that distinguishes none of them. `low` earns a marker for the opposite reason: it is the one
 * value that says "safe to leave", and a rep scanning for something to drop needs to see it.
 *
 * The requested `due_date` ordering falls back to task id, not priority, when dates tie — so an urgent
 * task genuinely can sit among normal work, and the marker is the only thing distinguishing it.
 */
export function taskPriorityLabel(priority: string | null | undefined): string | null {
  switch ((priority ?? "").trim().toLowerCase()) {
    case "urgent":
      return "Urgent";
    case "high":
      return "High";
    case "low":
      return "Low";
    default:
      return null;
  }
}

/**
 * The lifecycle, for the statuses that mean "not actionable right now".
 *
 * The server puts `in_progress`, `waiting_on` and `blocked` in the SAME dated sections as pending work,
 * and `scheduled` into Later — so a blocked task sat beside an actionable one looking identical. That
 * is the difference between "do this" and "you cannot do this yet", which is not a detail.
 *
 * `pending` returns null on purpose: it is the ordinary state, and labelling it would put a word on
 * every row again. `scheduled` too — the Later section it lives in already says it, and repeating it on
 * every row in that section is noise rather than information.
 */
export function taskStatusLabel(status: string | null | undefined): string | null {
  switch ((status ?? "").trim().toLowerCase()) {
    case "in_progress":
      return "In progress";
    case "waiting_on":
      return "Waiting";
    case "blocked":
      return "Blocked";
    default:
      return null;
  }
}

/**
 * The dependency detail is DELIBERATELY not rendered.
 *
 * `waiting_on` and `blocked_by` are `jsonb` columns typed as `unknown` on the server (tasks/service.ts:84),
 * with no schema, no documented shape, and no reader anywhere in the web client to copy. Interpolating an
 * arbitrary blob into "Blocked on …" would produce "[object Object]" for some rows and a wrong name for
 * others, which is worse than the honest "Blocked" — a rep who sees a label they cannot trust stops
 * trusting the ones they could.
 *
 * The status alone is well-defined and already answers the question that matters on a list: this row is
 * not actionable right now. Naming the blocker needs the server to define what it stores first.
 */
