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
  /** The office the deal was read from (cross-office detail loads pass ?officeId). Threaded into the
   *  PATCH so the write targets the SAME tenant as the read — without it a cross-office move/clear hits
   *  the viewer's active office and never applies to the deal on screen. */
  officeId?: string | null;
  /** Called after a successful save so the caller can refetch the deal + activity feed. */
  onSaved: () => void | Promise<void>;
  /**
   * True when this deal sits in the genuine estimating stage, where the at-risk SLA suppression is
   * measured from the BID due date rather than the close target (2026-07-28). The dialog must not promise
   * a pause it cannot deliver there — moving the close date is still a real forecast edit, just not an
   * SLA postponement.
   */
  slaFollowsBidDueDate?: boolean;
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
export function MoveCloseDateDialog({ open, onOpenChange, dealId, currentDate, officeId, onSaved, slaFollowsBidDueDate = false }: MoveCloseDateDialogProps) {
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

  // Whether the deal currently has a saved today-or-future close target that can be cleared. It is an
  // SLA postponement everywhere EXCEPT estimating-with-a-bid-date, where the same date is forecast-only —
  // the label and the logged note branch on slaFollowsBidDueDate rather than hiding the action, since
  // clearing a stale forecast date is still legitimate there.
  const hasActivePostponement = currentDate != null && currentDate >= businessToday;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);

    // The date write postpones the SLA — it is the ONLY step whose failure should block + error.
    try {
      await updateDeal(dealId, { expectedCloseDate: date }, { officeId });
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

  // Clear the close target. Normally that drops the deal straight back to its normal stage-age SLA (the
  // at-risk engine has nothing to suppress once expected_close_date is null). In the estimating stage with
  // a usable bid date it is a FORECAST edit only — suppression stays governed by the bid due date — so the
  // affordance is relabelled and the logged note must not claim an SLA effect (Codex P2).
  const handleRemove = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);

    // Clearing the close target is the load-bearing write; mirror handleSave's failure isolation.
    try {
      await updateDeal(dealId, { expectedCloseDate: null }, { officeId });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : slaFollowsBidDueDate
            ? "Couldn't remove the close date. Please try again."
            : "Couldn't remove the postponement. Please try again."
      );
      setSaving(false);
      return;
    }

    try {
      await createActivity({
        type: "note",
        // State only the action taken. Don't claim "SLA resumed" — if the deal is also On Hold, the
        // at-risk engine checks the hold before close-target suppression, so clearing the target does
        // NOT resume the normal stage-age SLA. The note records the fact; the SLA follows the engine.
        subject: "Close target removed",
        body: slaFollowsBidDueDate
          ? "Close target removed — forecast date cleared. The estimating SLA continues to follow the bid due date."
          : "Close target removed — the deal's close-date postponement was cleared.",
        dealId,
      });
    } catch {
      // best-effort audit note
    }
    try {
      await onSaved();
    } catch {
      // best-effort refresh; the clear is already saved server-side
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
            {slaFollowsBidDueDate
              ? "Pick a new close target and add a short note on why. Your note is logged to the activity feed. In the estimating stage the SLA follows the BID due date, so moving this date updates the forecast but does not pause the SLA."
              : "Pick a new close target and add a short note on why. The SLA pauses until that date, and your note is logged to the activity feed."}
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
                {slaFollowsBidDueDate
                  ? "Pick today or a future date."
                  : "Pick today or a future date — a past date won't postpone the SLA."}
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
          {hasActivePostponement ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={saving}
              className="mr-auto text-red-600 hover:bg-red-50 hover:text-red-700"
            >
              {slaFollowsBidDueDate ? "Remove close date" : "Remove postponement"}
            </Button>
          ) : null}
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
