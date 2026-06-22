import { useEffect, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateDeal } from "@/hooks/use-deals";
import { createActivity } from "@/hooks/use-activities";

interface MoveCloseDateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealId: string;
  /** The deal's current expected_close_date ("YYYY-MM-DD") used to seed the picker. */
  currentDate: string | null;
  /** Called after a successful save so the caller can refetch the deal + activity feed. */
  onSaved: () => void | Promise<void>;
}

/** Render a "YYYY-MM-DD" as a readable local date with no timezone drift (no Date(string) parse). */
function formatHuman(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * "Move Close Date" — postpones a deal's close target and records why. Moving the close date forward
 * postpones the stage-age SLA until that date passes (the shared close-target suppression rule), and the
 * reason is logged as a note on the deal's activity feed. The date write is load-bearing (it drives the
 * SLA), so it runs first; the note is a best-effort audit trail layered on top.
 */
export function MoveCloseDateDialog({ open, onOpenChange, dealId, currentDate, onSaved }: MoveCloseDateDialogProps) {
  const [date, setDate] = useState(currentDate ?? "");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed each time the dialog opens (the current close date may have changed since last open).
  useEffect(() => {
    if (open) {
      setDate(currentDate ?? "");
      setReason("");
      setError(null);
    }
  }, [open, currentDate]);

  const canSave = date !== "" && reason.trim() !== "" && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      // 1) Move the close target — this is what postpones the SLA, so persist it first.
      await updateDeal(dealId, { expectedCloseDate: date });
      // 2) Record WHY as a note on the activity feed (the date is already saved if this throws).
      await createActivity({
        type: "note",
        subject: `Close target moved to ${formatHuman(date)}`,
        body: reason.trim(),
        dealId,
      });
      await onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't move the close date. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move close date</DialogTitle>
          <DialogDescription>
            Pick a new close target and add a short note on why. The SLA pauses until that date, and your
            note is logged to the activity feed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="move-close-date">New close target</Label>
            <Input
              id="move-close-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="move-close-reason">Why is it moving?</Label>
            <Textarea
              id="move-close-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Client pushed the decision to next quarter"
            />
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <CalendarClock className="h-4 w-4 mr-1" />
            )}
            Move close date
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
