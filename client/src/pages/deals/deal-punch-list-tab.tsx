import { useState, useEffect, useCallback } from "react";
import { Plus, ClipboardList, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { PRIORITY_COLORS, PUNCH_STATUS_COLORS } from "@/lib/status-colors";

type PunchPriority = "urgent" | "high" | "normal" | "low";
type PunchStatus = "open" | "in_progress" | "completed";
type PunchSection = "internal" | "external";

interface PunchItem {
  id: string;
  dealId: string;
  type: PunchSection;
  title: string;
  description: string | null;
  assignedTo: string | null;
  priority: PunchPriority;
  status: PunchStatus;
  location: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface AdminUser {
  id: string;
  displayName: string;
}


const PRIORITY_LABELS: Record<PunchPriority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

const STATUS_LABELS: Record<PunchStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  completed: "Completed",
};

interface DealPunchListTabProps {
  dealId: string;
}

export function DealPunchListTab({ dealId }: DealPunchListTabProps) {
  const [items, setItems] = useState<PunchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  const fetchPunchList = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ items: PunchItem[] }>(`/deals/${dealId}/punch-list`);
      setItems(data.items);
      setError(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to load punch list");
      setError("Failed to load punch list");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    fetchPunchList();
  }, [fetchPunchList]);

  const handleToggleComplete = async (item: PunchItem) => {
    try {
      await api(`/deals/${dealId}/punch-list/${item.id}/complete`, { method: "POST" });
      fetchPunchList();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update item");
    }
  };

  const toggleSection = (section: string) => {
    setCollapsedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const internal = items.filter((i) => i.type === "internal");
  const external = items.filter((i) => i.type === "external");
  const totalCompleted = items.filter((i) => i.status === "completed").length;

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-muted-foreground">{error}</p>
        <button
          className="mt-2 text-sm text-[#CC0000] hover:underline"
          onClick={fetchPunchList}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Overall progress header */}
      {items.length > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {totalCompleted} of {items.length} items complete
          </span>
          <div className="w-48 h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all"
              style={{ width: `${items.length > 0 ? (totalCompleted / items.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      <PunchSection
        title="Internal Punch List"
        section="internal"
        items={internal}
        dealId={dealId}
        collapsed={!!collapsedSections["internal"]}
        onToggle={() => toggleSection("internal")}
        onToggleComplete={handleToggleComplete}
        onAdded={fetchPunchList}
      />

      <PunchSection
        title="External Punch List"
        section="external"
        items={external}
        dealId={dealId}
        collapsed={!!collapsedSections["external"]}
        onToggle={() => toggleSection("external")}
        onToggleComplete={handleToggleComplete}
        onAdded={fetchPunchList}
      />
    </div>
  );
}

function PunchSection({
  title,
  section,
  items,
  dealId,
  collapsed,
  onToggle,
  onToggleComplete,
  onAdded,
}: {
  title: string;
  section: PunchSection;
  items: PunchItem[];
  dealId: string;
  collapsed: boolean;
  onToggle: () => void;
  onToggleComplete: (item: PunchItem) => void;
  onAdded: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const completed = items.filter((i) => i.status === "completed").length;
  const pct = items.length > 0 ? (completed / items.length) * 100 : 0;

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Section header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-muted/30 border-b">
        <button
          onClick={onToggle}
          className="text-muted-foreground hover:text-foreground transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center -m-2"
          aria-label={collapsed ? "Expand section" : "Collapse section"}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>
        <span className="text-sm font-semibold flex-1">{title}</span>
        <span className="text-xs text-muted-foreground">
          {completed}/{items.length} complete
        </span>
        <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger
            render={
              <Button size="sm" variant="outline" className="h-7 text-xs">
                <Plus className="h-3 w-3 mr-1" />
                Add Item
              </Button>
            }
          />
          <AddPunchItemDialog
            dealId={dealId}
            section={section}
            onAdded={() => {
              setDialogOpen(false);
              onAdded();
            }}
          />
        </Dialog>
      </div>

      {/* Items */}
      {!collapsed && (
        <div>
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              <ClipboardList className="h-6 w-6 mx-auto mb-2 text-muted-foreground/50" />
              No items yet
            </div>
          ) : (
            <div className="divide-y">
              {items.map((item) => (
                <PunchItemRow
                  key={item.id}
                  item={item}
                  onToggleComplete={() => onToggleComplete(item)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PunchItemRow({
  item,
  onToggleComplete,
}: {
  item: PunchItem;
  onToggleComplete: () => void;
}) {
  const isCompleted = item.status === "completed";

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors">
      <button
        role="checkbox"
        aria-checked={isCompleted}
        aria-label={`Mark ${item.title} as complete`}
        onClick={onToggleComplete}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onToggleComplete();
          }
        }}
        className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#CC0000] ${
          isCompleted
            ? "bg-green-500 border-green-500 text-white"
            : "border-muted-foreground hover:border-green-500"
        }`}
      >
        {isCompleted && (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 12 12">
            <path
              d="M2 6l3 3 5-5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>

      <div className="flex-1 min-w-0">
        <p
          className={`text-sm font-medium truncate ${
            isCompleted ? "line-through text-muted-foreground" : ""
          }`}
        >
          {item.title}
        </p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {item.location && (
            <span className="text-xs text-muted-foreground">{item.location}</span>
          )}
        </div>
      </div>

      <Badge
        variant="outline"
        className={`text-xs flex-shrink-0 ${PRIORITY_COLORS[item.priority]}`}
      >
        {PRIORITY_LABELS[item.priority]}
      </Badge>
      <Badge
        variant="outline"
        className={`text-xs flex-shrink-0 ${PUNCH_STATUS_COLORS[item.status]}`}
      >
        {STATUS_LABELS[item.status]}
      </Badge>
    </div>
  );
}

function AddPunchItemDialog({
  dealId,
  section,
  onAdded,
}: {
  dealId: string;
  section: PunchSection;
  onAdded: () => void;
}) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [title, setTitle] = useState("");
  const [titleError, setTitleError] = useState(false);
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [priority, setPriority] = useState<PunchPriority>("normal");
  const [location, setLocation] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<{ users: AdminUser[] }>("/admin/users")
      .then((data) => setUsers(data.users))
      .catch(() => toast.error("Failed to load users"));
  }, []);

  const handleSubmit = async () => {
    if (!title.trim()) {
      setTitleError(true);
      toast.error("Title is required");
      return;
    }
    setSubmitting(true);
    try {
      await api(`/deals/${dealId}/punch-list`, {
        method: "POST",
        json: {
          type: section,
          title: title.trim(),
          description: description.trim() || null,
          assignedTo: assigneeId || null,
          priority,
          location: location.trim() || null,
        },
      });
      toast.success("Item added");
      onAdded();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to add item");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Add Punch List Item</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 pt-2">
        <div className="space-y-1.5">
          <label htmlFor="punch-title" className="text-sm font-medium">Title *</label>
          <Input
            id="punch-title"
            autoFocus
            required
            aria-required="true"
            aria-invalid={titleError ? "true" : undefined}
            value={title}
            onChange={(e) => { setTitle(e.target.value); setTitleError(false); }}
            placeholder="What needs to be done?"
          />
          {titleError && <p className="text-xs text-red-500 mt-1">Title is required</p>}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="punch-description" className="text-sm font-medium">Description</label>
          <Textarea
            id="punch-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Additional details..."
            rows={2}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label id="punch-assignee-label" htmlFor="punch-assignee" className="text-sm font-medium">Assignee</label>
            <Select value={assigneeId} onValueChange={(v) => setAssigneeId(v ?? "")}>
              <SelectTrigger id="punch-assignee" aria-labelledby="punch-assignee-label">
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Unassigned</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label id="punch-priority-label" htmlFor="punch-priority" className="text-sm font-medium">Priority</label>
            <Select value={priority} onValueChange={(v) => setPriority((v ?? "normal") as PunchPriority)}>
              <SelectTrigger id="punch-priority" aria-labelledby="punch-priority-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PRIORITY_LABELS) as PunchPriority[]).map((p) => (
                  <SelectItem key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="punch-location" className="text-sm font-medium">Location</label>
          <Input
            id="punch-location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. Room 204, North wall"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onAdded} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Adding..." : "Add Item"}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}
