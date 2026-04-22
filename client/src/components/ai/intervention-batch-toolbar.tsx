import { useMemo, useState } from "react";
import type {
  EscalateConclusionPayload,
  ResolveConclusionPayload,
  SnoozeConclusionPayload,
} from "@/lib/intervention-outcome-taxonomy";
import type { InterventionMutationResult } from "@/hooks/use-admin-interventions";
import { InterventionConclusionForm } from "@/components/ai/intervention-conclusion-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface InterventionBatchToolbarProps {
  selectedCount: number;
  working: boolean;
  onAssign: (input: { assignedTo: string; notes: string | null }) => Promise<InterventionMutationResult | null>;
  onSnooze: (input: { conclusion: SnoozeConclusionPayload }) => Promise<InterventionMutationResult | null>;
  onResolve: (input: { conclusion: ResolveConclusionPayload }) => Promise<InterventionMutationResult | null>;
  onEscalate: (input: { conclusion: EscalateConclusionPayload }) => Promise<InterventionMutationResult | null>;
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
  const [assignNotes, setAssignNotes] = useState("");
  const [resetKey, setResetKey] = useState(0);

  const disabled = useMemo(() => selectedCount === 0 || working, [selectedCount, working]);

  function clearAssignFormState() {
    setAssignedTo("");
    setAssignNotes("");
  }

  function handleSuccessfulStructuredAction(result: InterventionMutationResult | null) {
    if ((result?.updatedCount ?? 0) > 0) {
      setResetKey((current) => current + 1);
    }
  }

  return (
    <div className="rounded-xl border border-border/80 bg-white p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Batch intervention actions</div>
          <div className="text-xs text-muted-foreground mt-1">
            {selectedCount === 0
              ? "Select cases to assign, snooze, resolve, or escalate."
              : `${selectedCount} case${selectedCount === 1 ? "" : "s"} selected.`}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr] gap-4">
        <div className="space-y-2 rounded-lg border border-border/70 p-4">
          <Label htmlFor="batch-assigned-to">Assign to</Label>
          <Input
            id="batch-assigned-to"
            placeholder="User UUID"
            value={assignedTo}
            onChange={(event) => setAssignedTo(event.target.value)}
          />
          <Label htmlFor="batch-assign-notes">Assignment notes</Label>
          <Input
            id="batch-assign-notes"
            placeholder="Why this assignment is being made"
            value={assignNotes}
            onChange={(event) => setAssignNotes(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={disabled || assignedTo.trim().length === 0}
            onClick={async () => {
              const result = await onAssign({
                assignedTo: assignedTo.trim(),
                notes: assignNotes.trim() || null,
              });
              if ((result?.updatedCount ?? 0) > 0) clearAssignFormState();
            }}
          >
            Assign selected
          </Button>
        </div>

        <div className="rounded-lg border border-border/70 p-4">
          <InterventionConclusionForm
            mode="snooze"
            submitLabel="Snooze selected"
            disabled={disabled}
            resetKey={`snooze-${resetKey}-${selectedCount}`}
            onSubmit={async (payload) => {
              const result = await onSnooze({ conclusion: payload as SnoozeConclusionPayload });
              handleSuccessfulStructuredAction(result);
            }}
          />
        </div>

        <div className="rounded-lg border border-border/70 p-4">
          <InterventionConclusionForm
            mode="resolve"
            submitLabel="Resolve selected"
            disabled={disabled}
            resetKey={`resolve-${resetKey}-${selectedCount}`}
            onSubmit={async (payload) => {
              const result = await onResolve({ conclusion: payload as ResolveConclusionPayload });
              handleSuccessfulStructuredAction(result);
            }}
          />
        </div>

        <div className="rounded-lg border border-border/70 p-4">
          <InterventionConclusionForm
            mode="escalate"
            submitLabel="Escalate selected"
            disabled={disabled}
            resetKey={`escalate-${resetKey}-${selectedCount}`}
            onSubmit={async (payload) => {
              const result = await onEscalate({ conclusion: payload as EscalateConclusionPayload });
              handleSuccessfulStructuredAction(result);
            }}
          />
        </div>
      </div>
    </div>
  );
}
