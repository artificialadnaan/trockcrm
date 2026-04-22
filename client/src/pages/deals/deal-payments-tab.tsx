import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createDealPayment,
  getDealPayments,
  type DealPaymentEvent,
} from "@/hooks/use-deals";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function toDateInputValue(value: Date) {
  return value.toISOString().slice(0, 10);
}

function formatMoney(value: string | number) {
  const numeric = typeof value === "string" ? Number(value) : value;
  return USD.format(Number.isFinite(numeric) ? numeric : 0);
}

export function DealPaymentsTab(props: {
  dealId: string;
  assignedRepId: string;
  canEditPayments: boolean;
}) {
  const [payments, setPayments] = useState<DealPaymentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [paidAt, setPaidAt] = useState(() => toDateInputValue(new Date()));
  const [grossRevenueAmount, setGrossRevenueAmount] = useState("");
  const [grossMarginAmount, setGrossMarginAmount] = useState("");
  const [isCreditMemo, setIsCreditMemo] = useState(false);
  const [notes, setNotes] = useState("");

  const loadPayments = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getDealPayments(props.dealId);
      setPayments(result.payments);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to load payments");
    } finally {
      setLoading(false);
    }
  }, [props.dealId]);

  useEffect(() => {
    void loadPayments();
  }, [loadPayments]);

  const totals = useMemo(() => {
    return payments.reduce(
      (acc, payment) => {
        acc.revenue += Number(payment.grossRevenueAmount || 0);
        acc.margin += Number(payment.grossMarginAmount || 0);
        return acc;
      },
      { revenue: 0, margin: 0 }
    );
  }, [payments]);

  const handleCreate = async () => {
    const revenueInput = Number(grossRevenueAmount);
    if (!Number.isFinite(revenueInput) || revenueInput === 0) {
      toast.error("Revenue amount is required");
      return;
    }

    const marginInput =
      grossMarginAmount.trim().length === 0 ? null : Number(grossMarginAmount);
    if (marginInput !== null && !Number.isFinite(marginInput)) {
      toast.error("Margin amount must be a valid number");
      return;
    }

    setSubmitting(true);
    try {
      const signedRevenue = isCreditMemo
        ? -Math.abs(revenueInput)
        : Math.abs(revenueInput);
      const signedMargin =
        marginInput === null
          ? null
          : isCreditMemo
            ? -Math.abs(marginInput)
            : Math.abs(marginInput);

      await createDealPayment(props.dealId, {
        paidAt: new Date(`${paidAt}T00:00:00.000Z`).toISOString(),
        grossRevenueAmount: signedRevenue,
        grossMarginAmount: signedMargin,
        isCreditMemo,
        notes: notes.trim().length > 0 ? notes.trim() : null,
      });

      setGrossRevenueAmount("");
      setGrossMarginAmount("");
      setNotes("");
      setIsCreditMemo(false);
      setPaidAt(toDateInputValue(new Date()));
      toast.success("Payment recorded");
      await loadPayments();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save payment");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-base font-semibold">Commission Payment Events</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Payments recorded here drive commission calculations for assigned rep{" "}
          <span className="font-medium text-foreground">{props.assignedRepId}</span>.
        </p>
      </div>

      {props.canEditPayments ? (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <h4 className="font-medium">Add Payment</h4>
          <div className="grid gap-3 md:grid-cols-2">
            <Input
              type="date"
              value={paidAt}
              onChange={(event) => setPaidAt(event.target.value)}
            />
            <Input
              type="number"
              step="0.01"
              placeholder="Gross revenue amount"
              value={grossRevenueAmount}
              onChange={(event) => setGrossRevenueAmount(event.target.value)}
            />
            <Input
              type="number"
              step="0.01"
              placeholder="Gross margin amount (optional)"
              value={grossMarginAmount}
              onChange={(event) => setGrossMarginAmount(event.target.value)}
            />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={isCreditMemo}
                onChange={(event) => setIsCreditMemo(event.target.checked)}
              />
              Credit memo
            </label>
          </div>
          <Textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Notes (optional)"
          />
          <Button type="button" onClick={handleCreate} disabled={submitting}>
            {submitting ? "Saving..." : "Record Payment"}
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
          Only admins can add or edit payment events.
        </div>
      )}

      <div className="rounded-lg border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h4 className="font-medium">Payment History</h4>
          <div className="text-sm text-muted-foreground">
            <span className="mr-3">Revenue: {formatMoney(totals.revenue)}</span>
            <span>Margin: {formatMoney(totals.margin)}</span>
          </div>
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading payments...</p>
        ) : payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Paid Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Margin</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell>
                    {new Date(payment.paidAt).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </TableCell>
                  <TableCell>
                    {payment.isCreditMemo ? (
                      <Badge variant="outline" className="bg-red-100 text-red-700">
                        Credit Memo
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-emerald-100 text-emerald-700">
                        Payment
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMoney(payment.grossRevenueAmount)}
                  </TableCell>
                  <TableCell className="text-right">
                    {payment.grossMarginAmount == null
                      ? "Estimated"
                      : formatMoney(payment.grossMarginAmount)}
                  </TableCell>
                  <TableCell className="max-w-[320px] truncate">
                    {payment.notes ?? "--"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

