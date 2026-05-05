import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { LEAD_SOURCE_CATEGORIES, type LeadSourceCategory } from "@trock-crm/shared/types";
import type { LeadAnswerValue, LeadQuestionnaireNode, LeadRecord } from "@/hooks/use-leads";
import { transitionLeadStage, updateLead } from "@/hooks/use-leads";
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
import {
  normalizeQuestionOptions,
  questionnaireRevealMatches,
} from "./questionnaire-display";

interface LeadQuestionnaireEditorProps {
  lead: LeadRecord;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}

interface StageGateErrorState {
  message: string;
  missingLabels?: string[];
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

function formatLeadStageBlockReason(reason?: string) {
  if (reason === "LEAD_DD_PENDING") {
    return "Awaiting Due Diligence approval. The lead will be eligible for qualification once the DD review is complete.";
  }
  if (reason === "LEAD_DD_REJECTED") {
    return "Due Diligence rejected. This lead cannot be qualified. Contact a director or move the lead to disqualified.";
  }
  if (reason === "LEAD_NO_SCOPE_SELECTED") {
    return "Select at least one applicable scope accordion and complete its required questions.";
  }
  return "This lead cannot move to the selected stage yet.";
}

function isVisibleQuestion(
  nodeId: string,
  nodeById: Map<string, LeadQuestionnaireNode>,
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
  const visible = questionnaireRevealMatches(parentAnswer, node.parentOptionValue);

  visibleCache.set(nodeId, visible);
  return visible;
}

function getQuestionInputType(node: LeadQuestionnaireNode) {
  if (node.inputType === "textarea") return "textarea";
  if (node.inputType === "boolean") return "boolean";
  if (node.inputType === "date") return "date";
  if (node.inputType === "multiselect") return "multiselect";
  if (node.inputType === "currency" || node.inputType === "number") return "number";
  if (Array.isArray(node.options) && node.options.length > 0) return "select";
  return "text";
}

function QuestionLabel({
  htmlFor,
  children,
  required = false,
}: {
  htmlFor: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <Label htmlFor={htmlFor}>
      {children}
      {required ? (
        <span className="text-red-600" aria-hidden="true">
          {" "}
          *
        </span>
      ) : null}
    </Label>
  );
}

function getInitialSourceState(lead: LeadRecord) {
  if (lead.sourceCategory) {
    return {
      sourceCategory: lead.sourceCategory,
      sourceDetail: lead.sourceDetail ?? "",
    };
  }

  const source = lead.source?.trim() ?? "";
  const strictMatch = LEAD_SOURCE_CATEGORIES.find(
    (category) => category.toLowerCase() === source.toLowerCase()
  );

  return {
    sourceCategory: strictMatch ?? (source ? "Other" : ""),
    sourceDetail: strictMatch ? "" : source,
  };
}

export function LeadQuestionnaireEditor({ lead, onCancel, onSaved }: LeadQuestionnaireEditorProps) {
  const questionnaire = lead.leadQuestionnaire;
  const { stages } = usePipelineStages();
  const { projectTypes, hierarchy: projectTypeHierarchy } = useProjectTypes();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageGateError, setStageGateError] = useState<StageGateErrorState | null>(null);
  const [openScopeGroups, setOpenScopeGroups] = useState<Record<string, boolean>>({});
  const initialSourceState = getInitialSourceState(lead);
  const [formData, setFormData] = useState(() => ({
    name: lead.name,
    source: lead.source ?? "",
    sourceCategory: initialSourceState.sourceCategory,
    sourceDetail: initialSourceState.sourceDetail,
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
    const nextSourceState = getInitialSourceState(lead);
    setFormData({
      name: lead.name,
      source: lead.source ?? "",
      sourceCategory: nextSourceState.sourceCategory,
      sourceDetail: nextSourceState.sourceDetail,
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
  const availableNodes = useMemo(() => {
    if (questionnaire) {
      return questionnaire.nodes.length > 0 ? questionnaire.nodes : questionnaire.allNodes;
    }

    return [];
  }, [questionnaire]);
  const scopedNodes = useMemo(
    () => availableNodes.filter((node) => node.nodeType === "question"),
    [availableNodes]
  );
  const nodeById = useMemo(() => new Map(availableNodes.map((node) => [node.id, node])), [availableNodes]);
  const gateQuestionLabels = useMemo(
    () =>
      new Map(
        availableNodes
          .filter((node) => node.nodeType === "question")
          .flatMap((node) => [
            [node.key, node.label] as const,
            [node.id, node.label] as const,
          ])
      ),
    [availableNodes]
  );
  const visibleNodes = useMemo(() => {
    const visibleCache = new Map<string, boolean>();

    return scopedNodes
      .filter((node) => isVisibleQuestion(node.id, nodeById, formData.leadQuestionAnswers, visibleCache))
      .sort((left, right) => left.displayOrder - right.displayOrder);
  }, [formData.leadQuestionAnswers, nodeById, scopedNodes]);
  const baselineNodes = useMemo(
    () => visibleNodes.filter((node) => (node.sectionKey ?? "baseline") === "baseline"),
    [visibleNodes]
  );
  const propertyNodes = useMemo(
    () => visibleNodes.filter((node) => node.sectionKey === "property"),
    [visibleNodes]
  );
  const scopeGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        label: string;
        order: number;
        nodes: LeadQuestionnaireNode[];
        appliesNode: LeadQuestionnaireNode | null;
      }
    >();

    for (const node of scopedNodes.filter((entry) => entry.sectionKey === "scope" && entry.groupKey)) {
      const groupKey = node.groupKey!;
      const current = groups.get(groupKey) ?? {
        key: groupKey,
        label: node.groupLabel ?? groupKey,
        order: node.groupOrder ?? 0,
        nodes: [],
        appliesNode: null,
      };
      current.nodes.push(node);
      if (!node.parentNodeId && (node.key.endsWith("_applies") || node.displayOrder === 0)) {
        current.appliesNode = node;
      }
      groups.set(groupKey, current);
    }

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        nodes: group.nodes.sort((left, right) => left.displayOrder - right.displayOrder),
      }))
      .sort((left, right) => left.order - right.order);
  }, [scopedNodes]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const editableLeadStages = useMemo(
    () =>
      stages.filter(
        (stage) =>
          CRM_OWNED_LEAD_STAGE_SLUGS.includes(stage.slug as (typeof CRM_OWNED_LEAD_STAGE_SLUGS)[number]) &&
          !stage.isTerminal
      ),
    [stages]
  );
  const selectedStageLabel =
    editableLeadStages.find((stage) => stage.id === formData.stageId)?.name ?? "Select stage";
  const selectedProjectTypeLabel =
    projectTypes.find((entry) => entry.id === formData.projectTypeId)?.name ??
    projectTypeHierarchy
      .flatMap((parent) => [parent, ...parent.children])
      .find((entry) => entry.id === formData.projectTypeId)?.name ??
    lead.projectType?.name ??
    "Select project type";

