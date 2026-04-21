import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { OfficeAssignee, OwnershipQueueRow } from "@/hooks/use-migration";
import { getOwnershipQueueRowKey } from "./ownership-queue-table";
import { normalizeAssigneeSelection } from "./ownership-reassign-selection";

interface OwnershipReassignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  officeId?: string;
  officeName: string;
  rows: OwnershipQueueRow[];
  onReassign: (assigneeId: string) => Promise<void> | void;
}

export function OwnershipReassignDialog({
  open,
  onOpenChange,
  officeId,
  officeName,
  rows,
  onReassign,
}: OwnershipReassignDialogProps) {
  const [assignees, setAssignees] = useState<OfficeAssignee[]>([]);
  const [loadingAssignees, setLoadingAssignees] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assigneeId, setAssigneeId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const selectedSummary = useMemo(
    () =>
      rows
        .slice(0, 5)
        .map((row) => `${row.recordName} (${row.recordType})`)
        .join(", "),
    [rows]
  );

  useEffect(() => {
    if (!open) return;

    let ignore = false;
    const loadAssignees = async () => {
      setLoadingAssignees(true);
      setError(null);
      setAssigneeId("");
      try {
        const data = await api<{ users: OfficeAssignee[] }>("/tasks/assignees", {
          headers: officeId ? { "x-office-id": officeId } : undefined,
        });
        const nextUsers = data.users ?? [];
        if (!ignore) {
          setAssignees(nextUsers);
          setAssigneeId((current) => normalizeAssigneeSelection(current, nextUsers));
        }
      } catch (err) {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Failed to load assignees");
        }
      } finally {
        if (!ignore) setLoadingAssignees(false);
      }
    };

    void loadAssignees();

    return () => {
      ignore = true;
    };
  }, [officeId, open]);

  useEffect(() => {
    if (!open) {
      setAssigneeId("");
      setAssignees([]);
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!assigneeId || rows.length === 0) return;

    setSubmitting(true);
    setError(null);
    try {
      await onReassign(assigneeId);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reassign ownership rows");
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = !submitting && !loadingAssignees && rows.length > 0 && assigneeId.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Reassign ownership queue</DialogTitle>
          <DialogDescription>
            Move {rows.length.toLocaleString()} selected record{rows.length === 1 ? "" : "s"} in {officeName} to a valid CRM owner.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border bg-slate-50 p-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
              Selected records
            </div>
            <div className="text-sm text-slate-700">{selectedSummary || "No rows selected"}</div>
            {rows.length > 5 && (
              <div className="mt-2 text-xs text-slate-500">
                + {rows.length - 5} more
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-1">
              {rows.slice(0, 3).map((row) => (
                <Badge key={getOwnershipQueueRowKey(row)} variant="outline">
                  {row.recordType}
                </Badge>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-900" htmlFor="ownership-assignee">
              Assignee
            </label>
            <Select value={assigneeId} onValueChange={(value) => setAssigneeId(value ?? "")} disabled={loadingAssignees}>
              <SelectTrigger id="ownership-assignee">
                <SelectValue placeholder={loadingAssignees ? "Loading assignees..." : "Select an office user"} />
              </SelectTrigger>
              <SelectContent>
                {assignees.map((assignee) => (
                  <SelectItem key={assignee.id} value={assignee.id}>
                    {assignee.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-slate-500">
              The server will verify the assignee has access to this office before applying the change.
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Reassigning...
              </>
            ) : (
              "Reassign selected"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
