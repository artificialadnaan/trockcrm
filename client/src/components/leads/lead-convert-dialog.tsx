import { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEAL_SCOPE_TITLE_EXAMPLES,
  DEAL_SCOPE_TITLE_MAX_LENGTH,
} from "@trock-crm/shared/types";
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
  const [scopeTitle, setScopeTitle] = useState("");

  // This dialog is mounted UNCONDITIONALLY by the lead detail page — it is not gated on `open`, so it
  // never unmounts and its state survives a close. Without this reset, a title typed and then cancelled
  // is still sitting in the field the next time Convert is opened, and a rep who does not re-read the
  // form commits an abandoned draft as the deal's accounting title. Reset on open, the same shape
  // lead-stage-change-dialog in this directory already uses.
  useEffect(() => {
    if (!open) return;
    setScopeTitle("");
    setError(null);
  }, [open]);

  const handleConvert = async () => {
    const trimmedScopeTitle = scopeTitle.trim();
    // The convert route enforces the same cap server-side; this is so the rep sees it before the round
    // trip, not instead of it.
    if (trimmedScopeTitle.length > DEAL_SCOPE_TITLE_MAX_LENGTH) {
      setError(`Scope title must be ${DEAL_SCOPE_TITLE_MAX_LENGTH} characters or fewer`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await convertLeadToOpportunity(lead.id, { scopeTitle: trimmedScopeTitle || null });
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

        {/* The ONLY input on this dialog, and deliberately so. Conversion is the moment a lead becomes a
            real project, and it is the one point in the flow where the rep is asked anything — so it is
            where the accounting title gets captured. Not prefilled from the lead: leads.description is
            the same notes field the title exists to replace (live p90 200 chars, max 2658, real values
            like "fsad" and "[Archived — test data]"), so seeding it would manufacture wrong titles that
            look authoritative. Optional, like everywhere else. */}
        <div className="space-y-2">
          <Label htmlFor="convertScopeTitle">Scope Title <span className="text-xs font-normal text-slate-500">(optional)</span></Label>
          <Input
            id="convertScopeTitle"
            placeholder={`e.g. ${DEAL_SCOPE_TITLE_EXAMPLES.join(", ")}`}
            value={scopeTitle}
            onChange={(event) => setScopeTitle(event.target.value)}
            aria-describedby="convertScopeTitle-help"
          />
          <p id="convertScopeTitle-help" className="text-xs text-muted-foreground">
            A few words naming the overall scope. Accounting uses this as the project title; it can be
            added or corrected on the deal later.{" "}
            <span className={scopeTitle.trim().length > DEAL_SCOPE_TITLE_MAX_LENGTH ? "text-red-600" : undefined}>
              {scopeTitle.length}/{DEAL_SCOPE_TITLE_MAX_LENGTH}
            </span>
          </p>
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
