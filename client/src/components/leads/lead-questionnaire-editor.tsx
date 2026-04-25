import { useEffect, useMemo, useState } from "react";
import type { LeadRecord } from "@/hooks/use-leads";
import { updateLead } from "@/hooks/use-leads";
import { usePipelineStages, useProjectTypes } from "@/hooks/use-pipeline-config";
import { isApiError } from "@/lib/api";
import { CRM_OWNED_LEAD_STAGE_SLUGS } from "@/lib/sales-workflow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type LeadAnswerValue = string | boolean | number | null;

interface LeadQuestionnaireEditorProps {
  lead: LeadRecord;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}

interface StageGateErrorState {
  message: string;
  missingRequirements?: {
    qualificationFields?: string[];
    projectTypeQuestionIds?: string[];
  };
  currentStage?: {
    name?: string;
  };
  targetStage?: {
    name?: string;
  };
}

function isVisibleQuestion(
  nodeId: string,
  nodeById: Map<string, NonNullable<LeadRecord["leadQuestionnaire"]>["allNodes"][number]>,
  answers: Record<string, LeadAnswerValue>,
  visibleCache: Map<string, boolean>
): boolean {
  const cached = visibleCache.get(nodeId);
  if (cached !== undefined) {
    return cached;
  }

  const node = nodeById.get(nodeId);
  if (!node) {
    visibleCache.set(nodeId, false);
    return false;
  }

  if (!node.parentNodeId) {
    visibleCache.set(nodeId, true);
    return true;
  }

  if (!isVisibleQuestion(node.parentNodeId, nodeById, answers, visibleCache)) {
    visibleCache.set(nodeId, false);
    return false;
  }

  const parent = nodeById.get(node.parentNodeId);
  if (!parent) {
    visibleCache.set(nodeId, false);
    return false;
  }

  const parentAnswer = answers[parent.key];
  const visible =
    node.parentOptionValue != null
      ? String(parentAnswer ?? "") === node.parentOptionValue
      : typeof parentAnswer === "string"
        ? parentAnswer.trim().length > 0
        : Boolean(parentAnswer);

  visibleCache.set(nodeId, visible);
  return visible;
}

function getDepth(
  nodeId: string,
  nodeById: Map<string, NonNullable<LeadRecord["leadQuestionnaire"]>["allNodes"][number]>
) {
  let depth = 0;
  let current = nodeById.get(nodeId);

  while (current?.parentNodeId) {
    depth += 1;
    current = nodeById.get(current.parentNodeId);
  }

  return depth;
}

function getQuestionInputType(node: NonNullable<LeadRecord["leadQuestionnaire"]>["allNodes"][number]) {
  if (node.inputType === "textarea") return "textarea";
  if (node.inputType === "boolean") return "boolean";
  if (node.inputType === "date") return "date";
  if (node.inputType === "currency" || node.inputType === "number") return "number";
  if (Array.isArray(node.options) && node.options.length > 0) return "select";
  return "text";
}

