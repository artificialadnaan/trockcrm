import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

export type ManualRowSelectionMode = "manual" | "catalog_option";

export interface ManualRowDraft {
  label: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  notes: string;
  selectedSourceType: ManualRowSelectionMode;
  selectedOptionId: string;
}

export interface ManualRowCatalogOption {
  id: string;
  optionLabel: string;
  optionKind?: "recommended" | "alternate" | "manual";
  rank?: number | null;
  rationale?: string | null;
  stableId?: string | null;
  catalogItemId?: string | null;
  localCatalogItemId?: string | null;
}

export interface EstimateManualRowDialogProps {
  dealId: string;
  generationRunId?: string | null;
  extractionMatchId?: string | null;
  estimateSectionName?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: () => Promise<void> | void;
  initialValues?: Partial<ManualRowDraft>;
  catalogOptions?: ManualRowCatalogOption[];
}

const DEFAULT_DRAFT: ManualRowDraft = {
  label: "",
  quantity: "",
  unit: "",
  unitPrice: "",
  notes: "",
  selectedSourceType: "manual",
  selectedOptionId: "",
};

function normalizeManualRowDraft(draft: Partial<ManualRowDraft> | undefined): ManualRowDraft {
  return {
    label: draft?.label ?? DEFAULT_DRAFT.label,
    quantity: draft?.quantity ?? DEFAULT_DRAFT.quantity,
    unit: draft?.unit ?? DEFAULT_DRAFT.unit,
    unitPrice: draft?.unitPrice ?? DEFAULT_DRAFT.unitPrice,
    notes: draft?.notes ?? DEFAULT_DRAFT.notes,
    selectedSourceType: draft?.selectedSourceType ?? DEFAULT_DRAFT.selectedSourceType,
    selectedOptionId: draft?.selectedOptionId ?? DEFAULT_DRAFT.selectedOptionId,
  };
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase();
}

function hasManualRowCreationContext(generationRunId?: string | null, estimateSectionName?: string | null) {
  return Boolean(generationRunId?.trim() && estimateSectionName?.trim());
}

export function switchManualRowDraftToFreeText(draft: ManualRowDraft): ManualRowDraft {
  return {
    ...draft,
    selectedSourceType: "manual",
    selectedOptionId: "",
  };
}

export async function runEstimateManualRowCreateAction({
  dealId,
  generationRunId,
  extractionMatchId,
  estimateSectionName,
  input,
  catalogQuery,
  catalogOptions = [],
  refresh,
}: {
  dealId: string;
  generationRunId: string;
  extractionMatchId: string;
  estimateSectionName: string;
  input: ManualRowDraft;
  catalogQuery?: string;
  catalogOptions?: ManualRowCatalogOption[];
  refresh: () => Promise<void>;
}) {
  const trimmedCatalogQuery = catalogQuery?.trim();
  const shouldSearchBeyondPrefilledOptions =
    Boolean(trimmedCatalogQuery) && !input.selectedOptionId?.trim();
  const json: Record<string, unknown> = {
    generationRunId,
    extractionMatchId,
    estimateSectionName,
    manualLabel: input.label,
    manualQuantity: input.quantity,
    manualUnit: input.unit,
    manualUnitPrice: input.unitPrice,
    manualNotes: input.notes,
    selectedSourceType: input.selectedSourceType,
  };

  if (trimmedCatalogQuery) {
    json.catalogQuery = trimmedCatalogQuery;
  }

  if (!shouldSearchBeyondPrefilledOptions && catalogOptions.length > 0) {
    json.catalogOptions = catalogOptions.map((option) => {
      const normalizedOption: Record<string, unknown> = {
        optionLabel: option.optionLabel,
        stableId: option.stableId ?? option.id,
      };

      if (option.optionKind && option.optionKind !== "manual") {
        normalizedOption.optionKind = option.optionKind;
      }
      if (option.catalogItemId) {
        normalizedOption.catalogItemId = option.catalogItemId;
      }
      if (option.localCatalogItemId) {
        normalizedOption.localCatalogItemId = option.localCatalogItemId;
      }

      return normalizedOption;
      });
  }

  if (input.selectedOptionId?.trim()) {
    const selectedCatalogOption = catalogOptions.find((option) => option.id === input.selectedOptionId);
    json.selectedOptionStableId = selectedCatalogOption?.stableId ?? selectedCatalogOption?.id ?? input.selectedOptionId;
  }

  await api(`/deals/${dealId}/estimating/manual-rows`, {
    method: "POST",
    json,
  });
  await refresh();
}

