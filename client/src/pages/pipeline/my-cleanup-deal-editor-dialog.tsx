import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DealForm } from "@/components/deals/deal-form";
import { ForecastEditor } from "@/components/shared/forecast-editor";
import { NextStepEditor } from "@/components/shared/next-step-editor";
import { useDealDetail, updateDeal } from "@/hooks/use-deals";

interface MyCleanupDealEditorDialogProps {
  dealId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void | Promise<void>;
}

export function MyCleanupDealEditorDialog({
  dealId,
  open,
  onOpenChange,
  onSaved,
}: MyCleanupDealEditorDialogProps) {
  const { deal, loading, error, refetch } = useDealDetail(open ? dealId ?? undefined : undefined);

  const handleSectionSave = async (payload: Record<string, unknown>) => {
    if (!dealId) return;
    await updateDeal(dealId, {
      ...payload,
      migrationMode: deal && !deal.sourceLeadId ? true : undefined,
    });
    await refetch();
    await onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{deal ? `Edit Deal: ${deal.name}` : "Edit Deal"}</DialogTitle>
          <DialogDescription>
            Update the deal directly from your cleanup queue. The item will disappear automatically once the
            underlying cleanup issue is resolved.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-sm text-muted-foreground">Loading deal...</div>
        ) : error ? (
          <div className="py-8 text-sm text-rose-600">{error}</div>
        ) : deal ? (
          <div className="space-y-4">
            <DealForm
              deal={deal}
              onSuccess={async () => {
                await refetch();
                await onSaved();
                onOpenChange(false);
              }}
            />
            <ForecastEditor
              value={{
                forecastWindow: deal.forecastWindow,
                forecastCategory: deal.forecastCategory,
                forecastConfidencePercent: deal.forecastConfidencePercent,
                forecastRevenue: deal.forecastRevenue,
                forecastGrossProfit: deal.forecastGrossProfit,
                forecastBlockers: deal.forecastBlockers,
                nextMilestoneAt: deal.nextMilestoneAt,
              }}
              onSave={handleSectionSave}
            />
            <NextStepEditor
              value={{
                nextStep: deal.nextStep,
                nextStepDueAt: deal.nextStepDueAt,
                supportNeededType: deal.supportNeededType,
                supportNeededNotes: deal.supportNeededNotes,
                decisionMakerName: deal.decisionMakerName,
                budgetStatus: deal.budgetStatus,
              }}
              onSave={handleSectionSave}
            />
          </div>
        ) : (
          <div className="py-8 text-sm text-muted-foreground">Select a deal to edit.</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
