import { useState } from "react";
import { toast } from "sonner";
import type { TaskAssignee } from "@/hooks/use-task-assignees";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";

const UNASSIGNED_OWNER_VALUE = "__unassigned__";

type OwnerAssignmentUser = {
  id: string;
  role: string;
};

interface OwnerAssignmentControlProps {
  ownerUserId?: string | null;
  currentUser: OwnerAssignmentUser | null;
  assignees: TaskAssignee[];
  ownerReassignAssignees?: TaskAssignee[];
  assigneesLoading?: boolean;
  ownerReassignAssigneesLoading?: boolean;
  entityLabel: "company" | "contact";
  onAssignToMe: () => Promise<unknown>;
  onReassign: (ownerUserId: string | null) => Promise<unknown>;
  onAssigned: () => void;
}

function canReassign(user: OwnerAssignmentUser | null) {
  return user?.role === "admin" || user?.role === "director";
}

export function OwnerAssignmentControl({
  ownerUserId,
  currentUser,
  assignees,
  ownerReassignAssignees,
  assigneesLoading = false,
  ownerReassignAssigneesLoading,
  entityLabel,
  onAssignToMe,
  onReassign,
  onAssigned,
}: OwnerAssignmentControlProps) {
  const [saving, setSaving] = useState(false);
  const isManager = canReassign(currentUser);
  const isCurrentOwner = Boolean(currentUser?.id && ownerUserId && currentUser.id === ownerUserId);
  const canUseReassignControl = isManager || isCurrentOwner;
  const reassignAssignees = isManager ? assignees : ownerReassignAssignees ?? assignees;
  const reassignAssigneesLoading = isManager ? assigneesLoading : ownerReassignAssigneesLoading ?? assigneesLoading;
  const ownerValue = ownerUserId ?? UNASSIGNED_OWNER_VALUE;
  const currentOwnerAssignee = ownerUserId ? reassignAssignees.find((assignee) => assignee.id === ownerUserId) : undefined;
  const hasInactiveOrUnknownOwner = Boolean(ownerUserId && !currentOwnerAssignee);
  const currentOwnerLabel = reassignAssigneesLoading
    ? "Loading owners..."
    : ownerUserId
      ? currentOwnerAssignee?.displayName ?? "Inactive or unknown owner"
      : "Unassigned";

  async function runMutation(action: () => Promise<unknown>, successMessage: string) {
    setSaving(true);
    try {
      await action();
      onAssigned();
      toast.success(successMessage);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update owner");
    } finally {
      setSaving(false);
    }
  }

  if (canUseReassignControl) {
    return (
      <div
        className="w-44"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Select
          value={ownerValue}
          disabled={saving || reassignAssigneesLoading}
          onValueChange={(value) => {
            const nextOwnerId = value === UNASSIGNED_OWNER_VALUE ? null : value;
            if ((nextOwnerId ?? UNASSIGNED_OWNER_VALUE) === ownerValue) return;
            void runMutation(
              () => onReassign(nextOwnerId),
              `${entityLabel === "company" ? "Company" : "Contact"} owner updated`
            );
          }}
        >
          <SelectTrigger className="h-8 min-h-[44px] md:min-h-0 border-slate-200 bg-slate-50 text-xs" aria-label="Reassign owner">
            <span className="truncate">{currentOwnerLabel}</span>
          </SelectTrigger>
          <SelectContent>
            {isManager ? <SelectItem value={UNASSIGNED_OWNER_VALUE}>Unassigned</SelectItem> : null}
            {hasInactiveOrUnknownOwner ? (
              <SelectItem value={ownerUserId!}>Inactive or unknown owner</SelectItem>
            ) : null}
            {reassignAssignees.map((assignee) => (
              <SelectItem key={assignee.id} value={assignee.id}>
                {assignee.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (!currentUser || ownerUserId) return null;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 min-h-[44px] md:min-h-0 w-fit px-2 text-[11px]"
      disabled={saving}
      onClick={(event) => {
        event.stopPropagation();
        void runMutation(onAssignToMe, `${entityLabel === "company" ? "Company" : "Contact"} assigned to you`);
      }}
    >
      Assign to me
    </Button>
  );
}
