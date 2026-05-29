import { useEffect, useState } from "react";
import { Phone, FileText, Calendar, Plus, Handshake, MapPinned, PhoneCall, SendHorizontal, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { ActivitySourceEntityType } from "@/hooks/use-activities";

type LogType =
  | "call"
  | "note"
  | "meeting"
  | "voicemail"
  | "lunch"
  | "site_visit"
  | "email"
  | "proposal_sent"
  | "follow_up"
  | "go_no_go";

interface ActivityTargetOption {
  id: string;
  label: string;
  type: ActivitySourceEntityType;
}

interface ActivityLogFormProps {
  onSubmit: (data: {
    type: LogType;
    subject: string;
    body: string;
    outcome?: string;
    nextStep?: string;
    nextStepDueAt?: string;
    durationMinutes?: number;
    occurredAt?: string;
    responsibleUserId?: string;
    sourceEntityType?: ActivitySourceEntityType;
    sourceEntityId?: string;
  }) => Promise<void>;
  targetOptions?: ActivityTargetOption[];
  defaultResponsibleUserId?: string;
  showProposalSent?: boolean;
}

interface Assignee {
  id: string;
  displayName: string;
}

function encodeTarget(option: ActivityTargetOption) {
  return `${option.type}:${option.id}`;
}

function decodeTarget(value: string) {
  const [type, ...idParts] = value.split(":");
  if (!type || idParts.length === 0) return null;

  return {
    sourceEntityType: type as ActivitySourceEntityType,
    sourceEntityId: idParts.join(":"),
  };
}

function toDateTimeLocal(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getFormLabel(type: LogType) {
  if (type === "email") return "Email";
  return type.replace(/_/g, " ");
}

const CALL_OUTCOME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "connected", label: "Connected" },
  { value: "left_voicemail", label: "Left Voicemail" },
  { value: "no_answer", label: "No Answer" },
  { value: "scheduled_meeting", label: "Scheduled Meeting" },
];

