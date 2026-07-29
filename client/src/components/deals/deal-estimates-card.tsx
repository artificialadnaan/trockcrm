import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { formatCurrency, currentContractValue, combinedChangeOrderTotal } from "@/lib/deal-utils";
import {
  addDealChangeOrder,
  updateDealChangeOrder,
  deleteDealChangeOrder,
  type Deal,
  type DealChangeOrder,
} from "@/hooks/use-deals";

interface DealEstimatesCardProps {
  deal: Deal;
  /** CRM-native change orders for this deal (from the deal detail's dealChangeOrders). */
  changeOrders?: DealChangeOrder[];
  /** Server-computed sum of the CRM change orders (dealChangeOrderTotal). */
  changeOrderTotal?: string | null;
  /** Admins may add / edit / remove change orders. */
  canManage?: boolean;
  /** Called after a successful add / edit / delete so the parent can refetch. */
  onChanged?: () => void;
}

export function DealEstimatesCard({
  deal,
  changeOrders = [],
  changeOrderTotal,
  canManage = false,
  onChanged,
}: DealEstimatesCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DealChangeOrder | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Only offer mutations when a refresh callback is wired — otherwise a successful write would leave
  // the card showing stale totals/rows.
  const canMutate = canManage && Boolean(onChanged);

  const crmTotal =
    changeOrderTotal ??
    String(changeOrders.reduce((sum, co) => sum + (parseFloat(co.amount) || 0), 0));
  const combinedCo = combinedChangeOrderTotal(deal.changeOrderTotal, crmTotal);
  const ccv = currentContractValue(deal, crmTotal);

  const openAdd = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (co: DealChangeOrder) => {
    setEditing(co);
    setDialogOpen(true);
  };

  const handleDelete = async (co: DealChangeOrder) => {
    if (
      !window.confirm(
        `Remove the ${formatCurrency(co.amount)} change order signed ${co.signedDate}?`
      )
    ) {
      return;
    }
    setDeletingId(co.id);
    try {
      await deleteDealChangeOrder(deal.id, co.id);
      toast.success("Change order removed");
      onChanged?.();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to remove change order");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">Estimates</CardTitle>
        {canMutate && (
          <Button size="sm" variant="outline" onClick={openAdd}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Change Order
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">DD Estimate</span>
            <span className="text-sm font-medium">{formatCurrency(deal.ddEstimate)}</span>
          </div>
          {deal.ddEstimateOverridden ? (
            <p className="text-xs text-muted-foreground">Manually set — not synced from Procore.</p>
          ) : null}
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Bid Estimate</span>
          <span className="text-sm font-medium">{formatCurrency(deal.bidEstimate)}</span>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Awarded Amount</span>
            <span className="text-sm font-semibold">{formatCurrency(deal.awardedAmount)}</span>
          </div>
          {deal.awardedAmountOverridden ? (
            <p className="text-xs text-muted-foreground">Manually set — not synced from Procore.</p>
          ) : null}
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Change Orders</span>
          <span
            className={`text-sm font-medium${combinedCo < 0 ? " text-red-600" : ""}`}
            data-testid="change-order-total"
          >
            {formatCurrency(combinedCo)}
          </span>
        </div>
        <div className="border-t pt-2 flex justify-between items-center">
          <span className="text-sm font-medium">Current Contract Value</span>
          {/* Deductive COs can drive the CCV negative; the green "healthy contract value" treatment
              would then read as a positive number at a glance, so a below-zero CCV goes red. */}
          <span
            className={`text-base font-bold ${ccv < 0 ? "text-red-600" : "text-green-600"}`}
            data-testid="current-contract-value"
          >
            {formatCurrency(ccv)}
          </span>
        </div>

        {changeOrders.length > 0 && (
          <div className="border-t pt-2 space-y-1.5">
            {changeOrders.map((co) => (
              <div
                key={co.id}
                className="flex items-center justify-between gap-2 text-sm"
                data-testid="change-order-row"
              >
                <div className="min-w-0">
                  {/* formatCurrency already renders a deduction as "-$2,000", but a lone minus sign
                      is easy to miss in a list of look-alike rows — reuse the card's existing red to
                      make the sign legible. No new visual language. */}
                  <span
                    className={`font-medium${(parseFloat(co.amount) || 0) < 0 ? " text-red-600" : ""}`}
                    data-testid="change-order-amount"
                  >
                    {formatCurrency(co.amount)}
                  </span>
                  <span className="text-muted-foreground"> · {co.signedDate}</span>
                  {co.description ? (
                    <span className="text-muted-foreground"> · {co.description}</span>
                  ) : null}
                </div>
                {canMutate && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => openEdit(co)}
                      aria-label="Edit change order"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      disabled={deletingId === co.id}
                      onClick={() => handleDelete(co)}
                      aria-label="Remove change order"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ChangeOrderDialog
        dealId={deal.id}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        existing={editing}
        // Baseline for the below-zero warning: the Current Contract Value with the CO being edited
        // REMOVED. An edit replaces that CO's amount, it doesn't add to it — baselining against the
        // raw CCV would count the old amount twice and warn on edits that are actually fine.
        baselineContractValue={ccv - (editing ? parseFloat(editing.amount) || 0 : 0)}
        onSaved={() => {
          setDialogOpen(false);
          onChanged?.();
        }}
      />
    </Card>
  );
}

// Signed money string — MUST stay identical to the server's CHANGE_ORDER_AMOUNT_PATTERN in
// server/src/modules/deals/change-order-service.ts: an optional leading '-', 1-12 integer digits and
// up to 2 decimals (the NUMERIC(14,2) ceiling, 999,999,999,999.99, by construction). A NEGATIVE amount
// is a deductive change order. Zero is meaningless and rejected separately, below.
const CHANGE_ORDER_AMOUNT_PATTERN = /^-?\d{1,12}(\.\d{1,2})?$/;

interface ChangeOrderDialogProps {
  dealId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: DealChangeOrder | null;
  /**
   * Current Contract Value EXCLUDING the change order being edited — the baseline the submitted
   * amount is applied to when deciding whether to warn about a below-zero contract value.
   */
  baselineContractValue: number;
  onSaved: () => void;
}

function ChangeOrderDialog({ dealId, open, onOpenChange, existing, baselineContractValue, onSaved }: ChangeOrderDialogProps) {
  const [signedDate, setSignedDate] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSignedDate(existing?.signedDate ?? "");
      setAmount(existing?.amount ?? "");
      setDescription(existing?.description ?? "");
      setError(null);
    }
  }, [open, existing]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedAmount = amount.trim();
    if (!signedDate) {
      setError("Signed date is required");
      return;
    }
    // Mirror the server's normalizeChangeOrderAmount exactly — same two checks, same wording, so the
    // client never blocks a value the API would take (a silent feature block) nor forwards one it
    // would 400 on. A negative amount is allowed: that is a deductive change order.
    if (!CHANGE_ORDER_AMOUNT_PATTERN.test(trimmedAmount)) {
      setError("Change order amount must be a number with at most 2 decimals (max 999,999,999,999.99).");
      return;
    }
    if (Number(trimmedAmount) === 0) {
      // Covers "0", "0.00", "-0" and "-0.00" — all of which the server rejects too.
      setError("Change order amount cannot be 0.");
      return;
    }
    // Advisory only (product decision): a deductive CO may legitimately exceed the contract value, and
    // there is NO server-side rejection — scripts and the API can still write one. Confirm, then save.
    // Round to cents first: these are float sums of 2-decimal money strings, and a CO that exactly
    // zeroes the contract value can land a hair below it (2.9 + 0.7 - 3.6 === -4.4e-16), which would
    // pop a "below $0" warning on a break-even change order.
    const projectedContractValue = Math.round((baselineContractValue + Number(trimmedAmount)) * 100) / 100;
    if (projectedContractValue < 0) {
      const proceed = window.confirm(
        `This change order takes the Current Contract Value to ${formatCurrency(projectedContractValue)}, below $0. Save it anyway?`
      );
      if (!proceed) return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        signedDate,
        amount: trimmedAmount,
        description: description.trim() || null,
      };
      if (existing) {
        await updateDealChangeOrder(dealId, existing.id, payload);
        toast.success("Change order updated");
      } else {
        await addDealChangeOrder(dealId, payload);
        toast.success("Change order added");
      }
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save change order");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit Change Order" : "Add Change Order"}</DialogTitle>
          <DialogDescription>
            Capture a signed change order. Its amount adjusts the Current Contract Value and is
            reported in the period of its signed date. Enter a negative amount to record a deductive
            change order, which reduces the contract value.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="co-signed-date">Signed Date</Label>
            <Input
              id="co-signed-date"
              type="date"
              value={signedDate}
              onChange={(e) => setSignedDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="co-amount">Amount ($)</Label>
            {/* No `min`: a min of 0.01 makes the browser reject a deductive amount before the submit
                handler ever runs. The amount contract is enforced in handleSubmit (server parity). */}
            <Input
              id="co-amount"
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="co-description">Description (optional)</Label>
            <Textarea
              id="co-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : existing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
