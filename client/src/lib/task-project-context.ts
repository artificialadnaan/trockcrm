import { formatDealDisplayName, formatDealDisplayNumber } from "@/lib/deal-utils";
import type { Task } from "@/hooks/use-tasks";

/**
 * The project a task belongs to, as one display string.
 *
 * LIVES HERE RATHER THAN IN task-list-page.tsx SO THE ROW AND THE DRAWER SHARE ONE DEFINITION. Both
 * render it — the row inline, the detail drawer in its header — and a task opened from an email deep
 * link showing a different project label than the same task in the list is the reconciliation failure
 * this repo keeps re-learning. task-list-page.tsx re-exports it so its existing import path (and the
 * suites that use it) keep working.
 */
export function getTaskProjectContext(
  task: Pick<Task, "dealId" | "dealName" | "dealIsChangeOrder" | "dealNumber" | "projectNumber">
): string | null {
  if (!task.dealId) return null;
  const displayNumber = formatDealDisplayNumber(task).label;
  if (task.dealName) {
    // A change-order child deal is STORED as "<Parent> — Change Order N" and this context line renders
    // truncated, so the suffix is the first thing lost. Display-only -- the stored name is unchanged.
    const dealName = formatDealDisplayName(task.dealName, task.dealIsChangeOrder);
    return displayNumber === "Pending" ? dealName : `${displayNumber} - ${dealName}`;
  }
  if (displayNumber !== "Pending") return displayNumber;
  return "Project linked";
}
