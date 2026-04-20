import { useEffect, useState } from "react";
import { Phone, FileText, Calendar, Plus, Handshake, MapPinned, PhoneCall, SendHorizontal } from "lucide-react";
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
    responsibleUserId?: string;
    sourceEntityType?: ActivitySourceEntityType;
    sourceEntityId?: string;
  }) => Promise<void>;
  targetOptions?: ActivityTargetOption[];
  defaultResponsibleUserId?: string;
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

export function ActivityLogForm({
  onSubmit,
  targetOptions = [],
  defaultResponsibleUserId,
}: ActivityLogFormProps) {
  const { user } = useAuth();
  const [activeForm, setActiveForm] = useState<LogType | null>(null);
  const [body, setBody] = useState("");
  const [outcome, setOutcome] = useState<string>("");
  const [duration, setDuration] = useState<string>("");
  const [nextStep, setNextStep] = useState("");
  const [nextStepDueAt, setNextStepDueAt] = useState("");
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

  const handleSubmit = async () => {
    if (!body.trim() || !activeForm) return;

    const selectedTarget = decodeTarget(target);

    if (targetOptions.length > 0 && !selectedTarget) {
      setError("Select a target entity");
      return;
    }

    if (assignees.length > 0 && !responsibleUserId) {
      setError("Select a responsible owner");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
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
      setBody("");
      setOutcome("");
      setDuration("");
      setNextStep("");
      setNextStepDueAt("");
      setActiveForm(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to log activity");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Quick-log action buttons */}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={activeForm === "call" ? "default" : "outline"}
          onClick={() => setActiveForm(activeForm === "call" ? null : "call")}
        >
          <Phone className="h-4 w-4 mr-1" /> Log Call
        </Button>
        <Button
          size="sm"
          variant={activeForm === "note" ? "default" : "outline"}
          onClick={() => setActiveForm(activeForm === "note" ? null : "note")}
        >
          <FileText className="h-4 w-4 mr-1" /> Add Note
        </Button>
        <Button
          size="sm"
          variant={activeForm === "meeting" ? "default" : "outline"}
          onClick={() => setActiveForm(activeForm === "meeting" ? null : "meeting")}
        >
          <Calendar className="h-4 w-4 mr-1" /> Log Meeting
        </Button>
        <Button size="sm" variant={activeForm === "voicemail" ? "default" : "outline"} onClick={() => setActiveForm(activeForm === "voicemail" ? null : "voicemail")}>
          <PhoneCall className="h-4 w-4 mr-1" /> Voicemail
        </Button>
        <Button size="sm" variant={activeForm === "lunch" ? "default" : "outline"} onClick={() => setActiveForm(activeForm === "lunch" ? null : "lunch")}>
          <Handshake className="h-4 w-4 mr-1" /> Lunch
        </Button>
        <Button size="sm" variant={activeForm === "site_visit" ? "default" : "outline"} onClick={() => setActiveForm(activeForm === "site_visit" ? null : "site_visit")}>
          <MapPinned className="h-4 w-4 mr-1" /> Site Visit
        </Button>
        <Button size="sm" variant={activeForm === "proposal_sent" ? "default" : "outline"} onClick={() => setActiveForm(activeForm === "proposal_sent" ? null : "proposal_sent")}>
          <SendHorizontal className="h-4 w-4 mr-1" /> Proposal Sent
        </Button>
      </div>

      {/* Inline log form */}
      {activeForm && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <p className="text-sm font-medium capitalize">{activeForm} details</p>
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
                    <Select value={responsibleUserId} onValueChange={(value) => setResponsibleUserId(value ?? "")}>
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
            <Textarea
              placeholder={`Describe this ${activeForm}...`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
            />
            {activeForm === "call" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Outcome</label>
                  <Select value={outcome} onValueChange={(v) => setOutcome(v ?? "")}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select outcome" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="connected">Connected</SelectItem>
                      <SelectItem value="left_voicemail">Left Voicemail</SelectItem>
                      <SelectItem value="no_answer">No Answer</SelectItem>
                      <SelectItem value="scheduled_meeting">Scheduled Meeting</SelectItem>
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
            <div className="grid gap-3 md:grid-cols-2">
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
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSubmit} disabled={submitting || !body.trim()}>
                <Plus className="h-4 w-4 mr-1" /> {submitting ? "Saving..." : "Save"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setActiveForm(null);
                  setBody("");
                  setOutcome("");
                  setDuration("");
                  setNextStep("");
                  setNextStepDueAt("");
                  setError(null);
                }}
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
