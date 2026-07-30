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

export async function listTasks(
  fetcher: Fetcher,
  params: { section?: TaskSection; assignedTo?: string; limit?: number },
): Promise<{ tasks: TaskListItem[]; total: number }> {
  const q = new URLSearchParams();
  if (params.section) q.set("section", params.section);
  if (params.assignedTo) q.set("assignedTo", params.assignedTo);
  q.set("limit", String(params.limit ?? 50));
  const res = await fetcher<{ tasks?: TaskListItem[]; pagination?: { total?: number } }>(
    `/tasks?${q.toString()}`,
  );
  return { tasks: res.tasks ?? [], total: res.pagination?.total ?? res.tasks?.length ?? 0 };
}

export async function getTaskCounts(fetcher: Fetcher): Promise<Record<string, number>> {
  const res = await fetcher<{ counts?: Record<string, number> }>("/tasks/counts");
  return res.counts ?? {};
}
