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

  // "Today" in the business timezone (America/Chicago) — a date before this won't postpone the SLA
  // (the shared rule only suppresses for today-or-future targets), so block it in the save gate.
  const businessToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const isPastDate = date !== "" && date < businessToday;
  const canSave = date !== "" && !isPastDate && reason.trim() !== "" && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);

    // The date write postpones the SLA — it is the ONLY step whose failure should block + error.
    try {
      await updateDeal(dealId, { expectedCloseDate: date });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't move the close date. Please try again.");
      setSaving(false);
      return;
    }

    // The date is committed. The reason note and the refetch are best-effort: a failure in either must
    // NOT strand the saved date or invite a duplicate retry of the (already-successful) date write.
    try {
      await createActivity({
        type: "note",
        // The activity feed renders body (not subject), so include the moved-to date in the body —
        // otherwise a deal moved multiple times shows only reasons with no date each applied to.
        subject: `Close target moved to ${formatHuman(date)}`,
        body: `Close target moved to ${formatHuman(date)}.\n\n${reason.trim()}`,
        dealId,
      });
    } catch {
      // best-effort audit note
    }
    try {
      await onSaved();
    } catch {
      // best-effort refresh; the date is already saved server-side
    }
    setSaving(false);
    onOpenChange(false);
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
              min={businessToday}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            {isPastDate ? (
              <p className="text-xs text-amber-600">
                Pick today or a future date — a past date won't postpone the SLA.
              </p>
            ) : null}
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
