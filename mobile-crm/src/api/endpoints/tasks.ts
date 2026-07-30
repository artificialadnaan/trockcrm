import type { Fetcher } from "./auth";

/** A rep's to-do list — the surface with the strongest claim to being on a phone rather than a desk. */

export type TaskStatus = string;

export type TaskListItem = {
  id: string;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: TaskStatus;
  assignedTo: string;
  assignedToName: string | null;
  dealId: string | null;
  dealName?: string | null;
  /** Both carried so the canonical display-number rule can be applied — see src/deal-display-number.ts. */
  dealNumber?: string | null;
  projectNumber?: string | null;
  contactId: string | null;
  dueDate: string | null;
  dueTime: string | null;
  /**
   * WHERE A SCHEDULED TASK KEEPS ITS DATE.
   *
   * The server CLEARS `dueDate` when a task moves to `scheduled` and requires `scheduledFor` instead
   * (tasks/service.ts:197-200), and the `later` section deliberately includes scheduled tasks. Reading
   * only `dueDate` therefore rendered those rows with no date at all — the one thing a rep needs from
   * a task they cannot act on yet.
   */
  scheduledFor?: string | null;
  status_scheduled?: never;
};

/**
 * The server's own sections, mirrored: `TASK_SECTIONS` in tasks/service.ts:23.
 *
 * `upcoming` and `completed` are omitted here, not missing. A phone's task screen answers "what needs
 * me now", and the server already computes overdue / today / this_week / later against America/Chicago
 * — recomputing that split on the device would be a second implementation of a business-timezone rule.
 */
export const TASK_SECTIONS = ["overdue", "today", "this_week", "later"] as const;
export type TaskSection = (typeof TASK_SECTIONS)[number];

/**
 * One page. The caller pages until a SHORT page arrives.
 *
 * A hard cap of fifty silently omitted every later task, and a hidden overdue item is worse here than
 * anywhere else in the app — the list's whole claim is that it shows what needs you.
 */
export async function listTasks(
  fetcher: Fetcher,
  params: { section?: TaskSection; assignedTo?: string; limit?: number; page?: number },
): Promise<{ tasks: TaskListItem[]; total: number }> {
  const q = new URLSearchParams();
  if (params.section) q.set("section", params.section);
  if (params.assignedTo) q.set("assignedTo", params.assignedTo);
  q.set("page", String(params.page ?? 1));
  q.set("limit", String(params.limit ?? 50));
  const res = await fetcher<{ tasks?: TaskListItem[]; pagination?: { total?: number } }>(
    `/tasks?${q.toString()}`,
  );
  return { tasks: res.tasks ?? [], total: res.pagination?.total ?? res.tasks?.length ?? 0 };
}

/**
 * The counts this endpoint ACTUALLY returns: overdue, today, upcoming, completed, completedThisWeek.
 *
 * Not this_week or later. Indexing the counts by section key looked right and quietly returned
 * `undefined` for two of the four tabs, so those badges could never appear however many tasks sat
 * behind them — a legacy shape read as if it matched the newer section vocabulary. Typed narrowly so
 * the mismatch is a compile error rather than a blank.
 */
export type TaskCounts = {
  overdue?: number;
  today?: number;
  upcoming?: number;
  completed?: number;
  completedThisWeek?: number;
};

export async function getTaskCounts(fetcher: Fetcher): Promise<TaskCounts> {
  const res = await fetcher<{ counts?: TaskCounts }>("/tasks/counts");
  return res.counts ?? {};
}
