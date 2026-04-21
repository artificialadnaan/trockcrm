import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type PricingReviewAction = "approve" | "reject";

export type PricingReviewStateAction =
  | "accept_recommended"
  | "accept_manual_row"
  | "switch_to_alternate"
  | "override"
  | "reject"
  | "pending_review";

export interface PricingRecommendationOption {
  id: string;
  optionKind: "recommended" | "alternate" | "manual";
  optionLabel: string;
  rank?: number | null;
  rationale?: string | null;
  evidenceText?: string | null;
}

export interface PricingReviewRow {
  id: string;
  status?: string | null;
  reviewState?: string | null;
  recommendedQuantity?: string | number | null;
  recommendedUnit?: string | null;
  recommendedUnitPrice?: string | number | null;
  recommendedTotalPrice?: string | number | null;
  priceBasis?: string | null;
  confidence?: string | number | null;
  createdByRunId?: string | null;
  selectedSourceType?: string | null;
  selectedOptionId?: string | null;
  duplicateGroupKey?: string | null;
  duplicateGroupBlocked?: boolean | null;
  suppressedByDuplicateGroup?: boolean | null;
  catalogBacking?: string | null;
  promotedLocalCatalogItemId?: string | null;
  sourceType?: string | null;
  assumptionsJson?: unknown;
  evidenceJson?: unknown;
  recommendationOptions?: PricingRecommendationOption[];
}

