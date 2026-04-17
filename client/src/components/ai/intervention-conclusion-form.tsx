import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ESCALATION_TARGET_TYPES,
  RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES,
  SNOOZE_REASON_TO_EXPECTED_OPTIONS,
  type EscalateConclusionPayload,
  type ResolveConclusionPayload,
  type SnoozeConclusionPayload,
} from "@/lib/intervention-outcome-taxonomy";

const RESOLVE_EFFECTIVENESS_OPTIONS: Array<ResolveConclusionPayload["effectiveness"]> = [
  "confirmed",
  "likely",
  "unclear",
];

const ESCALATION_REASON_OPTIONS = [
  "manager_visibility_required",
  "cross_team_blocker",
  "customer_risk_needs_escalation",
  "execution_stall_needs_intervention",
] as const;

export function canSubmitInterventionConclusion(mode: "resolve", form: ResolveConclusionPayload): boolean;
export function canSubmitInterventionConclusion(mode: "snooze", form: SnoozeConclusionPayload): boolean;
export function canSubmitInterventionConclusion(mode: "escalate", form: EscalateConclusionPayload): boolean;
export function canSubmitInterventionConclusion(
  mode: "resolve" | "snooze" | "escalate",
  form: ResolveConclusionPayload | SnoozeConclusionPayload | EscalateConclusionPayload
) {
  if (mode === "resolve") {
    const resolveForm = form as ResolveConclusionPayload;
    return Boolean(resolveForm.outcomeCategory && resolveForm.reasonCode && resolveForm.effectiveness);
  }
  if (mode === "snooze") {
    const snoozeForm = form as SnoozeConclusionPayload;
    return Boolean(
      snoozeForm.snoozeReasonCode &&
      snoozeForm.expectedOwnerType &&
      snoozeForm.expectedNextStepCode &&
      snoozeForm.snoozedUntil
    );
  }

  const escalateForm = form as EscalateConclusionPayload;
  return Boolean(escalateForm.escalationReasonCode && escalateForm.escalationTargetType && escalateForm.urgency);
}

function emptyResolveForm(): ResolveConclusionPayload {
  return {
    kind: "resolve",
    outcomeCategory: "",
    reasonCode: "",
    effectiveness: "",
    notes: null,
  };
}

function emptySnoozeForm(): SnoozeConclusionPayload {
  return {
    kind: "snooze",
    snoozeReasonCode: "",
    expectedOwnerType: "",
    expectedNextStepCode: "",
    snoozedUntil: "",
    notes: null,
  };
}

function emptyEscalateForm(): EscalateConclusionPayload {
  return {
    kind: "escalate",
    escalationReasonCode: "",
    escalationTargetType: "",
    urgency: "",
    notes: null,
  };
}

