import type { OfficeAssignee } from "@/hooks/use-migration";

export function normalizeAssigneeSelection(currentAssigneeId: string, assignees: OfficeAssignee[]) {
  if (currentAssigneeId && assignees.some((assignee) => assignee.id === currentAssigneeId)) {
    return currentAssigneeId;
  }

  return assignees[0]?.id ?? "";
}
