import { useState, useEffect, useRef } from "react";
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
import { ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { createProjectTask, createTask } from "@/hooks/use-tasks";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { formatDealDisplayName, formatDealDisplayNumber } from "@/lib/deal-utils";

interface Assignee {
  id: string;
  displayName: string;
}

interface DealOption {
  id: string;
  dealNumber: string;
  projectNumber?: string | null;
  name: string;
}

const PROJECT_SEARCH_DEBOUNCE_MS = 150;
/** The deals API ignores a search term shorter than this, so don't fire a request for one. */
const PROJECT_SEARCH_MIN_CHARS = 2;

// A change-order child deal is STORED as "<Parent> — Change Order N", which this option label
// truncates away. formatDealDisplayName moves the label to the front; DISPLAY-ONLY, never persisted.
function dealOptionLabel(deal: DealOption) {
  const display = formatDealDisplayNumber(deal);
  const name = formatDealDisplayName(deal.name);
  return display.isPending ? name : `${display.label} - ${name}`;
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
  const [selectedDeal, setSelectedDeal] = useState<DealOption | null>(null);
  const [dealPickerOpen, setDealPickerOpen] = useState(false);
  const [dealQuery, setDealQuery] = useState("");
  const [dealsLoading, setDealsLoading] = useState(false);
  const [dealsError, setDealsError] = useState<string | null>(null);
  const dealPickerRef = useRef<HTMLDivElement>(null);

  const canAssign = user?.role === "admin" || user?.role === "director" || user?.role === "rep";
  const isProjectScoped = Boolean(projectScopedProjectId);

  // Fetch assignees for every role that can create assignable tasks.
  useEffect(() => {
    if (!canAssign || !open) return;
    api<{ users: Assignee[] }>("/tasks/assignees")
      .then((data) => setAssignees(data.users))
      .catch(() => setAssignees([]));
  }, [canAssign, open]);

  // Resolve the project list server-side. A fixed page of 50 meant any project outside that page
  // was simply unattachable — the assignee then got a task with no project on it.
  useEffect(() => {
    if (defaultDealId || !open || isProjectScoped || !dealPickerOpen) return;

    let cancelled = false;
    const trimmed = dealQuery.trim();
    // scope=all because /deals otherwise defaults to the caller's OWN deals (readListScope →
    // "mine"), which is the whole bug: you cannot attach a project you don't own, which is exactly
    // the cross-user assignment case reported. POST /tasks accepts any deal id, and scope=all
    // elevates the read office-wide — the same thing the photo-feed deal picker does.
    const query =
      trimmed.length >= PROJECT_SEARCH_MIN_CHARS
        ? `/deals?scope=all&limit=20&isActive=true&search=${encodeURIComponent(trimmed)}`
        : "/deals?scope=all&limit=50&isActive=true";

    // Retire the previous results *now*, not when the debounce fires — otherwise results for the
    // old query stay on screen and selectable for PROJECT_SEARCH_DEBOUNCE_MS after the user has
    // typed something they no longer match.
    setDeals([]);
    setDealsLoading(true);
    setDealsError(null);

    const timer = setTimeout(() => {
      api<{ deals: DealOption[] }>(query)
        .then((data) => {
          if (!cancelled) setDeals(data.deals ?? []);
        })
        .catch(() => {
          // Surface the failure — silently rendering an empty picker is what hid this before.
          if (!cancelled) {
            setDeals([]);
            setDealsError("Couldn't load projects — try again");
          }
        })
        .finally(() => {
          if (!cancelled) setDealsLoading(false);
        });
    }, PROJECT_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [dealPickerOpen, dealQuery, defaultDealId, isProjectScoped, open]);

  // Close the project dropdown on outside click.
  useEffect(() => {
    if (!dealPickerOpen) return;
    function handleClick(event: MouseEvent) {
      if (dealPickerRef.current && !dealPickerRef.current.contains(event.target as Node)) {
        setDealPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dealPickerOpen]);

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
      setSelectedDeal(null);
      setDealQuery("");
      setDealPickerOpen(false);
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
                  <SelectValue placeholder={isProjectScoped ? "Choose assignee" : "Assign to teammate"} />
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
          {!defaultDealId && !isProjectScoped && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Link to Project (optional)</label>
              <div className="relative" ref={dealPickerRef}>
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Choose a linked project"
                  aria-expanded={dealPickerOpen}
                  className="w-full justify-between font-normal"
                  onClick={() => setDealPickerOpen((prev) => !prev)}
                >
                  <span className={selectedDeal ? "truncate text-foreground" : "truncate text-muted-foreground"}>
                    {selectedDeal ? dealOptionLabel(selectedDeal) : "No project linked"}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 opacity-50" />
                </Button>

                {dealPickerOpen && (
                  <div className="absolute z-50 mt-1 w-full rounded-md border bg-background shadow-md">
                    <div className="border-b p-2">
                      <Input
                        autoFocus
                        placeholder="Search projects..."
                        value={dealQuery}
                        onChange={(e) => setDealQuery(e.target.value)}
                        // This input lives inside the create form — without this, Enter while
                        // searching submits the form and creates the task mid-search.
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            e.stopPropagation();
                          }
                        }}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="max-h-52 overflow-y-auto">
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                        onClick={() => {
                          setSelectedDeal(null);
                          setDealId("");
                          setDealPickerOpen(false);
                        }}
                      >
                        No project linked
                      </button>
                      {dealsLoading && (
                        <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Searching...
                        </div>
                      )}
                      {dealsError && <p className="px-3 py-2 text-sm text-red-600">{dealsError}</p>}
                      {!dealsLoading && !dealsError && deals.length === 0 && (
                        <p className="px-3 py-2 text-sm text-muted-foreground">No projects found.</p>
                      )}
                      {!dealsLoading &&
                        deals.map((d) => (
                          <button
                            key={d.id}
                            type="button"
                            className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                            onClick={() => {
                              setSelectedDeal(d);
                              setDealId(d.id);
                              setDealPickerOpen(false);
                            }}
                          >
                            {dealOptionLabel(d)}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
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