export function InterventionConclusionForm(props: {
  mode: "resolve" | "snooze" | "escalate";
  onSubmit: (payload: ResolveConclusionPayload | SnoozeConclusionPayload | EscalateConclusionPayload) => Promise<void> | void;
  submitLabel: string;
  disabled?: boolean;
  resetKey?: string | number;
  initialSnoozedUntil?: string;
}) {
  const [resolveForm, setResolveForm] = useState<ResolveConclusionPayload>(emptyResolveForm);
  const [snoozeForm, setSnoozeForm] = useState<SnoozeConclusionPayload>(() => ({
    ...emptySnoozeForm(),
    snoozedUntil: props.initialSnoozedUntil ?? "",
  }));
  const [escalateForm, setEscalateForm] = useState<EscalateConclusionPayload>(emptyEscalateForm);

  useEffect(() => {
    setResolveForm(emptyResolveForm());
    setSnoozeForm({
      ...emptySnoozeForm(),
      snoozedUntil: props.initialSnoozedUntil ?? "",
    });
    setEscalateForm(emptyEscalateForm());
  }, [props.initialSnoozedUntil, props.resetKey]);

  const resolveReasonOptions = useMemo(() => {
    return RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES[
      resolveForm.outcomeCategory as keyof typeof RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES
    ] ?? [];
  }, [resolveForm.outcomeCategory]);

  const snoozeOptions = useMemo(() => {
    return SNOOZE_REASON_TO_EXPECTED_OPTIONS[
      snoozeForm.snoozeReasonCode as keyof typeof SNOOZE_REASON_TO_EXPECTED_OPTIONS
    ] ?? { ownerTypes: [], nextStepCodes: [] };
  }, [snoozeForm.snoozeReasonCode]);

  const activeForm =
    props.mode === "resolve" ? resolveForm : props.mode === "snooze" ? snoozeForm : escalateForm;
  const canSubmit = canSubmitInterventionConclusion(props.mode as never, activeForm as never);
  const resetToken = String(props.resetKey ?? "default");

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit || props.disabled) return;
        void props.onSubmit(activeForm);
      }}
    >
      {props.mode === "resolve" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="resolve-outcome-category">Outcome category</Label>
            <Select
              key={`resolve-outcome-category-${resetToken}`}
              value={resolveForm.outcomeCategory}
              onValueChange={(value) =>
                setResolveForm((current) => ({ ...current, outcomeCategory: String(value), reasonCode: "" }))
              }
            >
              <SelectTrigger id="resolve-outcome-category" aria-label="Outcome category">
                <SelectValue placeholder="Select outcome category" />
              </SelectTrigger>
              <SelectContent>
                {Object.keys(RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES).map((key) => (
                  <SelectItem key={key} value={key}>
                    {key.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="resolve-reason-code">Resolution reason</Label>
            <Select
              key={`resolve-reason-code-${resetToken}`}
              value={resolveForm.reasonCode}
              onValueChange={(value) => setResolveForm((current) => ({ ...current, reasonCode: String(value) }))}
            >
              <SelectTrigger id="resolve-reason-code" aria-label="Resolution reason">
                <SelectValue placeholder="Select resolution reason" />
              </SelectTrigger>
              <SelectContent>
                {resolveReasonOptions.map((key) => (
                  <SelectItem key={key} value={key}>
                    {key.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="resolve-effectiveness">Effectiveness</Label>
            <Select
              key={`resolve-effectiveness-${resetToken}`}
              value={resolveForm.effectiveness}
              onValueChange={(value) =>
                setResolveForm((current) => ({
                  ...current,
                  effectiveness: value as ResolveConclusionPayload["effectiveness"],
                }))
              }
            >
              <SelectTrigger id="resolve-effectiveness" aria-label="Effectiveness">
                <SelectValue placeholder="Select effectiveness" />
              </SelectTrigger>
              <SelectContent>
                {RESOLVE_EFFECTIVENESS_OPTIONS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="resolve-notes">Notes</Label>
            <Textarea
              id="resolve-notes"
              value={resolveForm.notes ?? ""}
              onChange={(event) =>
                setResolveForm((current) => ({ ...current, notes: event.target.value || null }))
              }
              rows={3}
            />
          </div>
        </>
      )}

      {props.mode === "snooze" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="snooze-reason-code">Snooze reason</Label>
            <Select
              key={`snooze-reason-code-${resetToken}`}
              value={snoozeForm.snoozeReasonCode}
              onValueChange={(value) =>
                setSnoozeForm((current) => ({
                  ...current,
                  snoozeReasonCode: String(value),
                  expectedOwnerType: "",
                  expectedNextStepCode: "",
                }))
              }
            >
              <SelectTrigger id="snooze-reason-code" aria-label="Snooze reason">
                <SelectValue placeholder="Select snooze reason" />
              </SelectTrigger>
              <SelectContent>
                {Object.keys(SNOOZE_REASON_TO_EXPECTED_OPTIONS).map((key) => (
                  <SelectItem key={key} value={key}>
                    {key.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="snooze-owner-type">Expected owner</Label>
            <Select
              key={`snooze-owner-type-${resetToken}`}
              value={snoozeForm.expectedOwnerType}
              onValueChange={(value) => setSnoozeForm((current) => ({ ...current, expectedOwnerType: String(value) }))}
            >
              <SelectTrigger id="snooze-owner-type" aria-label="Expected owner">
                <SelectValue placeholder="Select expected owner" />
              </SelectTrigger>
              <SelectContent>
                {snoozeOptions.ownerTypes.map((key) => (
                  <SelectItem key={key} value={key}>
                    {key.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="snooze-next-step-code">Expected next step</Label>
            <Select
              key={`snooze-next-step-code-${resetToken}`}
              value={snoozeForm.expectedNextStepCode}
              onValueChange={(value) => setSnoozeForm((current) => ({ ...current, expectedNextStepCode: String(value) }))}
            >
              <SelectTrigger id="snooze-next-step-code" aria-label="Expected next step">
                <SelectValue placeholder="Select expected next step" />
              </SelectTrigger>
              <SelectContent>
                {snoozeOptions.nextStepCodes.map((key) => (
                  <SelectItem key={key} value={key}>
                    {key.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="snooze-until">Snooze until</Label>
            <Input
              id="snooze-until"
              type="datetime-local"
              value={snoozeForm.snoozedUntil}
              onChange={(event) => setSnoozeForm((current) => ({ ...current, snoozedUntil: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="snooze-notes">Notes</Label>
            <Textarea
              id="snooze-notes"
              value={snoozeForm.notes ?? ""}
              onChange={(event) =>
                setSnoozeForm((current) => ({ ...current, notes: event.target.value || null }))
              }
              rows={3}
            />
          </div>
        </>
      )}

      {props.mode === "escalate" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="escalate-reason-code">Escalation reason</Label>
            <Select
              key={`escalate-reason-code-${resetToken}`}
              value={escalateForm.escalationReasonCode}
              onValueChange={(value) => setEscalateForm((current) => ({ ...current, escalationReasonCode: String(value) }))}
            >
              <SelectTrigger id="escalate-reason-code" aria-label="Escalation reason">
                <SelectValue placeholder="Select escalation reason" />
              </SelectTrigger>
              <SelectContent>
                {ESCALATION_REASON_OPTIONS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {key.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="escalate-target-type">Escalation target</Label>
            <Select
              key={`escalate-target-type-${resetToken}`}
              value={escalateForm.escalationTargetType}
              onValueChange={(value) => setEscalateForm((current) => ({ ...current, escalationTargetType: String(value) }))}
            >
              <SelectTrigger id="escalate-target-type" aria-label="Escalation target">
                <SelectValue placeholder="Select escalation target" />
              </SelectTrigger>
              <SelectContent>
                {ESCALATION_TARGET_TYPES.map((key) => (
                  <SelectItem key={key} value={key}>
                    {key.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="escalate-urgency">Urgency</Label>
            <Select
              key={`escalate-urgency-${resetToken}`}
              value={escalateForm.urgency}
              onValueChange={(value) =>
                setEscalateForm((current) => ({ ...current, urgency: value as EscalateConclusionPayload["urgency"] }))
              }
            >
              <SelectTrigger id="escalate-urgency" aria-label="Urgency">
                <SelectValue placeholder="Select urgency" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high">high</SelectItem>
                <SelectItem value="normal">normal</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="escalate-notes">Notes</Label>
            <Textarea
              id="escalate-notes"
              value={escalateForm.notes ?? ""}
              onChange={(event) =>
                setEscalateForm((current) => ({ ...current, notes: event.target.value || null }))
              }
              rows={3}
            />
          </div>
        </>
      )}

      <Button type="submit" disabled={!canSubmit || props.disabled}>
        {props.submitLabel}
      </Button>
    </form>
  );
}
