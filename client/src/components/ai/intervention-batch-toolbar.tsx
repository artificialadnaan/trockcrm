import { useMemo, useState } from "react";
import type { InterventionMutationResult, InterventionResolutionReason } from "@/hooks/use-admin-interventions";
import { INTERVENTION_RESOLUTION_OPTIONS } from "@/hooks/use-admin-interventions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface InterventionBatchToolbarProps {
  selectedCount: number;
  working: boolean;
  onAssign: (input: { assignedTo: string; notes: string | null }) => Promise<InterventionMutationResult | null>;
  onSnooze: (input: { snoozedUntil: string; notes: string | null }) => Promise<InterventionMutationResult | null>;
  onResolve: (
    input: { resolutionReason: InterventionResolutionReason; notes: string | null }
  ) => Promise<InterventionMutationResult | null>;
  onEscalate: (input: { notes: string | null }) => Promise<InterventionMutationResult | null>;
}

export function InterventionBatchToolbar({
  selectedCount,
  working,
  onAssign,
  onSnooze,
  onResolve,
  onEscalate,
}: InterventionBatchToolbarProps) {
  const [assignedTo, setAssignedTo] = useState("");
  const [snoozedUntil, setSnoozedUntil] = useState("");
  const [resolutionReason, setResolutionReason] = useState<InterventionResolutionReason>("task_completed");
  const [notes, setNotes] = useState("");

  const disabled = useMemo(() => selectedCount === 0 || working, [selectedCount, working]);

  function clearFormState() {
    setAssignedTo("");
    setSnoozedUntil("");
    setResolutionReason("task_completed");
    setNotes("");
  }

  return (
    <div className="rounded-xl border border-border/80 bg-white p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Batch intervention actions</div>
          <div className="text-xs text-muted-foreground mt-1">
            {selectedCount === 0 ? "Select cases to assign, snooze, resolve, or escalate." : `${selectedCount} case${selectedCount === 1 ? "" : "s"} selected.`}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr_1fr] gap-4">
        <div className="space-y-2">
          <Label htmlFor="batch-assigned-to">Assign to</Label>
          <Input
            id="batch-assigned-to"
            placeholder="User UUID"
            value={assignedTo}
            onChange={(event) => setAssignedTo(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={disabled || assignedTo.trim().length === 0}
            onClick={async () => {
              const result = await onAssign({ assignedTo: assignedTo.trim(), notes: notes.trim() || null });
              if ((result?.updatedCount ?? 0) > 0) clearFormState();
            }}
          >
            Assign selected
          </Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="batch-snooze-until">Snooze until</Label>
          <Input
            id="batch-snooze-until"
            type="datetime-local"
            value={snoozedUntil}
            onChange={(event) => setSnoozedUntil(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={disabled || snoozedUntil.trim().length === 0}
            onClick={async () => {
              const result = await onSnooze({ snoozedUntil, notes: notes.trim() || null });
              if ((result?.updatedCount ?? 0) > 0) clearFormState();
            }}
          >
            Snooze selected
          </Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="batch-resolution-reason">Resolve reason</Label>
          <Select value={resolutionReason} onValueChange={(value) => setResolutionReason(value as InterventionResolutionReason)}>
            <SelectTrigger id="batch-resolution-reason">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INTERVENTION_RESOLUTION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={disabled}
              onClick={async () => {
                const result = await onResolve({ resolutionReason, notes: notes.trim() || null });
                if ((result?.updatedCount ?? 0) > 0) clearFormState();
              }}
            >
              Resolve selected
            </Button>
            <Button
              variant="outline"
              disabled={disabled}
              onClick={async () => {
                const result = await onEscalate({ notes: notes.trim() || null });
                if ((result?.updatedCount ?? 0) > 0) clearFormState();
              }}
            >
              Escalate selected
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="batch-notes">Notes</Label>
        <Textarea
          id="batch-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Explain why this batch action is being taken."
          rows={3}
        />
      </div>
    </div>
  );
}
