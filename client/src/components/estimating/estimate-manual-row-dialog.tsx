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

export interface EstimateManualRowDialogProps {
  dealId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: () => Promise<void> | void;
  initialValues?: Partial<ManualRowDraft>;
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

export async function runEstimateManualRowCreateAction({
  dealId,
  input,
  refresh,
}: {
  dealId: string;
  input: ManualRowDraft;
  refresh: () => Promise<void>;
}) {
  const json: Record<string, unknown> = {
    label: input.label,
    quantity: input.quantity,
    unit: input.unit,
    unitPrice: input.unitPrice,
    notes: input.notes,
    selectedSourceType: input.selectedSourceType,
  };

  if (input.selectedOptionId?.trim()) {
    json.selectedOptionId = input.selectedOptionId;
  }

  await api(`/deals/${dealId}/estimating/manual-rows`, {
    method: "POST",
    json,
  });
  await refresh();
}

export function EstimateManualRowDialog({
  dealId,
  open,
  onOpenChange,
  onSubmitted,
  initialValues,
}: EstimateManualRowDialogProps) {
  const [draft, setDraft] = useState<ManualRowDraft>(() => normalizeManualRowDraft(initialValues));
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(normalizeManualRowDraft(initialValues));
    }
  }, [initialValues, open]);

  const handleSubmit = async () => {
    setIsSaving(true);
    try {
      await runEstimateManualRowCreateAction({
        dealId,
        input: draft,
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
            Start from a free-text row or attach a catalog option when the row already exists in the local catalog.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
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
            <Label htmlFor="manual-row-source-type">Source type</Label>
            <select
              id="manual-row-source-type"
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none"
              value={draft.selectedSourceType}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  selectedSourceType: event.target.value as ManualRowSelectionMode,
                }))
              }
            >
              <option value="manual">Free-text manual row</option>
              <option value="catalog_option">Catalog option</option>
            </select>
          </div>

          {draft.selectedSourceType === "catalog_option" ? (
            <div className="grid gap-2">
              <Label htmlFor="manual-row-option-id">Catalog option id</Label>
              <Input
                id="manual-row-option-id"
                value={draft.selectedOptionId}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, selectedOptionId: event.target.value }))
                }
                placeholder="option-123"
              />
            </div>
          ) : null}

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

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={isSaving || !draft.label.trim()} onClick={handleSubmit}>
            {isSaving ? "Saving..." : "Add row"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
