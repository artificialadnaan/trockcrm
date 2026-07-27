import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  getReturnToOpportunityPreview,
  returnDealToOpportunity,
  type ReturnToOpportunityPreview,
} from "@/hooks/use-deals";

export function buildProcoreBidBoardProjectUrl(
  procoreCompanyId: string | null,
  procoreBidId: string | null
) {
  if (!procoreCompanyId || !procoreBidId) return null;
  return `https://us02.procore.com/webclients/host/companies/${procoreCompanyId}/tools/bid-board/project/${procoreBidId}/details`;
}

function formatUsd(value: string | number | null | undefined) {
  const amount = typeof value === "number" ? value : Number(String(value ?? "0").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(amount)) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

interface ReturnToOpportunityDialogProps {
  dealId: string;
  dealName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (result: { commissionRowsVoided: number; commissionTotalVoided: string }) => void;
}

/**
 * Confirm dialog for "Move back to Opportunity".
 *
 * Three things here are safety mechanisms, not decoration:
 *  1. It loads a fresh PREVIEW on open. The commission figure the operator confirms must be the live
 *     one, not something cached from an earlier render.
 *  2. It NAMES the dollar amount that will be voided, and echoes that exact figure back to the server
 *     on submit — the server refuses the move if the live sum has since moved.
 *  3. The "you must delete this from the Bid Board yourself" instruction is a standalone block, not a
 *     footnote. The CRM genuinely cannot delete the Bid Board project; if the operator misses this the
 *     estimating team keeps working a phantom project.
 */
export function ReturnToOpportunityDialog({
  dealId,
  dealName,
  open,
  onOpenChange,
  onSuccess,
}: ReturnToOpportunityDialogProps) {
  const [preview, setPreview] = useState<ReturnToOpportunityPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSubmitError(null);
    setPreview(null);
    setReason("");
    getReturnToOpportunityPreview(dealId)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Could not load this deal's move-back details.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, dealId]);

  const handleSubmit = async () => {
    if (!preview?.allowed) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await returnDealToOpportunity(dealId, {
        reason: reason.trim(),
        // Echo the exact total this dialog displayed. Sent only when there IS commission to void, so
        // an ordinary pre-Won move doesn't carry a meaningless "0".
        acknowledgedCommissionTotal:
          preview.commissionRowCount > 0 ? preview.commissionTotal : undefined,
      });
      onSuccess(result);
      onOpenChange(false);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : "Failed to move this deal back to Opportunity.");
    } finally {
      setSubmitting(false);
    }
  };

  const bidBoardUrl = buildProcoreBidBoardProjectUrl(
    preview?.procoreCompanyId ?? null,
    preview?.procoreBidId ?? null
  );
  const canSubmit =
    Boolean(preview?.allowed) && reason.trim().length > 0 && !submitting && !loading;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Move “{dealName}” back to Opportunity?</DialogTitle>
          <DialogDescription>
            The deal returns to the Opportunity stage and is disconnected from Bid Board sync. Future Bid
            Board exports will no longer update its stage, name or estimate.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking what this will change…
          </div>
        ) : loadError ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {loadError}
          </div>
        ) : preview ? (
          <div className="space-y-3 py-1">
            {!preview.allowed ? (
              <div
                className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700"
                role="alert"
              >
                {preview.blockReason ?? "This deal cannot be moved back to Opportunity."}
              </div>
            ) : null}

            {preview.voidsCommission && preview.commissionRowCount > 0 ? (
              <div
                className="rounded-md border-2 border-red-300 bg-red-50 px-3 py-3 text-sm text-red-800"
                role="alert"
                data-testid="return-to-opportunity-commission-warning"
              >
                <p className="flex items-center gap-2 font-black uppercase tracking-[0.06em]">
                  <AlertTriangle className="h-4 w-4" />
                  This voids booked commission
                </p>
                <p className="mt-1">
                  {formatUsd(preview.commissionTotal)} of earned commission across{" "}
                  {preview.commissionRowCount} row{preview.commissionRowCount === 1 ? "" : "s"} will be{" "}
                  <strong>permanently deleted</strong>, and the contract-signed date
                  {preview.effectiveContractSignedDate ? ` (${preview.effectiveContractSignedDate})` : ""} will
                  be cleared. The reps booked on this deal stop being paid on it. This is recorded against
                  your name and cannot be undone from this screen.
                </p>
              </div>
            ) : preview.voidsCommission ? (
              <div
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                role="alert"
              >
                This deal is Won or carries a signed contract. Moving it back clears its Won and
                contract-signed dates, so it leaves every Won report.
              </div>
            ) : null}

            {preview.isBidBoardLinked ? (
              <div className="rounded-md border-2 border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                <p className="flex items-center gap-2 font-black uppercase tracking-[0.06em]">
                  <AlertTriangle className="h-4 w-4" />
                  You must delete this project from Bid Board yourself
                </p>
                <p className="mt-1">
                  The CRM cannot delete it for you. If you leave it there it keeps showing on the Bid
                  Board as an active project and the estimating team keeps working it.
                </p>
                {bidBoardUrl ? (
                  <a
                    className="mt-2 inline-flex items-center gap-1 font-semibold underline"
                    href={bidBoardUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Bid Board
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null}
              </div>
            ) : null}

            <p className="text-sm text-slate-600">
              The deal keeps its files, photos, contacts, team, estimates and history. Its RFP submission
              is cleared so it can be re-submitted when it is ready.
            </p>

            <div>
              <Textarea
                placeholder="Why is this deal not ready to progress?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                disabled={!preview.allowed || submitting}
                aria-label="Reason"
              />
            </div>

            {submitError ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {submitError}
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? "Moving…" : "Move back to Opportunity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
