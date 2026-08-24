import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { deleteWeeklyReport, type WeeklyReportDetail } from "@/hooks/use-weekly-reports";

/**
 * Remove a report from the record.
 *
 * NOT `window.confirm`, which is what the module's "Stop reporting" uses. A confirm box cannot carry a
 * reason field, and the reason is required — it is the whole difference between a removal somebody can
 * account for and a row that quietly stopped existing.
 *
 * There is no un-delete. `is_active` supports one and no surface offers it, so this dialog is the last
 * point at which the decision is reversible and it says so.
 */
export function WeeklyReportDeleteDialog({
  report,
  onClose,
  onDeleted,
}: {
  report: WeeklyReportDetail;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [reason, setReason] = useState("");
  const [confirmWeek, setConfirmWeek] = useState("");
  const [deleting, setDeleting] = useState(false);

  const isSent = report.status === "sent";
  // NON-EMPTY, matching the server's 400 and the house idiom — the deal archive, this module's own
  // dismiss route. Inventing a longer minimum here would put this disabled state and the server's answer
  // into disagreement about the same click.
  const hasReason = reason.trim().length > 0;
  // THE ISO STRING, exactly. The server compares against `week_of` rendered as `YYYY-MM-DD`, and the
  // friendly form History shows ("Aug 13, 2026") is not it — which is why the dialog prints the string it
  // wants rather than asking for "the week".
  const weekConfirmed = !isSent || confirmWeek.trim() === report.weekOf;

  const handleSubmit = async () => {
    setDeleting(true);
    try {
      await deleteWeeklyReport(report.id, {
        reason: reason.trim(),
        ...(isSent ? { confirmWeekOf: report.weekOf } : {}),
      });
      toast.success("Report deleted");
      onDeleted();
      onClose();
    } catch (error) {
      // Left OPEN. The refusals the server can answer here — a report that replaced a live predecessor,
      // a status that moved underneath — are things the user needs to read and act on, and closing the
      // dialog would take the message with it.
      toast.error(error instanceof Error ? error.message : "Couldn't delete this report");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !deleting && onClose()}>
      <DialogContent className="sm:!max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-extrabold tracking-tight text-slate-950">
            Delete week of {fmtWeek(report.weekOf)}
            {report.version > 1 && (
              <span className="ml-2 text-[11px] font-bold uppercase tracking-wide text-violet-600">
                v{report.version}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3.5">
          <p className="text-[13.5px] text-slate-600">
            This takes the report off the board and out of History, and the week goes back to reading as
            not filed. There is no undo.
          </p>

          {isSent && (
            <div className="flex items-start gap-2 rounded-lg border border-brand-red/30 bg-brand-red/[0.03] p-3 text-[13px] text-brand-red">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
              <span>
                <span className="font-semibold">The client was sent this report{sentOn(report.sentAt)}.</span>{" "}
                Their link will stop working, and any copy of the PDF they downloaded will not. If a fact in
                the report is wrong, send a correction instead — that tells them a newer version exists.
              </span>
            </div>
          )}

          <div>
            {/* `text-slate-500`, not the `text-slate-400` the sibling dialogs use: 400 on white at this
                size measures 2.56:1 against WCAG's 4.5, and lib/muted-text-contrast.test.ts fails the
                build when a NEW file adds one. The existing 400s are a measured backlog, not a pattern
                to match. */}
            <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">Reason</p>
            <Textarea
              aria-label="Reason"
              rows={3}
              placeholder="Why is this report being deleted?"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>

          {isSent && (
            <div>
              <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Type <span className="font-mono normal-case tracking-normal text-slate-700">{report.weekOf}</span>{" "}
                to confirm
              </p>
              <input
                aria-label="Confirm the week"
                value={confirmWeek}
                onChange={(event) => setConfirmWeek(event.target.value)}
                placeholder={report.weekOf}
                className="w-full rounded-lg border border-slate-200 px-2.5 py-2 font-mono text-[13.5px] outline-none placeholder:text-slate-300 focus:border-brand-red/40"
              />
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <Button variant="outline" onClick={onClose} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleSubmit}
              disabled={deleting || !hasReason || !weekConfirmed}
            >
              {deleting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Delete report
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** " on Aug 13", or nothing at all — a sent report with no stamp predates the column. */
function sentOn(sentAt: string | null): string {
  if (!sentAt) return "";
  const d = new Date(sentAt);
  return Number.isNaN(d.getTime())
    ? ""
    : ` on ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

/** UTC, like every other rendering of `week_of` — it is a calendar date with no time in it. */
function fmtWeek(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}
