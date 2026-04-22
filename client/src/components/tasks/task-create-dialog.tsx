import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "lucide-react";
import { createProjectTask, createTask } from "@/hooks/use-tasks";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";

interface Assignee {
  id: string;
  displayName: string;
}

interface DealOption {
  id: string;
  dealNumber: string;
  name: string;
}

interface TaskCreateDialogProps {
  onCreated: () => void;
  defaultDealId?: string;
  defaultContactId?: string;
  projectScopedProjectId?: string;
}

export function TaskCreateDialog({
  onCreated,
  defaultDealId,
  defaultContactId,
  projectScopedProjectId,
}: TaskCreateDialogProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("normal");
  const [dueDate, setDueDate] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [dealId, setDealId] = useState(defaultDealId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [deals, setDeals] = useState<DealOption[]>([]);

  const canAssign = user?.role === "admin" || user?.role === "director";
  const isProjectScoped = Boolean(projectScopedProjectId);

  // Fetch assignees for directors/admins
  useEffect(() => {
    if (!canAssign || !open) return;
    api<{ users: Assignee[] }>("/tasks/assignees")
      .then((data) => setAssignees(data.users))
      .catch(() => setAssignees([]));
  }, [canAssign, open]);

  // Fetch deals for the deal picker (only if no defaultDealId)
  useEffect(() => {
    if (defaultDealId || !open || isProjectScoped) return;
    api<{ deals: DealOption[] }>("/deals?limit=50&isActive=true")
      .then((data) => setDeals(data.deals))
      .catch(() => setDeals([]));
  }, [defaultDealId, isProjectScoped, open]);

  useEffect(() => {
    if (!open) return;
    if (isProjectScoped && canAssign && !assignedTo && user?.id) {
      setAssignedTo(user.id);
    }
  }, [assignedTo, canAssign, isProjectScoped, open, user?.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      if (isProjectScoped && projectScopedProjectId) {
        if (!assignedTo) {
          throw new Error("Choose an assignee");
        }
        await createProjectTask(projectScopedProjectId, {
          title: title.trim(),
          description: description.trim() || undefined,
          type: "manual",
          priority,
          dueDate: dueDate || undefined,
          assignedTo,
        });
      } else {
        await createTask({
          title: title.trim(),
          description: description.trim() || undefined,
          type: "manual",
          priority,
          dueDate: dueDate || undefined,
          assignedTo: canAssign && assignedTo ? assignedTo : undefined,
          dealId: dealId || defaultDealId || undefined,
          contactId: defaultContactId,
        } as Parameters<typeof createTask>[0]);
      }
      setTitle("");
      setDescription("");
      setPriority("normal");
      setDueDate("");
      setAssignedTo("");
      setDealId(defaultDealId ?? "");
      setOpen(false);
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="h-4 w-4 mr-1" /> New Task
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
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
              <Select value={assignedTo} onValueChange={(v) => setAssignedTo(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder={isProjectScoped ? "Choose assignee" : "Assign to myself"} />
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
          {!defaultDealId && !isProjectScoped && deals.length > 0 && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Link to Deal (optional)</label>
              <Select value={dealId || "__none__"} onValueChange={(v) => setDealId(v === "__none__" ? "" : (v ?? ""))}>
                <SelectTrigger>
                  <SelectValue placeholder="No deal linked" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No deal linked</SelectItem>
                  {deals.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.dealNumber} - {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !title.trim()}>
              {submitting ? "Creating..." : "Create Task"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
