import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  updateTask,
  transitionTask,
  getTaskStatusLabel,
  isTerminalTaskStatus,
} from "@/hooks/use-tasks";
import type { Task } from "@/hooks/use-tasks";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";

interface Assignee {
  id: string;
  displayName: string;
}

interface TaskEditDialogProps {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}

function toDatetimeLocalValue(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function TaskEditDialog({ task, open, onOpenChange, onUpdated }: TaskEditDialogProps) {
  const { user } = useAuth();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [priority, setPriority] = useState(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
  const [assignedTo, setAssignedTo] = useState(task.assignedTo);
  const [scheduledFor, setScheduledFor] = useState(toDatetimeLocalValue(task.scheduledFor));
  const [waitingOnText, setWaitingOnText] = useState("");
  const [blockedByText, setBlockedByText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);

  const canAssign = user?.role === "admin" || user?.role === "director";
  const isTerminal = isTerminalTaskStatus(task.status);
  const statusLabel = getTaskStatusLabel(task.status);

  const assigneeOptions = useMemo(() => {
    if (!canAssign) return [];
    if (task.assignedTo && !assignees.some((u) => u.id === task.assignedTo)) {
      return [
        {
          id: task.assignedTo,
          displayName: task.assignedToName ?? "Current assignee",
        },
        ...assignees,
      ];
    }
    return assignees;
  }, [assignees, canAssign, task.assignedTo, task.assignedToName]);

  // Reset form when task changes
  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description ?? "");
    setPriority(task.priority);
    setDueDate(task.dueDate ?? "");
    setAssignedTo(task.assignedTo);
    setScheduledFor(toDatetimeLocalValue(task.scheduledFor));
    setWaitingOnText("");
    setBlockedByText("");
    setError(null);
    setTransitionError(null);
  }, [task]);

  // Fetch assignees for directors/admins
  useEffect(() => {
    if (!canAssign || !open) return;
    api<{ users: Assignee[] }>("/tasks/assignees")
      .then((data) => setAssignees(data.users))
      .catch(() => setAssignees([]));
  }, [canAssign, open]);

  const handleTransition = async (nextStatus: "pending" | "scheduled" | "in_progress" | "waiting_on" | "blocked" | "completed" | "dismissed") => {
    setTransitioning(true);
    setTransitionError(null);
    try {
      if (nextStatus === "completed") {
        await transitionTask(task.id, { nextStatus });
      } else if (nextStatus === "dismissed") {
        await transitionTask(task.id, { nextStatus });
      } else if (nextStatus === "scheduled") {
        if (!scheduledFor) {
          throw new Error("Choose a scheduled date and time");
        }
        await transitionTask(task.id, {
          nextStatus,
          scheduledFor: new Date(scheduledFor).toISOString(),
        });
      } else if (nextStatus === "waiting_on") {
        const note = waitingOnText.trim();
        if (!note) {
          throw new Error("Add a waiting-on note");
        }
        await transitionTask(task.id, {
          nextStatus,
          waitingOn: { note },
        });
      } else if (nextStatus === "blocked") {
        const note = blockedByText.trim();
        if (!note) {
          throw new Error("Add a blocked-by note");
        }
        await transitionTask(task.id, {
          nextStatus,
          blockedBy: { note },
        });
      } else {
        await transitionTask(task.id, { nextStatus });
      }
      onOpenChange(false);
      onUpdated();
    } catch (err: unknown) {
      setTransitionError(err instanceof Error ? err.message : "Failed to update task lifecycle");
    } finally {
      setTransitioning(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      const changes: Record<string, unknown> = {};
      if (title.trim() !== task.title) changes.title = title.trim();
      if ((description.trim() || null) !== (task.description || null)) changes.description = description.trim() || null;
      if (priority !== task.priority) changes.priority = priority;
      if ((dueDate || null) !== (task.dueDate || null)) changes.dueDate = dueDate || null;
      if (assignedTo !== task.assignedTo && canAssign) changes.assignedTo = assignedTo;

      if (Object.keys(changes).length > 0) {
        await updateTask(task.id, changes);
      }
      onOpenChange(false);
      onUpdated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update task");
    } finally {
      setSubmitting(false);
    }
  };

  // Don't keep terminal tasks open if this dialog is invoked from stale UI state.
  if (isTerminal && open) {
    onOpenChange(false);
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Task</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
          <Textarea
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Priority</label>
              <Select value={priority} onValueChange={(v) => setPriority(v ?? "normal")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Due Date</label>
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>
          {canAssign && assigneeOptions.length > 0 && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Assignee</label>
              <Select value={assignedTo} onValueChange={(v) => setAssignedTo(v ?? assignedTo)}>
                <SelectTrigger>
                  <SelectValue placeholder={task.assignedToName ?? "Unassigned"} />
                </SelectTrigger>
                <SelectContent>
                  {assigneeOptions.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {!isTerminal && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Lifecycle
                  </p>
                  <p className="text-sm font-medium">{statusLabel}</p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={transitioning}
                  onClick={() => handleTransition("in_progress")}
                >
                  Mark In Progress
                </Button>
              </div>
              <div className="grid gap-3">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs text-muted-foreground block">Schedule task</label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={transitioning}
                      onClick={() => handleTransition("scheduled")}
                    >
                      Apply
                    </Button>
                  </div>
                  <Input
                    type="datetime-local"
                    value={scheduledFor}
                    onChange={(e) => setScheduledFor(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs text-muted-foreground block">Waiting on</label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={transitioning}
                      onClick={() => handleTransition("waiting_on")}
                    >
                      Apply
                    </Button>
                  </div>
                  <Textarea
                    value={waitingOnText}
                    onChange={(e) => setWaitingOnText(e.target.value)}
                    placeholder="What is the task waiting on?"
                    rows={2}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs text-muted-foreground block">Blocked by</label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={transitioning}
                      onClick={() => handleTransition("blocked")}
                    >
                      Apply
                    </Button>
                  </div>
                  <Textarea
                    value={blockedByText}
                    onChange={(e) => setBlockedByText(e.target.value)}
                    placeholder="What is blocking the task?"
                    rows={2}
                  />
                </div>
              </div>
            </div>
          )}
          {transitionError && <p className="text-sm text-red-600">{transitionError}</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !title.trim()}>
              {submitting ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