export interface PricingReviewStateActionInput {
  action: PricingReviewStateAction;
  alternateOptionId?: string | null;
  recommendedUnitPrice?: string;
  recommendedTotalPrice?: string;
  reason?: string | null;
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

function formatOptionRank(option: PricingRecommendationOption, fallbackIndex: number) {
  return `Rank ${option.rank ?? fallbackIndex + 1}`;
}

function isFreeTextManualRow(row: PricingReviewRow) {
  return (
    row.selectedSourceType === "manual" &&
    !row.selectedOptionId &&
    row.catalogBacking !== "local_catalog" &&
    !row.promotedLocalCatalogItemId
  );
}

export function getPricingRowSelectionState(row: PricingReviewRow) {
  const options = row.recommendationOptions ?? [];
  const selectedOption = row.selectedOptionId
    ? options.find((option) => option.id === row.selectedOptionId) ?? null
    : null;
  const isManual = isFreeTextManualRow(row);
  const isRecommended = selectedOption?.optionKind === "recommended";
  const isDefault = isRecommended;
  const isAlternate = selectedOption?.optionKind === "alternate";

  let displayLabel = "No recommendation";
  if (isManual) {
    displayLabel = "Manual / free-text row";
  } else if (selectedOption) {
    displayLabel = selectedOption.optionLabel;
  } else if (row.selectedSourceType === "catalog_option") {
    displayLabel = "Catalog-backed row";
  }

  return {
    selectedOption,
    displayLabel,
    isManual,
    isRecommended,
    isDefault,
    isAlternate,
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

export async function runEstimatePricingReviewStateAction({
  dealId,
  recommendationId,
  input,
  refresh,
}: {
  dealId: string;
  recommendationId: string;
  input: PricingReviewStateActionInput;
  refresh: () => Promise<void>;
}) {
  const json: Record<string, unknown> = {
    action: input.action,
  };

  if (input.alternateOptionId?.trim()) {
    json.alternateOptionId = input.alternateOptionId;
  }
  if (typeof input.recommendedUnitPrice !== "undefined") {
    json.recommendedUnitPrice = input.recommendedUnitPrice;
  }
  if (typeof input.recommendedTotalPrice !== "undefined") {
    json.recommendedTotalPrice = input.recommendedTotalPrice;
  }
  if (typeof input.reason !== "undefined") {
    json.reason = input.reason;
  }

  await api(`/deals/${dealId}/estimating/pricing-recommendations/${recommendationId}/review-state`, {
    method: "POST",
    json,
  });
  await refresh();
}

export async function runEstimatePromoteToEstimateAction({
  dealId,
  generationRunId,
  refresh,
}: {
  dealId: string;
  generationRunId: string;
  refresh: () => Promise<void>;
}) {
  await api(`/deals/${dealId}/estimating/promote`, {
    method: "POST",
    json: {
      generationRunId,
    },
  });
  await refresh();
}

export function EstimatePricingReviewTable({
  dealId,
  rows,
  onRefresh,
  onReviewAction,
  onFocusRow,
  onOpenManualAdd,
  onPromoteToEstimate,
  onPromoteLocalCatalog,
}: {
  dealId: string;
  rows: PricingReviewRow[];
  onRefresh: () => Promise<void>;
  onReviewAction?: (args: { row: PricingReviewRow; input: PricingReviewStateActionInput }) => Promise<void> | void;
  onFocusRow?: (rowId: string) => void;
  onOpenManualAdd?: () => void;
  onPromoteToEstimate?: () => void;
  onPromoteLocalCatalog?: (rowId: string) => Promise<void> | void;
}) {
  const [selectedRowId, setSelectedRowId] = useState<string | null>(rows[0]?.id ?? null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  void onOpenManualAdd;
  void onPromoteToEstimate;
  void onPromoteLocalCatalog;

  const selectedRow = rows.find((row) => row.id === selectedRowId) ?? rows[0] ?? null;

  const handleFocusRow = (rowId: string) => {
    setSelectedRowId(rowId);
    onFocusRow?.(rowId);
  };

  const handleReviewAction = async (row: PricingReviewRow, input: PricingReviewStateActionInput) => {
    setPendingAction(`${row.id}:${input.action}`);
    try {
      if (onReviewAction) {
        await onReviewAction({ row, input });
      } else {
        await runEstimatePricingReviewStateAction({
          dealId,
          recommendationId: row.id,
          input,
          refresh: onRefresh,
        });
      }

      toast.success("Pricing recommendation updated");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update pricing recommendation");
    } finally {
      setPendingAction(null);
    }
  };

  const renderBadges = (row: PricingReviewRow) => {
    const badges: ReactNode[] = [];
    const selectionState = getPricingRowSelectionState(row);

    if (selectionState.isRecommended) {
      badges.push(<Badge key="recommended">Recommended</Badge>);
    }

    if (selectionState.isDefault) {
      badges.push(
        <Badge key="default" variant="outline">
          Default
        </Badge>
      );
    }

    if (selectionState.isAlternate) {
      badges.push(
        <Badge key="alternate" variant="outline">
          Alternate
        </Badge>
      );
    }

    if (selectionState.isManual) {
      badges.push(
        <Badge key="manual" variant="outline">
          Manual
        </Badge>
      );
    }

    if (row.sourceType === "inferred") {
      badges.push(
        <Badge key="inferred" variant="outline">
          Inferred
        </Badge>
      );
    }

    if (row.duplicateGroupBlocked) {
      badges.push(
        <Badge key="duplicate" variant="destructive">
          Duplicate blocked
        </Badge>
      );
    }

    if (row.catalogBacking === "local_catalog" || row.promotedLocalCatalogItemId) {
      badges.push(
        <Badge key="local-catalog" variant="secondary">
          Local catalog
        </Badge>
      );
    }

    if (selectionState.selectedOption) {
      badges.push(
        <Badge key="selected-option" variant="outline">
          {selectionState.selectedOption.optionLabel}
        </Badge>
      );
    }

    return badges;
  };

  return (
    <section className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Draft Pricing</h3>
            <p className="text-xs text-muted-foreground">
              Review recommendation math before anything is promoted into the estimate.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {rows.length} recommendations
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          No pricing recommendations are available yet.
        </div>
      ) : (
        <>
          <div className="border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
            Selected:{" "}
            <span className="font-medium text-foreground">{selectedRow?.id || "None"}</span>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Recommendation</th>
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
                  const approveBusy = pendingAction === `${row.id}:accept_recommended`;
                  const rejectBusy = pendingAction === `${row.id}:reject`;
                  const overrideBusy = pendingAction === `${row.id}:override`;
                  const options = row.recommendationOptions ?? [];
                  const alternates = options.filter((option) => option.optionKind === "alternate");
                  const selectionState = getPricingRowSelectionState(row);

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
                            onClick={() => handleFocusRow(row.id)}
                          >
                            {isSelected ? "Selected" : "Focus"}
                          </Button>
                        </div>
                        <div className="font-medium text-foreground">{row.id}</div>
                        <div className="text-xs text-muted-foreground">
                          Run {row.createdByRunId || "manual"}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">{renderBadges(row)}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{selectionState.displayLabel}</div>
                        {alternates.length > 0 ? (
                          <div className="mt-2">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                              Alternates
                            </div>
                            <div className="mt-1 grid gap-1">
                              {alternates.map((option, index) => (
                                <div
                                  key={option.id}
                                  className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground"
                                >
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium text-foreground">{option.optionLabel}</span>
                                    <Badge variant="outline">{formatOptionRank(option, index)}</Badge>
                                  </div>
                                  <div className="mt-1">{option.rationale || "No rationale provided."}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
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
                          {formatStatus(row.reviewState || row.status)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={approveBusy || rejectBusy || overrideBusy}
                            onClick={() =>
                              handleReviewAction(row, {
                                action: "accept_recommended",
                              })
                            }
                          >
                            {approveBusy ? "Approving..." : "Accept recommended"}
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={approveBusy || rejectBusy || overrideBusy}
                            onClick={() =>
                              handleReviewAction(row, {
                                action: "accept_manual_row",
                              })
                            }
                          >
                            Accept manual row
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={approveBusy || rejectBusy || overrideBusy}
                            onClick={() =>
                              handleReviewAction(row, {
                                action: "pending_review",
                              })
                            }
                          >
                            Pending review
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={approveBusy || rejectBusy || overrideBusy}
                            onClick={() =>
                              handleReviewAction(row, {
                                action: "override",
                                recommendedUnitPrice: `${row.recommendedUnitPrice ?? ""}`,
                                recommendedTotalPrice: `${row.recommendedTotalPrice ?? ""}`,
                                reason: "Override from workbench",
                              })
                            }
                          >
                            {overrideBusy ? "Overriding..." : "Override"}
                          </Button>
                          <Button
                            size="xs"
                            variant="destructive"
                            disabled={approveBusy || rejectBusy || overrideBusy}
                            onClick={() =>
                              handleReviewAction(row, {
                                action: "reject",
                              })
                            }
                          >
                            {rejectBusy ? "Rejecting..." : "Reject"}
                          </Button>
                          {alternates.map((option) => (
                            <Button
                              key={option.id}
                              size="xs"
                              variant="secondary"
                              disabled={approveBusy || rejectBusy || overrideBusy}
                              onClick={() =>
                                handleReviewAction(row, {
                                  action: "switch_to_alternate",
                                  alternateOptionId: option.id,
                                })
                              }
                              >
                              Switch {option.optionLabel}
                            </Button>
                          ))}
                          {isFreeTextManualRow(row) && onPromoteLocalCatalog ? (
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => onPromoteLocalCatalog(row.id)}
                            >
                              Promote to local catalog
                            </Button>
                          ) : null}
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
