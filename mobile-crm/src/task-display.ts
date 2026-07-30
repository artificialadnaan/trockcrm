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
 * every row again.
 *
 * `scheduled` DOES get one, which I first got wrong by assuming the Later section already said it. It
 * does not: `later` is built as far-future-or-undated open work UNION everything scheduled
 * (tasks/service.ts:396-405), so the section mixes the two and a scheduled row was indistinguishable
 * from an ordinary one sitting months out. "Section implies status" is only true if the section is
 * status-pure, and this one is not.
 */
export function taskStatusLabel(status: string | null | undefined): string | null {
  switch ((status ?? "").trim().toLowerCase()) {
    case "in_progress":
      return "In progress";
    case "waiting_on":
      return "Waiting";
    case "blocked":
      return "Blocked";
    case "scheduled":
      return "Scheduled";
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

/**
 * WHICH DATE a task actually happens on — mirroring the server's own rule, not approximating it.
 *
 * `buildTaskSortOrder` computes an EFFECTIVE date and sorts every bucket by it:
 *
 *     status = 'scheduled' → COALESCE(scheduled_for, due_date)
 *     otherwise            → COALESCE(due_date, scheduled_for)
 *
 * The direction flips on status, and that is the whole point. `updateTask` permits a due date on a row
 * that is still scheduled — editing one in the web dialog can leave both columns populated — so a plain
 * `dueDate ?? scheduledFor` showed one date while the list was ORDERED by the other. A row displaying
 * Friday sitting between Monday and Tuesday looks like a broken sort, and the rep believes the date.
 *
 * Mirrored here rather than approximated because "the date the server sorted by" and "the date the row
 * shows" have to be the same value or the screen contradicts itself.
 *
 * Returns the SOURCE as well, because the two columns are different types. `due_date` is a Postgres
 * `date` — no time exists to show. `scheduled_for` is `timestamptz`, and the web dialog lets someone
 * pick the hour: rendering it date-only made 9am and 3pm the same row. Keying the format on the source
 * rather than on the status is what makes an undated task that fell back to `scheduled_for` still show
 * its time.
 */
export function taskEffectiveDate(task: {
  status?: string | null;
  dueDate?: string | null;
  scheduledFor?: string | null;
}): { value: string | null; source: "dueDate" | "scheduledFor" | null } {
  const scheduled = (task.status ?? "").trim().toLowerCase() === "scheduled";
  const order: Array<"dueDate" | "scheduledFor"> = scheduled
    ? ["scheduledFor", "dueDate"]
    : ["dueDate", "scheduledFor"];
  for (const source of order) {
    const value = task[source];
    if (value) return { value, source };
  }
  return { value: null, source: null };
}
