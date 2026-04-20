import { useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type PricingReviewAction = "approve" | "reject";

interface PricingReviewRow {
  id: string;
  status?: string | null;
  recommendedQuantity?: string | number | null;
  recommendedUnit?: string | null;
  recommendedUnitPrice?: string | number | null;
  recommendedTotalPrice?: string | number | null;
  priceBasis?: string | null;
  confidence?: string | number | null;
  createdByRunId?: string | null;
  assumptionsJson?: unknown;
  evidenceJson?: unknown;
}

function formatCurrency(value: string | number | null | undefined) {
  if (value == null || value === "") return "No price";
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(numeric)) return `${value}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(numeric);
}

function formatQuantity(value: string | number | null | undefined, unit: string | null | undefined) {
  const quantity = value == null || value === "" ? "No qty" : `${value}`;
  return unit ? `${quantity} ${unit}` : quantity;
}

function formatConfidence(value: string | number | null | undefined) {
  if (value == null || value === "") return "No score";
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(numeric)) return `${value}`;
  return `${Math.round(numeric <= 1 ? numeric * 100 : numeric)}%`;
}

function formatStatus(value: string | null | undefined) {
  if (!value) return "unknown";
  return value.replace(/_/g, " ");
}

function summarizeUnknown(value: unknown) {
  if (!value) return "No detail";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "No detail";
  }
}

function createRefresh() {
  return async () => {
    if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
      window.location.reload();
    }
  };
}

export async function runEstimatePricingReviewAction({
  action,
  dealId,
  recommendationId,
  refresh,
}: {
  action: PricingReviewAction;
  dealId: string;
  recommendationId: string;
  refresh: () => Promise<void>;
}) {
  await api(
    `/deals/${dealId}/estimating/pricing-recommendations/${recommendationId}/${action}`,
    { method: "POST" }
  );
  await refresh();
}

export function EstimatePricingReviewTable({ rows }: { rows: PricingReviewRow[] }) {
  const { dealId } = useParams<{ dealId: string }>();
  const [selectedRowId, setSelectedRowId] = useState<string | null>(rows[0]?.id ?? null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const selectedRow =
    rows.find((row) => row.id === selectedRowId) ?? rows[0] ?? null;

  const handleAction = async (row: PricingReviewRow, action: PricingReviewAction) => {
    if (!dealId) {
      toast.error("Missing deal id for pricing review");
      return;
    }

    setPendingAction(`${row.id}:${action}`);
    try {
      await runEstimatePricingReviewAction({
        action,
        dealId,
        recommendationId: row.id,
        refresh: createRefresh(),
      });
      toast.success(
        action === "approve"
          ? "Pricing recommendation approved"
          : "Pricing recommendation rejected"
      );
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update pricing recommendation"
      );
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <section className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Draft Pricing</h3>
        <p className="text-xs text-muted-foreground">
          Review recommendation math before anything is promoted into the estimate.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          No pricing recommendations are available yet.
        </div>
      ) : (
        <>
          <div className="border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
            {rows.length} pricing recommendations. Selected:{" "}
            <span className="font-medium text-foreground">
              {selectedRow?.id || "None"}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Quantity</th>
                  <th className="px-3 py-2 font-medium">Unit Price</th>
                  <th className="px-3 py-2 font-medium">Total</th>
                  <th className="px-3 py-2 font-medium">Basis</th>
                  <th className="px-3 py-2 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isSelected = row.id === selectedRow?.id;
                  const approveBusy = pendingAction === `${row.id}:approve`;
                  const rejectBusy = pendingAction === `${row.id}:reject`;

                  return (
                    <tr
                      key={row.id}
                      className={isSelected ? "border-b bg-muted/20 align-top" : "border-b align-top"}
                    >
                      <td className="px-3 py-2">
                        <div className="mb-2">
                          <Button
                            size="xs"
                            variant={isSelected ? "secondary" : "ghost"}
                            onClick={() => setSelectedRowId(row.id)}
                          >
                            {isSelected ? "Selected" : "Focus"}
                          </Button>
                        </div>
                        <div className="font-medium text-foreground">{row.id}</div>
                        <div className="text-xs text-muted-foreground">
                          Run {row.createdByRunId || "manual"}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">
                          {formatQuantity(row.recommendedQuantity, row.recommendedUnit)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Confidence {formatConfidence(row.confidence)}
                        </div>
                      </td>
                      <td className="px-3 py-2">{formatCurrency(row.recommendedUnitPrice)}</td>
                      <td className="px-3 py-2 font-medium">
                        {formatCurrency(row.recommendedTotalPrice)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="capitalize">{row.priceBasis || "unknown"}</div>
                        <div className="text-xs text-muted-foreground capitalize">
                          {formatStatus(row.status)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={approveBusy || rejectBusy || !dealId}
                            onClick={() => handleAction(row, "approve")}
                          >
                            {approveBusy ? "Approving..." : "Approve"}
                          </Button>
                          <Button
                            size="xs"
                            variant="destructive"
                            disabled={approveBusy || rejectBusy || !dealId}
                            onClick={() => handleAction(row, "reject")}
                          >
                            {rejectBusy ? "Rejecting..." : "Reject"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="grid gap-1 border-t px-4 py-3 text-xs text-muted-foreground">
            <div>Assumptions: {selectedRow ? summarizeUnknown(selectedRow.assumptionsJson) : "No detail"}</div>
            <div>Evidence: {selectedRow ? summarizeUnknown(selectedRow.evidenceJson) : "No detail"}</div>
          </div>
        </>
      )}
    </section>
  );
}
