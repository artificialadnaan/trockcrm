import { useState, useEffect } from "react";
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
import { updateTask } from "@/hooks/use-tasks";
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

export function TaskEditDialog({ task, open, onOpenChange, onUpdated }: TaskEditDialogProps) {
  const { user } = useAuth();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [priority, setPriority] = useState(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
  const [assignedTo, setAssignedTo] = useState(task.assignedTo);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);

  const canAssign = user?.role === "admin" || user?.role === "director";
  const isTerminal = task.status === "completed" || task.status === "dismissed";

  // Reset form when task changes
  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description ?? "");
    setPriority(task.priority);
    setDueDate(task.dueDate ?? "");
    setAssignedTo(task.assignedTo);
    setError(null);
  }, [task]);

  // Fetch assignees for directors/admins
  useEffect(() => {
    if (!canAssign || !open) return;
    api<{ users: Assignee[] }>("/tasks/assignees")
      .then((data) => setAssignees(data.users))
      .catch(() => setAssignees([]));
  }, [canAssign, open]);

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

  // Don't open the dialog for completed/dismissed tasks
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
          {canAssign && assignees.length > 0 && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Assignee</label>
              <Select value={assignedTo} onValueChange={(v) => setAssignedTo(v ?? assignedTo)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {assignees.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
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