export function ActivityLogForm({
  onSubmit,
  targetOptions = [],
  defaultResponsibleUserId,
  showProposalSent = true,
}: ActivityLogFormProps) {
  const { user } = useAuth();
  const [activeForm, setActiveForm] = useState<LogType | null>(null);
  const [body, setBody] = useState("");
  const [outcome, setOutcome] = useState<string>("");
  const [duration, setDuration] = useState<string>("");
  const [nextStep, setNextStep] = useState("");
  const [nextStepDueAt, setNextStepDueAt] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailFrom, setEmailFrom] = useState("");
  const [emailTo, setEmailTo] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailOccurredAt, setEmailOccurredAt] = useState(() => toDateTimeLocal(new Date()));
  const [target, setTarget] = useState<string>(targetOptions[0] ? encodeTarget(targetOptions[0]) : "");
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [responsibleUserId, setResponsibleUserId] = useState<string>(
    defaultResponsibleUserId ?? user?.id ?? ""
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (targetOptions[0] && !target) {
      setTarget(encodeTarget(targetOptions[0]));
    }
  }, [target, targetOptions]);

  useEffect(() => {
    let cancelled = false;

    api<{ users: Assignee[] }>("/tasks/assignees")
      .then((data) => {
        if (cancelled) return;

        setAssignees(data.users);
        const preferredUserId = defaultResponsibleUserId ?? user?.id ?? data.users[0]?.id ?? "";
        setResponsibleUserId((current) => {
          if (current && data.users.some((assignee) => assignee.id === current)) {
            return current;
          }
          return preferredUserId;
        });
      })
      .catch(() => {
        if (cancelled) return;

        if (user) {
          setAssignees([{ id: user.id, displayName: user.displayName }]);
          setResponsibleUserId((current) => current || defaultResponsibleUserId || user.id);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [defaultResponsibleUserId, user]);

  const resetForm = () => {
    setBody("");
    setOutcome("");
    setDuration("");
    setNextStep("");
    setNextStepDueAt("");
    setEmailSubject("");
    setEmailFrom("");
    setEmailTo("");
    setEmailBody("");
    setEmailOccurredAt(toDateTimeLocal(new Date()));
    setActiveForm(null);
    setError(null);
  };

  const setActiveLogForm = (type: LogType) => {
    if (activeForm === type) {
      resetForm();
      return;
    }

    setActiveForm(type);
    setError(null);
    if (type === "email") {
      setEmailOccurredAt(toDateTimeLocal(new Date()));
    }
  };

  const handleSubmit = async () => {
    if (!activeForm) return;
    if (activeForm !== "email" && !body.trim()) return;

    const selectedTarget = decodeTarget(target);

    if (targetOptions.length > 0 && !selectedTarget) {
      setError("Select a target entity");
      return;
    }

    if (assignees.length > 0 && !responsibleUserId) {
      setError("Select a responsible owner");
      return;
    }

    if (activeForm === "email" && !emailSubject.trim()) {
      setError("Subject is required");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      if (activeForm === "email") {
        const trimmedSubject = emailSubject.trim();
        const emailDetails = [
          `Subject: ${trimmedSubject}`,
          emailFrom.trim() ? `From: ${emailFrom.trim()}` : null,
          emailTo.trim() ? `To: ${emailTo.trim()}` : null,
          emailBody.trim() ? `Notes: ${emailBody.trim()}` : null,
        ].filter(Boolean).join("\n");

        await onSubmit({
          type: "email",
          subject: trimmedSubject,
          body: emailDetails,
          occurredAt: emailOccurredAt ? new Date(emailOccurredAt).toISOString() : undefined,
          responsibleUserId: responsibleUserId || undefined,
          sourceEntityType: selectedTarget?.sourceEntityType,
          sourceEntityId: selectedTarget?.sourceEntityId,
        });
      } else {
        await onSubmit({
          type: activeForm,
          subject: `${activeForm} logged`,
          body: body.trim(),
          outcome: outcome || undefined,
          nextStep: nextStep || undefined,
          nextStepDueAt: nextStepDueAt || undefined,
          durationMinutes: duration ? parseInt(duration, 10) : undefined,
          responsibleUserId: responsibleUserId || undefined,
          sourceEntityType: selectedTarget?.sourceEntityType,
          sourceEntityId: selectedTarget?.sourceEntityId,
        });
      }
      resetForm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to log activity");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Quick-log action buttons */}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={activeForm === "call" ? "default" : "outline"}
          onClick={() => setActiveLogForm("call")}
        >
          <Phone className="h-4 w-4 mr-1" /> Log Call
        </Button>
        <Button
          size="sm"
          variant={activeForm === "note" ? "default" : "outline"}
          onClick={() => setActiveLogForm("note")}
        >
          <FileText className="h-4 w-4 mr-1" /> Add Note
        </Button>
        <Button
          size="sm"
          variant={activeForm === "meeting" ? "default" : "outline"}
          onClick={() => setActiveLogForm("meeting")}
        >
          <Calendar className="h-4 w-4 mr-1" /> Log Meeting
        </Button>
        <Button size="sm" variant={activeForm === "voicemail" ? "default" : "outline"} onClick={() => setActiveLogForm("voicemail")}>
          <PhoneCall className="h-4 w-4 mr-1" /> Voicemail
        </Button>
        <Button size="sm" variant={activeForm === "lunch" ? "default" : "outline"} onClick={() => setActiveLogForm("lunch")}>
          <Handshake className="h-4 w-4 mr-1" /> Lunch
        </Button>
        <Button size="sm" variant={activeForm === "site_visit" ? "default" : "outline"} onClick={() => setActiveLogForm("site_visit")}>
          <MapPinned className="h-4 w-4 mr-1" /> Site Visit
        </Button>
        {showProposalSent ? (
          <Button size="sm" variant={activeForm === "proposal_sent" ? "default" : "outline"} onClick={() => setActiveLogForm("proposal_sent")}>
            <SendHorizontal className="h-4 w-4 mr-1" /> Proposal Sent
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={activeForm === "email" ? "default" : "outline"}
          onClick={() => setActiveLogForm("email")}
          aria-label="Log Email"
        >
          <Mail className="h-4 w-4 mr-1" /> Log Email
        </Button>
      </div>

      {/* Inline log form */}
      {activeForm && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <p className="text-sm font-medium capitalize">{getFormLabel(activeForm)} details</p>
            {(targetOptions.length > 1 || assignees.length > 1) && (
              <div className="grid gap-3 md:grid-cols-2">
                {targetOptions.length > 1 && (
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Target</label>
                    <Select value={target} onValueChange={(value) => setTarget(value ?? "")}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose where to log this" />
                      </SelectTrigger>
                      <SelectContent>
                        {targetOptions.map((option) => (
                          <SelectItem key={encodeTarget(option)} value={encodeTarget(option)}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {assignees.length > 1 && (
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Responsible owner</label>
                    <Select
                      items={assignees.map((assignee) => ({ value: assignee.id, label: assignee.displayName }))}
                      value={responsibleUserId}
                      onValueChange={(value) => setResponsibleUserId(value ?? "")}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Choose owner" />
                      </SelectTrigger>
                      <SelectContent>
                        {assignees.map((assignee) => (
                          <SelectItem key={assignee.id} value={assignee.id}>
                            {assignee.displayName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}
            {activeForm === "email" ? (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block" htmlFor="emailSubject">Subject</label>
                  <Input
                    id="emailSubject"
                    name="emailSubject"
                    value={emailSubject}
                    onChange={(e) => setEmailSubject(e.target.value)}
                    placeholder="Email subject"
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block" htmlFor="emailFrom">From</label>
                    <Input
                      id="emailFrom"
                      name="emailFrom"
                      value={emailFrom}
                      onChange={(e) => setEmailFrom(e.target.value)}
                      placeholder="sender@example.com"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block" htmlFor="emailTo">To</label>
                    <Input
                      id="emailTo"
                      name="emailTo"
                      value={emailTo}
                      onChange={(e) => setEmailTo(e.target.value)}
                      placeholder="recipient@example.com"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block" htmlFor="emailOccurredAt">Date/time</label>
                  <Input
                    id="emailOccurredAt"
                    name="emailOccurredAt"
                    type="datetime-local"
                    value={emailOccurredAt}
                    onChange={(e) => setEmailOccurredAt(e.target.value)}
                  />
                </div>
                <Textarea
                  name="emailBody"
                  placeholder="Email body or notes"
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  rows={4}
                />
              </div>
            ) : (
              <Textarea
                placeholder={`Describe this ${activeForm}...`}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
              />
            )}
            {activeForm === "call" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Outcome</label>
                  <Select
                    items={CALL_OUTCOME_OPTIONS}
                    value={outcome}
                    onValueChange={(v) => setOutcome(v ?? "")}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select outcome" />
                    </SelectTrigger>
                    <SelectContent>
                      {CALL_OUTCOME_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Duration (min)</label>
                  <Input
                    type="number"
                    placeholder="0"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                  />
                </div>
              </div>
            )}
            {activeForm === "meeting" && (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Duration (min)</label>
                <Input
                  type="number"
                  placeholder="0"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  className="w-32"
                />
              </div>
            )}
            {activeForm !== "email" && <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Next Step</label>
                <Input
                  value={nextStep}
                  onChange={(e) => setNextStep(e.target.value)}
                  placeholder="Optional next step"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Next Step Due</label>
                <Input
                  type="date"
                  value={nextStepDueAt}
                  onChange={(e) => setNextStepDueAt(e.target.value)}
                />
              </div>
            </div>}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={submitting || (activeForm !== "email" && !body.trim())}
                data-testid="activity-save"
              >
                <Plus className="h-4 w-4 mr-1" /> {submitting ? "Saving..." : "Save"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={resetForm}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
