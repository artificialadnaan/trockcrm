import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface LeadConversionDialogProps {
  leadId: string | null;
  defaultDealStageId: string | null;
  defaultWorkflowRoute: "normal" | "service";
  onConfirm: (input: {
    leadId: string;
    dealStageId: string;
    workflowRoute: "normal" | "service";
  }) => Promise<unknown>;
  onOpenChange: (open: boolean) => void;
}

export function LeadConversionDialog({
  leadId,
  defaultDealStageId,
  defaultWorkflowRoute,
  onConfirm,
  onOpenChange,
}: LeadConversionDialogProps) {
  const open = leadId != null;
  const [workflowRoute, setWorkflowRoute] = useState<"normal" | "service">(defaultWorkflowRoute);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setWorkflowRoute(defaultWorkflowRoute);
  }, [defaultWorkflowRoute, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convert Lead</DialogTitle>
          <DialogDescription>
            Lead conversion keeps drag-and-drop on the board while preserving the explicit conversion flow.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="lead-conversion-stage">Deal Stage</Label>
            <Input id="lead-conversion-stage" readOnly value={defaultDealStageId ?? ""} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lead-conversion-route">Workflow Route</Label>
            <Select value={workflowRoute} onValueChange={(value) => setWorkflowRoute(value as "normal" | "service")}>
              <SelectTrigger id="lead-conversion-route">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">Standard</SelectItem>
                <SelectItem value="service">Service</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            disabled={!leadId || !defaultDealStageId || submitting}
            onClick={async () => {
              if (!leadId || !defaultDealStageId) return;
              setSubmitting(true);
              try {
                await onConfirm({
                  leadId,
                  dealStageId: defaultDealStageId,
                  workflowRoute,
                });
              } finally {
                setSubmitting(false);
              }
            }}
          >
            Convert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
