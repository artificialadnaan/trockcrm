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
  manualOrigin?: string | null;
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

function hasNumericPriceValue(value: string | number | null | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  const trimmed = value?.trim();
  return Boolean(trimmed) && !Number.isNaN(Number(trimmed));
}

export interface PricingReviewStateActionInput {
  action: PricingReviewStateAction;
  alternateOptionId?: string | null;
  recommendedUnitPrice?: string;
  recommendedTotalPrice?: string;
  reason?: string | null;
}

export function collectPricingOverrideInput(row: Pick<
  PricingReviewRow,
  "recommendedUnitPrice" | "recommendedTotalPrice"
>) {
  if (typeof window === "undefined") {
    return null;
  }

  const unitPrice = window.prompt(
    "Override unit price",
    row.recommendedUnitPrice == null ? "" : `${row.recommendedUnitPrice}`
  );
  if (unitPrice == null) {
    return null;
  }

  const totalPrice = window.prompt(
    "Override total price",
    row.recommendedTotalPrice == null ? "" : `${row.recommendedTotalPrice}`
  );
  if (totalPrice == null) {
    return null;
  }

  const reason =
    window.prompt("Override reason", "Override from workbench") ?? "Override from workbench";

  return {
    recommendedUnitPrice: unitPrice,
    recommendedTotalPrice: totalPrice,
    reason: reason.trim() || "Override from workbench",
  };
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

function getNumberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatOptionRank(option: PricingRecommendationOption, fallbackIndex: number) {
  return `Rank ${option.rank ?? fallbackIndex + 1}`;
}

function getObjectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getMarketRateEvidence(row: PricingReviewRow | null) {
  if (!row) return null;
  const assumptions = getObjectValue(row.assumptionsJson);
  const evidence = getObjectValue(row.evidenceJson);
  const marketRate = getObjectValue(assumptions?.marketRate) ?? getObjectValue(evidence?.marketRate);
  return marketRate;
}

function getSupplementalJsonSummary(value: unknown) {
  const objectValue = getObjectValue(value);
  if (!objectValue) {
    return summarizeUnknown(value);
  }

  const { marketRate: _marketRate, ...rest } = objectValue;
  if (Object.keys(rest).length === 0) {
    return "No additional detail";
  }

  return summarizeUnknown(rest);
}

function formatAdjustmentPercent(value: unknown) {
  const numeric = getNumberValue(value);
  if (numeric == null) {
    return "No delta";
  }

  return `${numeric > 0 ? "+" : ""}${numeric}%`;
}

function renderMarketRateEvidence(row: PricingReviewRow | null) {
  const marketRate = getMarketRateEvidence(row);
  if (!marketRate) return null;

  const resolvedMarket = getObjectValue(marketRate.resolvedMarket);
  const resolutionSource = getObjectValue(marketRate.resolutionSource);
  const componentAdjustments = Array.isArray(marketRate.componentAdjustments)
    ? (marketRate.componentAdjustments as Array<Record<string, unknown>>)
    : [];
  const adjustedPrice =
    getNumberValue(marketRate.adjustedPrice) ??
    getNumberValue(row?.recommendedUnitPrice) ??
    getNumberValue(row?.recommendedTotalPrice);
  const fallbackSource = getObjectValue(marketRate.fallbackSource);
  const mode = marketRate.resolutionLevel === "override" ? "Override active" : "Auto-detected";

  return (
    <div className="grid gap-2 rounded-md border bg-muted/20 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        Market-rate rationale
      </div>
      <div>
        Market rate: {String(resolvedMarket?.name ?? "Unknown market")} ·{" "}
        {String(marketRate.resolutionLevel ?? "unknown")}
      </div>
      <div>{mode}</div>
      <div>Baseline: {formatCurrency(marketRate.baselinePrice as string | number | null | undefined)}</div>
      <div>Adjusted: {formatCurrency(adjustedPrice)}</div>
      {componentAdjustments.map((component) => (
        <div key={String(component.component ?? "component")}>
          {String(component.component ?? "component")}:{" "}
          {formatAdjustmentPercent(component.adjustmentPercent)}{" "}
          ({formatCurrency(component.adjustedAmount as string | number | null | undefined)})
        </div>
      ))}
      <div>
        Resolution source: {String(resolutionSource?.type ?? "unknown")}
        {resolutionSource?.key ? ` (${String(resolutionSource.key)})` : ""}
      </div>
      {fallbackSource ? (
        <div>
          Fallback: {String(fallbackSource.type ?? "unknown")}
          {fallbackSource.key ? ` (${String(fallbackSource.key)})` : ""}
        </div>
      ) : null}
    </div>
  );
}

export function isFreeTextManualRow(row: Pick<
  PricingReviewRow,
  | "selectedSourceType"
  | "selectedOptionId"
  | "catalogBacking"
  | "promotedLocalCatalogItemId"
  | "sourceType"
  | "manualOrigin"
>) {
  return (
    row.sourceType === "manual" &&
    row.manualOrigin !== "generated" &&
    !row.selectedOptionId &&
    (!row.catalogBacking || row.catalogBacking === "estimate_only") &&
    row.catalogBacking !== "local_promoted" &&
    !row.promotedLocalCatalogItemId
  );
}

function getRecommendedOption(row: Pick<PricingReviewRow, "recommendationOptions">) {
  return row.recommendationOptions?.find((option) => option.optionKind === "recommended") ?? null;
}

function canOverridePricingRow(
  row: Pick<PricingReviewRow, "recommendedUnitPrice" | "recommendedTotalPrice">
) {
  return (
    hasNumericPriceValue(row.recommendedUnitPrice) &&
    hasNumericPriceValue(row.recommendedTotalPrice)
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
  actionsDisabled,
  onRefresh,
  onReviewAction,
  onFocusRow,
  onOpenManualAdd,
  onPromoteToEstimate,
  onPromoteLocalCatalog,
}: {
  dealId: string;
  rows: PricingReviewRow[];
  actionsDisabled?: boolean;
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

  const handlePromoteLocalCatalog = async (row: PricingReviewRow) => {
    if (!onPromoteLocalCatalog) {
      return;
    }

    setPendingAction(`${row.id}:promote_local_catalog`);
    try {
      await onPromoteLocalCatalog(row.id);
      toast.success("Manual row promoted to local catalog");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to promote manual row");
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

    if (row.catalogBacking === "local_promoted" || row.promotedLocalCatalogItemId) {
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
                  const rowActionBusy =
                    actionsDisabled || (pendingAction?.startsWith(`${row.id}:`) ?? false);
                  const approveBusy = pendingAction === `${row.id}:accept_recommended`;
                  const rejectBusy = pendingAction === `${row.id}:reject`;
                  const overrideBusy = pendingAction === `${row.id}:override`;
                  const promoteBusy = pendingAction === `${row.id}:promote_local_catalog`;
                  const options = row.recommendationOptions ?? [];
                  const alternates = options.filter((option) => option.optionKind === "alternate");
                  const selectionState = getPricingRowSelectionState(row);
                  const recommendedOption = getRecommendedOption(row);
                  const canOverride = canOverridePricingRow(row);

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
                          {recommendedOption ? (
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={rowActionBusy}
                              onClick={() =>
                                handleReviewAction(row, {
                                  action: "accept_recommended",
                                })
                              }
                            >
                              {approveBusy ? "Approving..." : "Accept recommended"}
                            </Button>
                          ) : null}
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={rowActionBusy}
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
                            disabled={rowActionBusy}
                            onClick={() =>
                              handleReviewAction(row, {
                                action: "pending_review",
                              })
                            }
                          >
                            Pending review
                          </Button>
                          {canOverride ? (
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={rowActionBusy}
                              onClick={() => {
                                const overrideInput = collectPricingOverrideInput(row);
                                if (!overrideInput) {
                                  return;
                                }

                                return handleReviewAction(row, {
                                  action: "override",
                                  ...overrideInput,
                                });
                              }}
                            >
                              {overrideBusy ? "Overriding..." : "Override"}
                            </Button>
                          ) : null}
                          <Button
                            size="xs"
                            variant="destructive"
                            disabled={rowActionBusy}
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
                              disabled={rowActionBusy}
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
                              disabled={rowActionBusy}
                              onClick={() => handlePromoteLocalCatalog(row)}
                            >
                              {promoteBusy ? "Promoting..." : "Promote to local catalog"}
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
            {selectedRow ? renderMarketRateEvidence(selectedRow) : null}
            <div>
              Assumptions:{" "}
              {selectedRow ? getSupplementalJsonSummary(selectedRow.assumptionsJson) : "No detail"}
            </div>
            <div>
              Evidence: {selectedRow ? getSupplementalJsonSummary(selectedRow.evidenceJson) : "No detail"}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