export function EstimateManualRowDialog({
  dealId,
  generationRunId,
  extractionMatchId,
  estimateSectionName,
  open,
  onOpenChange,
  onSubmitted,
  initialValues,
  catalogOptions = [],
}: EstimateManualRowDialogProps) {
  const [draft, setDraft] = useState<ManualRowDraft>(() => normalizeManualRowDraft(initialValues));
  const [isSaving, setIsSaving] = useState(false);
  const [mode, setMode] = useState<"catalog" | "manual">("catalog");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [selectedCatalogOptionId, setSelectedCatalogOptionId] = useState<string | null>(
    initialValues?.selectedOptionId ?? null
  );
  const canCreateManualRow = Boolean(
    extractionMatchId?.trim() && hasManualRowCreationContext(generationRunId, estimateSectionName)
  );
  const hasManualPricingValues = Boolean(draft.quantity.trim() && draft.unitPrice.trim());

  useEffect(() => {
    if (open) {
      setDraft(normalizeManualRowDraft(initialValues));
      setMode(initialValues?.selectedSourceType === "manual" ? "manual" : "catalog");
      setCatalogQuery("");
      setSelectedCatalogOptionId(initialValues?.selectedOptionId ?? null);
    }
  }, [initialValues, open]);

  const filteredCatalogOptions = catalogOptions.filter((option) => {
    const query = normalizeSearch(catalogQuery);
    if (!query) return true;
    return (
      normalizeSearch(option.optionLabel).includes(query) ||
      normalizeSearch(option.rationale ?? "").includes(query)
    );
  });

  const selectedCatalogOption =
    catalogOptions.find((option) => option.id === selectedCatalogOptionId) ?? null;

  const useCatalogOption = (option: (typeof catalogOptions)[number]) => {
    setMode("catalog");
    setSelectedCatalogOptionId(option.id);
    setDraft((current) => ({
      ...current,
      label: option.optionLabel,
      selectedSourceType: "catalog_option",
      selectedOptionId: option.id,
    }));
  };

  const switchToManualMode = () => {
    setMode("manual");
    setSelectedCatalogOptionId(null);
    setDraft((current) => switchManualRowDraftToFreeText(current));
  };

  const handleSubmit = async () => {
    if (!canCreateManualRow) {
      toast.error("Manual row creation is unavailable until an active pricing run is selected.");
      return;
    }
    if (!hasManualPricingValues) {
      toast.error("Manual rows require quantity and unit price.");
      return;
    }

    setIsSaving(true);
    try {
      await runEstimateManualRowCreateAction({
        dealId,
        generationRunId: generationRunId!.trim(),
        extractionMatchId: extractionMatchId!.trim(),
        estimateSectionName: estimateSectionName!.trim(),
        input: draft,
        catalogQuery,
        catalogOptions,
        refresh: async () => {
          if (onSubmitted) {
            await onSubmitted();
          }
        },
      });
      toast.success("Manual estimate row created");
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to create manual row");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Add manual estimate row</DialogTitle>
          <DialogDescription>
            Search catalog options first, or switch to free-text/manual entry when the item is not in catalog.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          {!canCreateManualRow ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Manual row creation is unavailable until an active pricing run is selected.
            </div>
          ) : null}
          {mode === "catalog" ? (
            <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
              <div className="grid gap-2">
                <Label htmlFor="manual-row-search">Search catalog options</Label>
                <Input
                  id="manual-row-search"
                  value={catalogQuery}
                  onChange={(event) => setCatalogQuery(event.target.value)}
                  placeholder="Search by label or note"
                />
              </div>

              <div className="space-y-2">
                {filteredCatalogOptions.length > 0 ? (
                  filteredCatalogOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        selectedCatalogOptionId === option.id
                          ? "border-primary bg-primary/5"
                          : "border-border bg-background hover:bg-muted"
                      }`}
                      onClick={() => useCatalogOption(option)}
                    >
                      <div className="font-medium">{option.optionLabel}</div>
                      <div className="text-xs text-muted-foreground">
                        {option.rationale || "Catalog option"}
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="text-sm text-muted-foreground">
                    No catalog options match this search.
                  </div>
                )}
              </div>

              <Button
                variant="ghost"
                className="justify-start px-0"
                onClick={switchToManualMode}
              >
                Use free-text/manual row instead
              </Button>

              {selectedCatalogOption ? (
                <div className="text-xs text-muted-foreground">
                  Selected catalog option: {selectedCatalogOption.optionLabel}
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="catalog-row-quantity">Quantity</Label>
                  <Input
                    id="catalog-row-quantity"
                    value={draft.quantity}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, quantity: event.target.value }))
                    }
                    placeholder="2"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="catalog-row-unit">Unit</Label>
                  <Input
                    id="catalog-row-unit"
                    value={draft.unit}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, unit: event.target.value }))
                    }
                    placeholder="ea"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="catalog-row-unit-price">Unit price</Label>
                  <Input
                    id="catalog-row-unit-price"
                    value={draft.unitPrice}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, unitPrice: event.target.value }))
                    }
                    placeholder="125.00"
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="catalog-row-notes">Notes</Label>
                <Textarea
                  id="catalog-row-notes"
                  value={draft.notes}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, notes: event.target.value }))
                  }
                  placeholder="Optional estimator notes"
                />
              </div>
            </div>
          ) : (
            <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">Free-text manual row</div>
                  <div className="text-xs text-muted-foreground">
                    Add a custom scope item when no catalog option applies.
                  </div>
                </div>
                <Button variant="ghost" size="xs" onClick={() => setMode("catalog")}>
                  Search catalog options
                </Button>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="manual-row-label">Label</Label>
                <Input
                  id="manual-row-label"
                  value={draft.label}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, label: event.target.value }))
                  }
                  placeholder="Walk-in door kit"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="manual-row-quantity">Quantity</Label>
                  <Input
                    id="manual-row-quantity"
                    value={draft.quantity}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, quantity: event.target.value }))
                    }
                    placeholder="2"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="manual-row-unit">Unit</Label>
                  <Input
                    id="manual-row-unit"
                    value={draft.unit}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, unit: event.target.value }))
                    }
                    placeholder="ea"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="manual-row-unit-price">Unit price</Label>
                  <Input
                    id="manual-row-unit-price"
                    value={draft.unitPrice}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, unitPrice: event.target.value }))
                    }
                    placeholder="125.00"
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="manual-row-notes">Notes</Label>
                <Textarea
                  id="manual-row-notes"
                  value={draft.notes}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, notes: event.target.value }))
                  }
                  placeholder="Optional estimator notes"
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              isSaving || !draft.label.trim() || !canCreateManualRow || !hasManualPricingValues
            }
            onClick={handleSubmit}
          >
            {isSaving ? "Saving..." : "Add row"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
