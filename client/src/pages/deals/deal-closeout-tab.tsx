import { useState, useEffect, useCallback } from "react";
import { CheckCircle, Circle, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

interface CloseoutItem {
  id: string;
  dealId: string;
  stepKey: string;
  label: string;
  isCompleted: boolean;
  completedBy: string | null;
  completedAt: string | null;
  notes: string | null;
  displayOrder: number;
  createdAt: string;
}

const TOTAL_STEPS = 6;

interface DealCloseoutTabProps {
  dealId: string;
}

export function DealCloseoutTab({ dealId }: DealCloseoutTabProps) {
  const [items, setItems] = useState<CloseoutItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(false);

  const fetchCloseout = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ items: CloseoutItem[] }>(`/deals/${dealId}/closeout`);
      setItems(data.items);
      setError(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to load close-out checklist");
      setError("Failed to load close-out checklist");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    fetchCloseout();
  }, [fetchCloseout]);

  const handleInitialize = async () => {
    setInitializing(true);
    try {
      await api(`/deals/${dealId}/closeout/initialize`, { method: "POST" });
      fetchCloseout();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to initialize checklist");
    } finally {
      setInitializing(false);
    }
  };

  const handleToggle = async (item: CloseoutItem) => {
    try {
      await api(`/deals/${dealId}/closeout/${item.id}`, {
        method: "PATCH",
        json: { isCompleted: !item.isCompleted },
      });
      fetchCloseout();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update step");
    }
  };

  const handleNotesUpdate = async (item: CloseoutItem, notes: string) => {
    try {
      await api(`/deals/${dealId}/closeout/${item.id}`, {
        method: "PATCH",
        json: { notes: notes.trim() || null },
      });
      fetchCloseout();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save notes");
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
          <div key={i} className="h-14 bg-muted animate-pulse rounded-lg" />
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
          onClick={fetchCloseout}
        >
          Retry
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12 border rounded-lg bg-muted/20">
        <CheckCircle className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
        <p className="text-sm text-muted-foreground mb-3">
          Close-out checklist not yet initialized for this deal.
        </p>
        <Button size="sm" onClick={handleInitialize} disabled={initializing}>
          {initializing ? "Initializing..." : "Initialize Checklist"}
        </Button>
      </div>
    );
  }

  const completedCount = items.filter((i) => i.isCompleted).length;
  const allComplete = completedCount === items.length;

  return (
    <div className="space-y-4">
      {/* Progress */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            {completedCount}/{items.length} steps completed
          </span>
          {allComplete && (
            <span className="text-green-600 font-semibold flex items-center gap-1">
              <CheckCircle className="h-4 w-4" />
              All steps complete — ready to close
            </span>
          )}
        </div>
        <div className="h-2 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              allComplete ? "bg-green-500" : "bg-brand-red"
            }`}
            style={{ width: `${items.length > 0 ? (completedCount / items.length) * 100 : 0}%` }}
          />
        </div>
      </div>

      {/* Checklist items */}
      <div className="space-y-2">
        {items
          .sort((a, b) => a.displayOrder - b.displayOrder)
          .map((item) => (
            <CloseoutItemRow
              key={item.id}
              item={item}
              onToggle={() => handleToggle(item)}
              onSaveNotes={(notes) => handleNotesUpdate(item, notes)}
            />
          ))}
      </div>
    </div>
  );
}

function CloseoutItemRow({
  item,
  onToggle,
  onSaveNotes,
}: {
  item: CloseoutItem;
  onToggle: () => void;
  onSaveNotes: (notes: string) => void;
}) {
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [notes, setNotes] = useState(item.notes ?? "");
  const [notesDirty, setNotesDirty] = useState(false);

  return (
    <div
      className={`border rounded-lg transition-colors ${
        item.isCompleted ? "bg-green-50/50 border-green-200" : "bg-card"
      }`}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        {/* Step number + checkbox */}
        <button
          onClick={onToggle}
          className="flex-shrink-0 mt-0.5 focus:outline-none"
          aria-label={item.isCompleted ? "Mark incomplete" : "Mark complete"}
        >
          {item.isCompleted ? (
            <CheckCircle className="h-5 w-5 text-green-600" />
          ) : (
            <Circle className="h-5 w-5 text-muted-foreground hover:text-green-600 transition-colors" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="text-xs text-muted-foreground font-medium mr-2">
                Step {item.displayOrder}
              </span>
              <span
                className={`text-sm font-medium ${
                  item.isCompleted ? "line-through text-muted-foreground" : ""
                }`}
              >
                {item.label}
              </span>
            </div>
            <button
              onClick={() => setNotesExpanded((p) => !p)}
              className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center -m-2"
              aria-label="Toggle notes"
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${notesExpanded ? "rotate-180" : ""}`}
              />
            </button>
          </div>

          {item.isCompleted && item.completedAt && (
            <p className="text-xs text-green-600 mt-1">
              {`Completed on ${new Date(item.completedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}`}
            </p>
          )}
        </div>
      </div>

      {/* Notes section */}
      {notesExpanded && (
        <div className="px-4 pb-3 border-t bg-muted/10">
          <div className="pt-3 space-y-2">
            <label htmlFor={`closeout-notes-${item.id}`} className="text-xs text-muted-foreground font-medium">Notes</label>
            <Textarea
              id={`closeout-notes-${item.id}`}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                setNotesDirty(true);
              }}
              placeholder="Add notes for this step..."
              rows={2}
              className="text-sm"
            />
            {notesDirty && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    onSaveNotes(notes);
                    setNotesDirty(false);
                  }}
                >
                  Save Notes
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => {
                    setNotes(item.notes ?? "");
                    setNotesDirty(false);
                  }}
                >
                  Discard
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
