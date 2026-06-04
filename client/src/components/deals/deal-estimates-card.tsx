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
        {canManage && (
          <Button size="sm" variant="outline" onClick={openAdd}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Change Order
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">DD Estimate</span>
          <span className="text-sm font-medium">{formatCurrency(deal.ddEstimate)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Bid Estimate</span>
          <span className="text-sm font-medium">{formatCurrency(deal.bidEstimate)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Awarded Amount</span>
          <span className="text-sm font-semibold">{formatCurrency(deal.awardedAmount)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Change Orders</span>
          <span className="text-sm font-medium" data-testid="change-order-total">
            {formatCurrency(combinedCo)}
          </span>
        </div>
        <div className="border-t pt-2 flex justify-between items-center">
          <span className="text-sm font-medium">Current Contract Value</span>
          <span className="text-base font-bold text-green-600">{formatCurrency(ccv)}</span>
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
                  <span className="font-medium">{formatCurrency(co.amount)}</span>
                  <span className="text-muted-foreground"> · {co.signedDate}</span>
                  {co.description ? (
                    <span className="text-muted-foreground"> · {co.description}</span>
                  ) : null}
                </div>
                {canManage && (
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
        onSaved={() => {
          setDialogOpen(false);
          onChanged?.();
        }}
      />
    </Card>
  );
}

interface ChangeOrderDialogProps {
  dealId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: DealChangeOrder | null;
  onSaved: () => void;
}

function ChangeOrderDialog({ dealId, open, onOpenChange, existing, onSaved }: ChangeOrderDialogProps) {
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
    const numericAmount = parseFloat(amount);
    if (!signedDate) {
      setError("Signed date is required");
      return;
    }
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError("Amount must be a positive number");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = { signedDate, amount, description: description.trim() || null };
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
            Capture a signed change order. Its amount adds to the Current Contract Value and is
            reported in the period of its signed date.
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
            <Input
              id="co-amount"
              type="number"
              min="0.01"
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
