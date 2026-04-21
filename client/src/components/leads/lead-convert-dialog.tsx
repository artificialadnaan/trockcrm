import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { convertLeadToOpportunity, type LeadRecord } from "@/hooks/use-leads";

export function LeadConvertDialog({
  lead,
  open,
  onOpenChange,
  onSuccess,
}: {
  lead: LeadRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (dealId: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConvert = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await convertLeadToOpportunity(lead.id);
      onSuccess(result.deal.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to convert lead");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRight className="h-5 w-5 text-brand-red" />
            Convert to Opportunity
          </DialogTitle>
          <DialogDescription>
            {lead.name} will become a deal starting in the universal Opportunity stage.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          This conversion creates a deal record at <strong>Opportunity</strong>. Amount-based routing into Deals or Service happens after Opportunity review.
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <DialogFooter showCloseButton>
          <Button onClick={handleConvert} disabled={submitting}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Convert to Opportunity
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