export function LeadQuestionnaireEditor({ lead, onCancel, onSaved }: LeadQuestionnaireEditorProps) {
  const questionnaire = lead.leadQuestionnaire;
  const { stages } = usePipelineStages();
  const { hierarchy: projectTypeHierarchy } = useProjectTypes();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageGateError, setStageGateError] = useState<StageGateErrorState | null>(null);
  const [formData, setFormData] = useState(() => ({
    name: lead.name,
    source: lead.source ?? "",
    description: lead.description ?? "",
    stageId: lead.stageId,
    projectTypeId: lead.projectTypeId ?? "",
    qualificationPayload: {
      existing_customer_status:
        typeof lead.qualificationPayload?.existing_customer_status === "string"
          ? lead.qualificationPayload.existing_customer_status
          : "",
      estimated_value:
        lead.qualificationPayload?.estimated_value == null
          ? ""
          : String(lead.qualificationPayload.estimated_value),
      timeline_status:
        typeof lead.qualificationPayload?.timeline_status === "string"
          ? lead.qualificationPayload.timeline_status
          : "",
    },
    leadQuestionAnswers: { ...(questionnaire?.answers ?? {}) },
  }));

  useEffect(() => {
    setFormData({
      name: lead.name,
      source: lead.source ?? "",
      description: lead.description ?? "",
      stageId: lead.stageId,
      projectTypeId: lead.projectTypeId ?? "",
      qualificationPayload: {
        existing_customer_status:
          typeof lead.qualificationPayload?.existing_customer_status === "string"
            ? lead.qualificationPayload.existing_customer_status
            : "",
        estimated_value:
          lead.qualificationPayload?.estimated_value == null
            ? ""
            : String(lead.qualificationPayload.estimated_value),
        timeline_status:
          typeof lead.qualificationPayload?.timeline_status === "string"
            ? lead.qualificationPayload.timeline_status
            : "",
      },
      leadQuestionAnswers: { ...(lead.leadQuestionnaire?.answers ?? {}) },
    });
    setError(null);
    setStageGateError(null);
  }, [lead]);

  const isConverted = lead.status === "converted" || Boolean(lead.convertedDealId);
  const availableNodes = questionnaire?.allNodes ?? questionnaire?.nodes ?? [];
  const scopedNodes = useMemo(
    () =>
      availableNodes.filter(
        (node) =>
          node.nodeType === "question" &&
          (node.projectTypeId == null || node.projectTypeId === (formData.projectTypeId || null))
      ),
    [availableNodes, formData.projectTypeId]
  );
  const nodeById = useMemo(() => new Map(availableNodes.map((node) => [node.id, node])), [availableNodes]);
  const visibleNodes = useMemo(() => {
    const visibleCache = new Map<string, boolean>();

    return scopedNodes
      .filter((node) => isVisibleQuestion(node.id, nodeById, formData.leadQuestionAnswers, visibleCache))
      .sort((left, right) => left.displayOrder - right.displayOrder);
  }, [formData.leadQuestionAnswers, nodeById, scopedNodes]);
  const editableLeadStages = useMemo(
    () =>
      stages.filter(
        (stage) =>
          CRM_OWNED_LEAD_STAGE_SLUGS.includes(stage.slug as (typeof CRM_OWNED_LEAD_STAGE_SLUGS)[number]) &&
          !stage.isTerminal
      ),
    [stages]
  );

  if (!questionnaire) {
    return null;
  }

  const handleAnswerChange = (key: string, value: LeadAnswerValue) => {
    setFormData((current) => ({
      ...current,
      leadQuestionAnswers: {
        ...current.leadQuestionAnswers,
        [key]: value,
      },
    }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setStageGateError(null);

    try {
      const leadQuestionAnswers = Object.fromEntries(
        scopedNodes.map((node) => [node.key, formData.leadQuestionAnswers[node.key] ?? null])
      );

      const payload = isConverted
        ? { leadQuestionAnswers }
        : {
            name: formData.name.trim(),
            source: formData.source.trim() || null,
            description: formData.description.trim() || null,
            stageId: formData.stageId,
            projectTypeId: formData.projectTypeId || null,
            qualificationPayload: {
              existing_customer_status: formData.qualificationPayload.existing_customer_status.trim() || null,
              estimated_value:
                formData.qualificationPayload.estimated_value.trim() === ""
                  ? null
                  : Number(formData.qualificationPayload.estimated_value),
              timeline_status: formData.qualificationPayload.timeline_status.trim() || null,
            },
            leadQuestionAnswers,
          };

      await updateLead(lead.id, payload);
      await onSaved();
    } catch (err: unknown) {
      if (isApiError(err) && err.code === "LEAD_STAGE_REQUIREMENTS_UNMET") {
        setStageGateError({
          message: err.message,
          missingRequirements: err.missingRequirements as StageGateErrorState["missingRequirements"],
          currentStage: err.currentStage as StageGateErrorState["currentStage"],
          targetStage: err.targetStage as StageGateErrorState["targetStage"],
        });
        return;
      }

      setError(err instanceof Error ? err.message : "Failed to save lead");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{isConverted ? "Edit Lead Questionnaire" : "Edit Lead"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {stageGateError && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              <p className="font-medium">{stageGateError.message}</p>
              {stageGateError.currentStage?.name && stageGateError.targetStage?.name && (
                <p className="mt-1 text-xs text-amber-800">
                  {stageGateError.currentStage.name} → {stageGateError.targetStage.name}
                </p>
              )}
            </div>
          )}

          {!isConverted && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="lead-name">Lead Name</Label>
                  <Input
                    id="lead-name"
                    value={formData.name}
                    onChange={(event) => setFormData((current) => ({ ...current, name: event.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lead-stage">Stage</Label>
                  <Select
                    value={formData.stageId}
                    onValueChange={(value) =>
                      setFormData((current) => ({ ...current, stageId: value ?? current.stageId }))
                    }
                  >
                    <SelectTrigger id="lead-stage">
                      <SelectValue placeholder="Select stage" />
                    </SelectTrigger>
                    <SelectContent>
                      {editableLeadStages.map((stage) => (
                        <SelectItem key={stage.id} value={stage.id}>
                          {stage.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="lead-source">Source</Label>
                  <Input
                    id="lead-source"
                    value={formData.source}
                    onChange={(event) => setFormData((current) => ({ ...current, source: event.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lead-project-type">Project Type</Label>
                  <Select
                    value={formData.projectTypeId || "__none__"}
                    onValueChange={(value) =>
                      setFormData((current) => ({
                        ...current,
                        projectTypeId: !value || value === "__none__" ? "" : value,
                      }))
                    }
                  >
                    <SelectTrigger id="lead-project-type">
                      <SelectValue placeholder="Select project type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Select project type</SelectItem>
                      {projectTypeHierarchy.flatMap((parent: (typeof projectTypeHierarchy)[number]) => [
                        <SelectItem key={parent.id} value={parent.id} className="font-medium">
                          {parent.name}
                        </SelectItem>,
                        ...parent.children.map((child: (typeof parent.children)[number]) => (
                          <SelectItem key={child.id} value={child.id} className="pl-6">
                            {child.name}
                          </SelectItem>
                        )),
                      ])}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="lead-description">Description</Label>
                <textarea
                  id="lead-description"
                  className="flex min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={formData.description}
                  onChange={(event) => setFormData((current) => ({ ...current, description: event.target.value }))}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="existing-customer-status">Existing Customer Status</Label>
                  <Input
                    id="existing-customer-status"
                    value={formData.qualificationPayload.existing_customer_status}
                    onChange={(event) =>
                      setFormData((current) => ({
                        ...current,
                        qualificationPayload: {
                          ...current.qualificationPayload,
                          existing_customer_status: event.target.value,
                        },
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="estimated-value">Estimated Value</Label>
                  <Input
                    id="estimated-value"
                    type="number"
                    value={formData.qualificationPayload.estimated_value}
                    onChange={(event) =>
                      setFormData((current) => ({
                        ...current,
                        qualificationPayload: {
                          ...current.qualificationPayload,
                          estimated_value: event.target.value,
                        },
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timeline-status">Timeline</Label>
                  <Input
                    id="timeline-status"
                    value={formData.qualificationPayload.timeline_status}
                    onChange={(event) =>
                      setFormData((current) => ({
                        ...current,
                        qualificationPayload: {
                          ...current.qualificationPayload,
                          timeline_status: event.target.value,
                        },
                      }))
                    }
                  />
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Project Questions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {visibleNodes.map((node) => {
            const inputType = getQuestionInputType(node);
            const currentValue = formData.leadQuestionAnswers[node.key];
            const depth = getDepth(node.id, nodeById);
            const options = Array.isArray(node.options) ? node.options.filter((option) => typeof option === "string") as string[] : [];

            return (
              <div key={node.id} className="space-y-2 rounded-md border p-3" style={{ marginLeft: depth * 16 }}>
                <Label htmlFor={node.key}>
                  {node.label}
                  {node.isRequired ? " *" : ""}
                </Label>
                {node.prompt && <p className="text-sm text-muted-foreground">{node.prompt}</p>}
                {inputType === "textarea" ? (
                  <textarea
                    id={node.key}
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={typeof currentValue === "string" ? currentValue : ""}
                    onChange={(event) => handleAnswerChange(node.key, event.target.value)}
                  />
                ) : inputType === "boolean" ? (
                  <Select
                    value={typeof currentValue === "boolean" ? String(currentValue) : "__unanswered__"}
                    onValueChange={(value) =>
                      handleAnswerChange(
                        node.key,
                        !value || value === "__unanswered__" ? null : value === "true"
                      )
                    }
                  >
                    <SelectTrigger id={node.key}>
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__unanswered__">Unanswered</SelectItem>
                      <SelectItem value="true">Yes</SelectItem>
                      <SelectItem value="false">No</SelectItem>
                    </SelectContent>
                  </Select>
                ) : inputType === "select" ? (
                  <Select
                    value={typeof currentValue === "string" ? currentValue : "__unanswered__"}
                    onValueChange={(value) =>
                      handleAnswerChange(node.key, !value || value === "__unanswered__" ? null : value)
                    }
                  >
                    <SelectTrigger id={node.key}>
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__unanswered__">Unanswered</SelectItem>
                      {options.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={node.key}
                    type={inputType === "date" ? "date" : inputType === "number" ? "number" : "text"}
                    value={
                      typeof currentValue === "number"
                        ? String(currentValue)
                        : typeof currentValue === "string"
                          ? currentValue
                          : ""
                    }
                    onChange={(event) =>
                      handleAnswerChange(
                        node.key,
                        inputType === "number"
                          ? event.target.value.trim() === ""
                            ? null
                            : Number(event.target.value)
                          : event.target.value
                      )
                    }
                  />
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving..." : "Save Changes"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
