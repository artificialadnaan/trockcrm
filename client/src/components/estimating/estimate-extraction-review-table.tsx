import { useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type ExtractionReviewAction = "approve" | "reject";

interface ExtractionReviewRow {
  id: string;
  status?: string | null;
  extractionType?: string | null;
  normalizedLabel?: string | null;
  rawLabel?: string | null;
  quantity?: string | number | null;
  unit?: string | null;
  divisionHint?: string | null;
  confidence?: string | number | null;
  sourceDocumentId?: string | null;
  documentId?: string | null;
  pageId?: string | null;
  evidenceText?: string | null;
  metadataJson?: Record<string, unknown> | null;
}

function formatLabel(row: ExtractionReviewRow) {
  return row.normalizedLabel || row.rawLabel || "Unnamed extraction";
}

function formatStatus(value: string | null | undefined) {
  if (!value) return "unknown";
  return value.replace(/_/g, " ");
}

function formatExtractionType(value: string | null | undefined) {
  if (!value) return "scope row";
  return value.replace(/_/g, " ");
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

function formatMeasurementConfirmationState(value: unknown) {
  if (value === "approved") return "Approved for pricing";
  if (value === "rejected") return "Rejected for pricing";
  if (value === "pending") return "Needs confirmation before pricing";
  if (typeof value === "string" && value.length > 0) return value.replace(/_/g, " ");
  return null;
}

export async function runEstimateExtractionReviewAction({
  action,
  dealId,
  extractionId,
  refresh,
}: {
  action: ExtractionReviewAction;
  dealId: string;
  extractionId: string;
  refresh: () => Promise<void>;
}) {
  await api(`/deals/${dealId}/estimating/extractions/${extractionId}/${action}`, {
    method: "POST",
  });
  await refresh();
}

export function EstimateExtractionReviewTable({
  rows,
  onRefresh,
}: {
  rows: ExtractionReviewRow[];
  onRefresh: () => Promise<void>;
}) {
  const { dealId } = useParams<{ dealId: string }>();
  const [selectedRowId, setSelectedRowId] = useState<string | null>(rows[0]?.id ?? null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const selectedRow =
    rows.find((row) => row.id === selectedRowId) ?? rows[0] ?? null;

  const handleAction = async (row: ExtractionReviewRow, action: ExtractionReviewAction) => {
    if (!dealId) {
      toast.error("Missing deal id for extraction review");
      return;
    }

    setPendingAction(`${row.id}:${action}`);
    try {
      await runEstimateExtractionReviewAction({
        action,
        dealId,
        extractionId: row.id,
        refresh: onRefresh,
      });
      toast.success(
        action === "approve" ? "Extraction approved" : "Extraction rejected"
      );
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update extraction");
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <section className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Extraction</h3>
        <p className="text-xs text-muted-foreground">
          Estimator review for OCR-derived scope rows before catalog matching.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          No extraction rows are available for review yet.
        </div>
      ) : (
        <>
          <div className="border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
            {rows.length} extracted scope rows. Selected:{" "}
            <span className="font-medium text-foreground">
              {selectedRow ? formatLabel(selectedRow) : "None"}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Scope</th>
                  <th className="px-3 py-2 font-medium">Qty</th>
                  <th className="px-3 py-2 font-medium">Context</th>
                  <th className="px-3 py-2 font-medium">Status</th>
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
                        <Button
                          size="xs"
                          variant={isSelected ? "secondary" : "ghost"}
                          onClick={() => setSelectedRowId(row.id)}
                        >
                          {isSelected ? "Selected" : "Focus"}
                        </Button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-foreground">{formatLabel(row)}</div>
                        <div className="text-xs text-muted-foreground">{row.rawLabel || "No raw label"}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{formatQuantity(row.quantity, row.unit)}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatExtractionType(row.extractionType)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        <div>{row.divisionHint || "No division hint"}</div>
                        <div>Doc {row.sourceDocumentId || row.documentId || "unknown"}</div>
                        <div>Page {row.pageId || "n/a"}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium capitalize">{formatStatus(row.status)}</div>
                        <div className="text-xs text-muted-foreground">
                          Confidence {formatConfidence(row.confidence)}
                        </div>
                        {row.extractionType === "measurement_candidate" ? (
                          <>
                            <div className="text-xs font-medium text-amber-700">
                              Measurement candidate
                            </div>
                            <div className="text-xs text-amber-700">
                              {formatMeasurementConfirmationState(
                                row.metadataJson?.measurementConfirmationState
                              ) ?? "Awaiting confirmation"}
                            </div>
                          </>
                        ) : null}
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

          <div className="px-4 py-3 text-xs text-muted-foreground">
            {selectedRow?.evidenceText || "No extraction evidence captured for the selected row."}
          </div>
        </>
      )}
    </section>
  );
}