  useEffect(() => {
    setOpenScopeGroups((current) => {
      let changed = false;
      const next = { ...current };

      for (const group of scopeGroups) {
        const appliesAnswered = group.appliesNode
          ? formData.leadQuestionAnswers[group.appliesNode.key] === true
          : false;
        const childAnswered = group.nodes
          .filter((node) => node.id !== group.appliesNode?.id)
          .some((node) => formData.leadQuestionAnswers[node.key] != null);

        if ((appliesAnswered || childAnswered) && !next[group.key]) {
          next[group.key] = true;
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [formData.leadQuestionAnswers, scopeGroups]);

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

  const toggleMultiselectAnswer = (key: string, optionValue: string, checked: boolean) => {
    const currentValue = formData.leadQuestionAnswers[key];
    const currentValues = Array.isArray(currentValue) ? currentValue : [];
    const nextValues = checked
      ? Array.from(new Set([...currentValues, optionValue]))
      : currentValues.filter((value) => value !== optionValue);
    handleAnswerChange(key, nextValues);
  };

  const handleSourceCategoryChange = (value: string | null) => {
    setFormData((current) => ({
      ...current,
      sourceCategory: !value || value === "__none__" ? "" : value,
      sourceDetail: value === "Other" ? current.sourceDetail : "",
    }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setStageGateError(null);

    if (!isConverted) {
      if (!formData.sourceCategory) {
        setSubmitting(false);
        setError("Source is required.");
        return;
      }
      if (formData.sourceCategory === "Other" && !formData.sourceDetail.trim()) {
        setSubmitting(false);
        setError("Source detail is required when Source is Other.");
        return;
      }
    }

    try {
      const leadQuestionAnswers = Object.fromEntries(
        scopedNodes.map((node) => [node.key, formData.leadQuestionAnswers[node.key] ?? null])
      );

      if (!isConverted && formData.stageId !== lead.stageId) {
        const transitionResult = await transitionLeadStage(lead.id, { targetStageId: formData.stageId });
        if (!transitionResult.ok) {
          setStageGateError({
            message: formatLeadStageBlockReason(transitionResult.code),
            missingLabels: transitionResult.missing.map((field) => field.label),
          });
          return;
        }
      }

      const payload = isConverted
        ? { leadQuestionAnswers }
        : {
            name: formData.name.trim(),
            sourceCategory: formData.sourceCategory as LeadSourceCategory,
            sourceDetail: formData.sourceDetail.trim() || null,
            description: formData.description.trim() || null,
            projectTypeId: formData.projectTypeId || null,
            qualificationPayload: {
              existing_customer_status: null,
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

  const renderQuestion = (node: LeadQuestionnaireNode, options?: { nested?: boolean }) => {
    const inputType = getQuestionInputType(node);
    const currentValue = formData.leadQuestionAnswers[node.key];
    const questionOptions = normalizeQuestionOptions(node.options);

    return (
      <div key={node.id} className={`space-y-2 rounded-md border p-3 ${options?.nested ? "bg-muted/20" : ""}`}>
        <QuestionLabel htmlFor={node.key} required={node.isRequired}>
          {node.label}
        </QuestionLabel>
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
              {questionOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : inputType === "multiselect" ? (
          <div className="grid gap-2 rounded-md border bg-background p-3 sm:grid-cols-2">
            {questionOptions.map((option) => {
              const selected = Array.isArray(currentValue) && currentValue.includes(option.value);
              return (
                <label key={option.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input"
                    checked={selected}
                    onChange={(event) => toggleMultiselectAnswer(node.key, option.value, event.target.checked)}
                  />
                  <span>{option.label}</span>
                </label>
              );
            })}
          </div>
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
              {stageGateError.missingRequirements?.qualificationFields?.length ? (
                <p className="mt-2 text-xs text-amber-800">
                  Missing qualification fields:{" "}
                  {stageGateError.missingRequirements.qualificationFields.join(", ")}
                </p>
              ) : null}
              {stageGateError.missingRequirements?.projectTypeQuestionIds?.length ? (
                <p className="mt-1 text-xs text-amber-800">
                  Missing required project questions:{" "}
                  {stageGateError.missingRequirements.projectTypeQuestionIds
                    .map((questionId) => gateQuestionLabels.get(questionId) ?? questionId)
                    .join(", ")}
                </p>
              ) : null}
              {stageGateError.missingLabels?.length ? (
                <p className="mt-2 text-xs text-amber-800">
                  Missing requirements: {stageGateError.missingLabels.join(", ")}
                </p>
              ) : null}
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
                      <SelectValue>{selectedStageLabel}</SelectValue>
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
                  <QuestionLabel htmlFor="lead-source" required>
                    Source
                  </QuestionLabel>
                  <Select
                    value={formData.sourceCategory || "__none__"}
                    onValueChange={handleSourceCategoryChange}
                  >
                    <SelectTrigger id="lead-source">
                      <SelectValue placeholder="Select source" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Select source</SelectItem>
                      {LEAD_SOURCE_CATEGORIES.map((category) => (
                        <SelectItem key={category} value={category}>
                          {category}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                      <SelectValue>{selectedProjectTypeLabel}</SelectValue>
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
              {formData.sourceCategory === "Other" ? (
                <div className="space-y-2">
                  <QuestionLabel htmlFor="lead-source-detail" required>
                    Source detail
                  </QuestionLabel>
                  <Input
                    id="lead-source-detail"
                    required
                    value={formData.sourceDetail}
                    onChange={(event) =>
                      setFormData((current) => ({ ...current, sourceDetail: event.target.value }))
                    }
                  />
                </div>
              ) : null}

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
                  <Label>Existing Customer Status</Label>
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm font-medium">
                    {lead.existingCustomerStatus ?? "Computed on save"}
                  </div>
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
          {baselineNodes.map((node) => renderQuestion(node))}

          {propertyNodes.length > 0 ? (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Property/Building Info</h3>
              {propertyNodes.map((node) => renderQuestion(node))}
            </section>
          ) : null}

          {scopeGroups.length > 0 ? (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Scope</h3>
              {scopeGroups.map((group) => {
                const isOpen = openScopeGroups[group.key] ?? false;
                const applies = group.appliesNode
                  ? formData.leadQuestionAnswers[group.appliesNode.key] === true
                  : false;
                const visibleGroupNodes = group.nodes.filter((node) => visibleNodeIds.has(node.id));

                return (
                  <div key={group.key} className="rounded-md border">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                      onClick={() =>
                        setOpenScopeGroups((current) => ({ ...current, [group.key]: !isOpen }))
                      }
                    >
                      <span className="font-medium">{group.label}</span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs ${
                          applies
                            ? "border-green-200 bg-green-50 text-green-700"
                            : "border-muted bg-muted/50 text-muted-foreground"
                        }`}
                      >
                        {applies ? "Applies" : "Not selected"}
                      </span>
                    </button>
                    {isOpen ? (
                      <div className="space-y-3 border-t p-4">
                        {visibleGroupNodes.map((node) =>
                          renderQuestion(node, { nested: node.id !== group.appliesNode?.id })
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ) : null}

          {questionnaire.legacyAnswers?.length ? (
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">Legacy / Archived Answers</summary>
              <div className="mt-3 space-y-2">
                {questionnaire.legacyAnswers.map((answer) => (
                  <div key={answer.questionId} className="rounded-md border bg-muted/20 p-3 text-sm">
                    <p className="font-medium">{answer.label}</p>
                    <p className="text-muted-foreground">
                      {Array.isArray(answer.value) ? answer.value.join(", ") : String(answer.value ?? "Unanswered")}
                    </p>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
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
