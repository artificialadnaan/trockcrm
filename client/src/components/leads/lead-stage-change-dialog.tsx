import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StageGateChecklist } from "@/components/deals/stage-gate-checklist";
import {
  preflightLeadStageCheck,
  transitionLeadStage,
  type LeadRecord,
  type LeadStageGateResult,
} from "@/hooks/use-leads";

export function LeadStageChangeDialog({
  lead,
  targetStageId,
  targetStageName,
  open,
  onOpenChange,
  onEditLead,
  onSuccess,
}: {
  lead: LeadRecord;
  targetStageId: string | null;
  targetStageName?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEditLead?: () => void;
  onSuccess: () => void;
}) {
  const [preflight, setPreflight] = useState<LeadStageGateResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtimeMissingLabels, setRuntimeMissingLabels] = useState<string[]>([]);

  useEffect(() => {
    if (!open || !targetStageId) {
      return;
    }

    setLoading(true);
    setError(null);
    setRuntimeMissingLabels([]);
    preflightLeadStageCheck(lead.id, targetStageId)
      .then((result) => setPreflight(result))
      .catch((err) => setError(err instanceof Error ? err.message : "Preflight failed"))
      .finally(() => setLoading(false));
  }, [lead.id, open, targetStageId]);

  const handleSubmit = async () => {
    if (!targetStageId || !preflight?.allowed) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await transitionLeadStage(lead.id, { targetStageId });
      if (!result.ok) {
        setRuntimeMissingLabels(result.missing.map((field) => field.label));
        setError(`Complete the missing fields before moving this lead to ${targetStageName ?? "the next stage"}.`);
        return;
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update lead stage");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRight className="h-5 w-5 text-brand-red" />
            Advance Lead Stage
          </DialogTitle>
          <DialogDescription>
            {lead.name}
            {targetStageName ? ` → ${targetStageName}` : ""}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : preflight ? (
          <div className="space-y-4">
            {!preflight.allowed && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                <div className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  {preflight.blockReason ?? "Lead stage change blocked"}
                </div>
              </div>
            )}
            <StageGateChecklist
              missingRequirements={{
                fields: preflight.missingRequirements.fields,
                documents: [],
                approvals: [],
                effectiveChecklist: {
                  fields: preflight.missingRequirements.effectiveChecklist.fields,
                  attachments: [],
                  approvals: [],
                },
              }}
            />
            {runtimeMissingLabels.length > 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                <div className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  Complete required fields
                </div>
                <p className="mt-1">{runtimeMissingLabels.join(", ")}</p>
              </div>
            ) : null}
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        ) : null}

        <DialogFooter showCloseButton>
          {onEditLead && (!preflight?.allowed || runtimeMissingLabels.length > 0) ? (
            <Button variant="outline" onClick={onEditLead}>
              Edit Lead
            </Button>
          ) : null}
          <Button
            onClick={handleSubmit}
            disabled={!preflight?.allowed || submitting}
          >
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Move Lead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
