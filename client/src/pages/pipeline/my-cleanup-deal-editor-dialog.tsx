import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DealForm } from "@/components/deals/deal-form";
import { useDealDetail } from "@/hooks/use-deals";

interface MyCleanupDealEditorDialogProps {
  dealId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function MyCleanupDealEditorDialog({
  dealId,
  open,
  onOpenChange,
  onSaved,
}: MyCleanupDealEditorDialogProps) {
  const { deal, loading, error } = useDealDetail(open ? dealId ?? undefined : undefined);

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
          <DealForm
            deal={deal}
            onSuccess={() => {
              onOpenChange(false);
              onSaved();
            }}
          />
        ) : (
          <div className="py-8 text-sm text-muted-foreground">Select a deal to edit.</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
