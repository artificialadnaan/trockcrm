import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { LeadQualificationFieldId } from "@trock-crm/shared/types";
import {
  getLeadValidationQuestionSetForProjectType,
  LEAD_SOURCE_CATEGORIES,
  type LeadSourceCategory,
  LEAD_QUALIFICATION_FIELDS,
} from "@trock-crm/shared/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CompanySelector } from "@/components/companies/company-selector";
import { PropertySelector } from "@/components/properties/property-selector";
import { LeadStageBadge } from "./lead-stage-badge";
import { useCompanyContacts } from "@/hooks/use-companies";
import {
  createLead,
  updateLead,
  useLeadQuestionnaireTemplate,
  type LeadQuestionnaireSnapshot,
} from "@/hooks/use-leads";
import { usePipelineStages, useProjectTypes } from "@/hooks/use-pipeline-config";
import { formatPropertyLabel, useProperties } from "@/hooks/use-properties";
import { isApiError } from "@/lib/api";
import { getValidationQuestionSetForProjectType } from "@/lib/validation-question-sets";
import {
  getLeadCreationStages,
  getNormalizedLeadCreationStageId,
} from "@/pages/leads/lead-new-page.helpers";
import {
  formatQuestionAnswerValue,
  normalizeQuestionOptions,
  questionnaireRevealMatches,
} from "./questionnaire-display";

type LeadAnswerValue = string | boolean | number | null;

export interface LeadFormLead {
  id: string;
  name: string;
  convertedDealId: string | null;
  convertedDealNumber: string | null;
  companyId: string | null;
  companyName: string | null;
  stageId: string;
  propertyId: string | null;
  propertyName: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  source: string | null;
  sourceCategory?: LeadSourceCategory | null;
  sourceDetail?: string | null;
  existingCustomerStatus?: "Existing" | "New" | null;
  description: string | null;
  projectTypeId?: string | null;
  projectType?: {
    id: string;
    name: string;
    slug: string;
  } | null;
  qualificationPayload?: Record<string, LeadAnswerValue>;
  projectTypeQuestionPayload?: {
    projectTypeId: string | null;
    answers: Record<string, LeadAnswerValue>;
  };
  leadQuestionnaire?: LeadQuestionnaireSnapshot | null;
  stageEnteredAt: string;
}

type LeadSummaryFormProps = {
  mode?: "summary";
  lead: LeadFormLead;
  converted?: boolean;
  showPrimaryAction?: boolean;
  onSaved?: () => void;
};

type LeadCreateFormProps = {
  mode: "create";
  initialValues?: Partial<{
    companyId: string;
    propertyId: string;
    primaryContactId: string;
    name: string;
    source: string;
    description: string;
    projectTypeId: string;
    stageId: string;
  }>;
};

type LeadUpdateFormProps = {
  mode: "edit";
  lead: LeadFormLead;
  onSaved?: () => void;
};

type LeadFormProps = LeadSummaryFormProps | LeadCreateFormProps | LeadUpdateFormProps;

type LeadEditableMode = "create" | "edit";

interface LeadStageGateErrorState {
  message: string;
  code?: string;
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

const LEAD_QUALIFICATION_FIELD_LABELS = new Map(
  LEAD_QUALIFICATION_FIELDS.map((field) => [field.id, field.label])
);
const EDITABLE_QUALIFICATION_FIELDS = LEAD_QUALIFICATION_FIELDS.filter(
  (field) => field.id !== "existing_customer_status"
);

function normalizeLeadSourceForForm(lead?: LeadFormLead, initialSource?: string) {
  const category = lead?.sourceCategory ?? null;
  if (category) {
    return {
      sourceCategory: category,
      sourceDetail: lead?.sourceDetail ?? "",
    };
  }

  const source = lead?.source ?? initialSource ?? "";
  const strictMatch = LEAD_SOURCE_CATEGORIES.find(
    (item) => item.toLowerCase() === source.trim().toLowerCase()
  );

  if (strictMatch) {
    return {
      sourceCategory: strictMatch,
      sourceDetail: "",
    };
  }

  return {
    sourceCategory: source.trim() ? "Other" : "",
    sourceDetail: source.trim(),
  };
}

function getEditableFormState(
  lead?: LeadFormLead,
  initialValues?: LeadCreateFormProps["initialValues"]
) {
  const sourceState = normalizeLeadSourceForForm(lead, initialValues?.source);

  return {
    companyId: lead?.companyId ?? initialValues?.companyId ?? "",
    propertyId: lead?.propertyId ?? initialValues?.propertyId ?? "",
    primaryContactId: initialValues?.primaryContactId ?? "",
    name: lead?.name ?? initialValues?.name ?? "",
    stageId: lead?.stageId ?? initialValues?.stageId ?? "",
    source: lead?.source ?? initialValues?.source ?? "",
    sourceCategory: sourceState.sourceCategory,
    sourceDetail: sourceState.sourceDetail,
    description: lead?.description ?? initialValues?.description ?? "",
    projectTypeId: lead?.projectTypeId ?? initialValues?.projectTypeId ?? "",
    qualificationPayload: {
      existing_customer_status:
        typeof lead?.qualificationPayload?.existing_customer_status === "string"
          ? lead.qualificationPayload.existing_customer_status
          : "",
      estimated_value:
        lead?.qualificationPayload?.estimated_value == null
          ? ""
          : String(lead.qualificationPayload.estimated_value),
      timeline_status:
        typeof lead?.qualificationPayload?.timeline_status === "string"
          ? lead.qualificationPayload.timeline_status
          : "",
    } as Record<string, string>,
    projectTypeQuestionAnswers: {
      ...(lead?.leadQuestionnaire?.answers ?? lead?.projectTypeQuestionPayload?.answers ?? {}),
    } as Record<string, LeadAnswerValue>,
  };
}

function renderAnswerValue(value: LeadAnswerValue | undefined) {
  const formatted = formatQuestionAnswerValue(value);
  return formatted === "Unanswered" ? "--" : formatted;
}

function isVisibleQuestionNode(
  nodeId: string,
  nodeById: Map<string, LeadQuestionnaireSnapshot["allNodes"][number]>,
  answers: Record<string, LeadAnswerValue>,
  visibleCache: Map<string, boolean>
) {
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

  if (!isVisibleQuestionNode(node.parentNodeId, nodeById, answers, visibleCache)) {
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

function getQuestionInputType(node: LeadQuestionnaireSnapshot["allNodes"][number]) {
  if (node.inputType === "textarea") return "textarea";
  if (node.inputType === "boolean") return "boolean";
  if (node.inputType === "date") return "date";
  if (node.inputType === "currency" || node.inputType === "number") return "number";
  if (Array.isArray(node.options) && node.options.length > 0) return "select";
  return "text";
}

function isAnsweredQuestionValue(value: LeadAnswerValue | undefined) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
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

function SummaryLeadForm({
  lead,
  converted = false,
  showPrimaryAction = true,
}: LeadSummaryFormProps) {
  const navigate = useNavigate();
  const { projectTypes } = useProjectTypes();
  const propertyLabel =
    [lead.propertyAddress, [lead.propertyCity, lead.propertyState].filter(Boolean).join(", "), lead.propertyZip]
      .filter(Boolean)
      .join(" ") || lead.propertyName || "--";
  const projectType =
    lead.projectType ?? projectTypes.find((entry) => entry.id === lead.projectTypeId) ?? null;
  const displaySource =
    lead.sourceCategory === "Other"
      ? lead.sourceDetail || lead.source || "Other"
      : lead.sourceCategory ?? lead.source ?? "--";

  return (
    <Card className="overflow-hidden border-slate-200 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-[11px] font-black tracking-[0.16em] text-slate-500 uppercase">
            Lead Summary
          </CardTitle>
          <LeadStageBadge stageId={lead.stageId} converted={converted} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-muted-foreground">Lead Name</p>
            <p className="font-medium">{lead.name}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Lead Record</p>
            <p className="font-mono font-medium">{lead.convertedDealNumber ?? lead.id.slice(0, 8)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Company</p>
            <p className="font-medium">{lead.companyName ?? "Unassigned"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Project Type</p>
            <p className="font-medium">{projectType?.name ?? "--"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Source</p>
            <p className="font-medium">{displaySource}</p>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-[#f7f8fb] p-3 text-sm">
          <p className="text-[11px] font-black tracking-[0.16em] text-slate-500 uppercase">Property</p>
          {lead.propertyId ? (
            <Link to={`/properties/${lead.propertyId}`} className="font-medium text-primary hover:underline">
              {propertyLabel || "--"}
            </Link>
          ) : (
            <p className="font-medium">{propertyLabel || "--"}</p>
          )}
        </div>

        {lead.description ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{lead.description}</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {showPrimaryAction ? (
            <Button
              disabled={converted && !lead.convertedDealId}
              onClick={() => navigate(converted ? `/deals/${lead.convertedDealId}` : "/deals/new")}
            >
              {converted ? "Open Deal" : "Convert to Deal"}
            </Button>
          ) : null}
          {lead.companyId ? (
            <Button variant="outline" onClick={() => navigate(`/companies/${lead.companyId}`)}>
              View Company
            </Button>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">
          This lead surface is backed by the pre-RFP lead record and preserves its activity history through conversion.
        </p>
      </CardContent>
    </Card>
  );
}

export function LeadQuestionnaireSummary({ lead }: { lead: LeadFormLead }) {
  const { projectTypes } = useProjectTypes();
  const projectType =
    lead.projectType ?? projectTypes.find((entry) => entry.id === lead.projectTypeId) ?? null;
  const questionSet = getValidationQuestionSetForProjectType(projectType?.slug ?? null);
  const questionnaireNodes = useMemo(
    () =>
      lead.leadQuestionnaire
        ? lead.leadQuestionnaire.nodes.length > 0
          ? lead.leadQuestionnaire.nodes
          : lead.leadQuestionnaire.allNodes
        : [],
    [lead.leadQuestionnaire]
  );
  const questionnaireNodeById = useMemo(
    () => new Map(questionnaireNodes.map((node) => [node.id, node])),
    [questionnaireNodes]
  );
  const visibleQuestionnaireNodes = useMemo(() => {
    const visibleCache = new Map<string, boolean>();

    return questionnaireNodes
      .filter((node) => node.nodeType === "question")
      .filter((node) =>
        isVisibleQuestionNode(node.id, questionnaireNodeById, lead.leadQuestionnaire?.answers ?? {}, visibleCache)
      )
      .sort((left, right) => left.displayOrder - right.displayOrder);
  }, [lead.leadQuestionnaire?.answers, questionnaireNodeById, questionnaireNodes]);
  const showV2SummaryQuestions = visibleQuestionnaireNodes.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Project Questions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-muted-foreground">Existing Customer Status</p>
            <p className="font-medium">
              {lead.existingCustomerStatus ?? renderAnswerValue(lead.qualificationPayload?.existing_customer_status)}
            </p>
          </div>
          {EDITABLE_QUALIFICATION_FIELDS.map((field: { id: LeadQualificationFieldId; label: string }) => (
            <div key={field.id}>
              <p className="text-muted-foreground">{field.label}</p>
              <p className="font-medium">{renderAnswerValue(lead.qualificationPayload?.[field.id])}</p>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {showV2SummaryQuestions ? "Project Questions" : questionSet.title}
          </p>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            {showV2SummaryQuestions
              ? visibleQuestionnaireNodes.map((node) => (
                  <div key={node.id} className="rounded-md border p-3 transition-all duration-150">
                    <p className="text-muted-foreground">{node.label}</p>
                    <p className="font-medium">
                      {renderAnswerValue(lead.leadQuestionnaire?.answers?.[node.key])}
                    </p>
                  </div>
                ))
              : questionSet.questions.map((question) => (
                  <div key={question.id} className="rounded-md border p-3">
                    <p className="text-muted-foreground">{question.label}</p>
                    <p className="font-medium">
                      {renderAnswerValue(lead.projectTypeQuestionPayload?.answers?.[question.id])}
                    </p>
                  </div>
                ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EditableLeadForm({
  mode,
  lead,
  onSaved,
  initialValues,
}: {
  mode: LeadEditableMode;
  lead?: LeadFormLead;
  onSaved?: () => void;
  initialValues?: LeadCreateFormProps["initialValues"];
}) {
  const navigate = useNavigate();
  const { stages, loading: stagesLoading } = usePipelineStages();
  const { projectTypes, hierarchy: projectTypeHierarchy } = useProjectTypes();
  const isCreate = mode === "create";
  const [companyId, setCompanyId] = useState<string | null>(lead?.companyId ?? initialValues?.companyId ?? null);
  const { properties } = useProperties(companyId ? { companyId, limit: 500 } : { limit: 0 });
  const { contacts } = useCompanyContacts(companyId ?? undefined);
  const leadStages = getLeadCreationStages(stages);

  const [formData, setFormData] = useState(() => getEditableFormState(lead, initialValues));
  const { questionnaire: questionnaireTemplate } = useLeadQuestionnaireTemplate(
    isCreate ? (formData.projectTypeId || null) : null
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageGateError, setStageGateError] = useState<LeadStageGateErrorState | null>(null);

  useEffect(() => {
    setFormData(getEditableFormState(lead, initialValues));
    setCompanyId(lead?.companyId ?? initialValues?.companyId ?? null);
  }, [initialValues, lead]);

  useEffect(() => {
    if (!isCreate) {
      return;
    }

    const normalizedStageId = getNormalizedLeadCreationStageId(leadStages, formData.stageId);
    if (!normalizedStageId || normalizedStageId === formData.stageId) {
      return;
    }

    setFormData((current) => ({ ...current, stageId: normalizedStageId }));
  }, [formData.stageId, isCreate, leadStages]);

  useEffect(() => {
    if (!isCreate) {
      return;
    }

    setFormData((current) => ({
      ...current,
      companyId: companyId ?? "",
      propertyId:
        current.propertyId && properties.some((property) => property.id === current.propertyId)
          ? current.propertyId
          : current.propertyId
            ? ""
            : properties.length === 1
              ? properties[0]?.id ?? ""
              : "",
      primaryContactId:
        current.primaryContactId && contacts.some((contact) => contact.id === current.primaryContactId)
          ? current.primaryContactId
          : "",
    }));
  }, [companyId, contacts, isCreate, properties]);

  const selectedProjectType = projectTypes.find((entry) => entry.id === formData.projectTypeId) ?? null;
  const primaryContactSelectItems = useMemo(
    () => [
      { value: "__none__", label: "Optional" },
      ...contacts.map((contact) => ({
        value: contact.id,
        label: `${contact.firstName} ${contact.lastName}`.trim(),
      })),
    ],
    [contacts]
  );
  const stageSelectItems = useMemo(
    () => leadStages.map((stage) => ({ value: stage.id, label: stage.name })),
    [leadStages]
  );
  const existingLeadProjectTypeSlug = lead?.projectType?.slug ?? null;
  const projectTypeSelectItems = useMemo(
    () => [
      {
        value: "__none__",
        label: lead?.projectType?.name ?? "Select project type",
      },
      ...projectTypeHierarchy.flatMap((parent) => [
        { value: parent.id, label: parent.name },
        ...parent.children.map((child) => ({
          value: child.id,
          label: child.name,
        })),
      ]),
    ],
    [lead?.projectType?.name, projectTypeHierarchy]
  );
  const questionSet = useMemo(
    () => getValidationQuestionSetForProjectType(selectedProjectType?.slug ?? existingLeadProjectTypeSlug),
    [existingLeadProjectTypeSlug, selectedProjectType?.slug]
  );
  const questionnaireTemplateNodes = useMemo(
    () =>
      questionnaireTemplate
        ? questionnaireTemplate.nodes.length > 0
          ? questionnaireTemplate.nodes
          : questionnaireTemplate.allNodes
        : [],
    [questionnaireTemplate]
  );
  const v2QuestionNodes = useMemo(
    () => questionnaireTemplateNodes.filter((node) => node.nodeType === "question"),
    [questionnaireTemplateNodes]
  );
  const v2NodeById = useMemo(
    () => new Map(questionnaireTemplateNodes.map((node) => [node.id, node])),
    [questionnaireTemplateNodes]
  );
  const v2VisibleQuestionNodes = useMemo(() => {
    const visibleCache = new Map<string, boolean>();

    return v2QuestionNodes
      .filter((node) =>
        isVisibleQuestionNode(node.id, v2NodeById, formData.projectTypeQuestionAnswers, visibleCache)
      )
      .sort((left, right) => left.displayOrder - right.displayOrder);
  }, [formData.projectTypeQuestionAnswers, v2NodeById, v2QuestionNodes]);
  const useV2Questionnaire = isCreate && questionnaireTemplateNodes.length > 0;
  const selectedPrimaryContactLabel =
    primaryContactSelectItems.find((item) => item.value === (formData.primaryContactId || "__none__"))?.label ??
    "Optional";
  const selectedStageLabel =
    stageSelectItems.find((item) => item.value === formData.stageId)?.label ??
    (stagesLoading ? "Loading stages..." : "Select stage");
  const selectedProjectTypeLabel =
    projectTypeSelectItems.find((item) => item.value === (formData.projectTypeId || "__none__"))?.label ??
    selectedProjectType?.name ??
    lead?.projectType?.name ??
    "Select project type";
  const gateQuestionSet = useMemo(
    () => getLeadValidationQuestionSetForProjectType(selectedProjectType?.slug ?? existingLeadProjectTypeSlug),
    [existingLeadProjectTypeSlug, selectedProjectType?.slug]
  );
  const gateQuestionLabels = useMemo(
    () => new Map(gateQuestionSet.questions.map((question) => [question.id, question.label])),
    [gateQuestionSet.questions]
  );

  const handleFieldChange = (field: keyof typeof formData, value: string) => {
    setFormData((current) => ({ ...current, [field]: value }));
  };

  const handleQualificationChange = (fieldId: string, value: string) => {
    setFormData((current) => ({
      ...current,
      qualificationPayload: {
        ...current.qualificationPayload,
        [fieldId]: value,
      },
    }));
  };

  const handleSourceCategoryChange = (value: string | null) => {
    setFormData((current) => ({
      ...current,
      sourceCategory: !value || value === "__none__" ? "" : value,
      sourceDetail: value === "Other" ? current.sourceDetail : "",
    }));
  };

  const handleQuestionAnswerChange = (
    questionId: string,
    input: "text" | "textarea" | "number" | "boolean",
    value: string
  ) => {
    let nextValue: LeadAnswerValue = value;

    if (input === "number") {
      nextValue = value.trim() === "" ? null : Number(value);
    }
    if (input === "boolean") {
      nextValue = value === "true";
    }

    setFormData((current) => ({
      ...current,
      projectTypeQuestionAnswers: {
        ...current.projectTypeQuestionAnswers,
        [questionId]: nextValue,
      },
    }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const effectiveStageId = isCreate
      ? getNormalizedLeadCreationStageId(leadStages, formData.stageId)
      : formData.stageId;

    if (isCreate && stagesLoading) {
      setError("Initial stage is still loading. Try again in a moment.");
      return;
    }

    if (!formData.companyId || !formData.propertyId || !formData.name.trim() || !effectiveStageId) {
      setError("Company, property, lead name, and initial stage are required.");
      return;
    }

    if (!formData.sourceCategory) {
      setError("Source is required.");
      return;
    }

    if (formData.sourceCategory === "Other" && !formData.sourceDetail.trim()) {
      setError("Source detail is required when Source is Other.");
      return;
    }

    if (isCreate && useV2Questionnaire) {
      const missingRequiredQuestions = v2VisibleQuestionNodes
        .filter((node) => node.isRequired && !isAnsweredQuestionValue(formData.projectTypeQuestionAnswers[node.key]))
        .map((node) => node.label);

      if (missingRequiredQuestions.length > 0) {
        setError(`Answer required project intake questions: ${missingRequiredQuestions.join(", ")}`);
        return;
      }
    }

    setSubmitting(true);
    setError(null);
    setStageGateError(null);

    try {
      const workflowPayload = {
        projectTypeId: formData.projectTypeId || null,
        qualificationPayload: {
          existing_customer_status: null,
          estimated_value:
            formData.qualificationPayload.estimated_value.trim() === ""
              ? null
              : Number(formData.qualificationPayload.estimated_value),
          timeline_status: formData.qualificationPayload.timeline_status.trim() || null,
        },
        projectTypeQuestionPayload: useV2Questionnaire
          ? undefined
          : {
              projectTypeId: formData.projectTypeId || null,
              answers: Object.fromEntries(
                questionSet.questions.map((question) => [
                  question.id,
                  formData.projectTypeQuestionAnswers[question.id] ?? null,
                ])
              ),
            },
        leadQuestionAnswers: useV2Questionnaire
          ? Object.fromEntries(
              v2QuestionNodes.map((node) => [node.key, formData.projectTypeQuestionAnswers[node.key] ?? null])
            )
          : Object.fromEntries(
              questionSet.questions.map((question) => [
                question.id,
                formData.projectTypeQuestionAnswers[question.id] ?? null,
              ])
            ),
      };

      if (isCreate) {
        const result = await createLead({
          companyId: formData.companyId,
          propertyId: formData.propertyId,
          primaryContactId: formData.primaryContactId || null,
          name: formData.name.trim(),
          stageId: effectiveStageId,
          source: formData.source.trim() || null,
          sourceCategory: formData.sourceCategory as LeadSourceCategory,
          sourceDetail: formData.sourceDetail.trim() || null,
          description: formData.description.trim() || null,
          ...workflowPayload,
        });

        navigate(`/leads/${result.lead.id}`);
      } else if (lead) {
        await updateLead(lead.id, {
          source: formData.source.trim() || null,
          sourceCategory: formData.sourceCategory as LeadSourceCategory,
          sourceDetail: formData.sourceDetail.trim() || null,
          description: formData.description.trim() || null,
          ...workflowPayload,
        });
        if (onSaved) {
          onSaved();
        } else {
          navigate(`/leads/${lead.id}`);
        }
      }
    } catch (err: unknown) {
      if (isApiError(err) && err.code === "LEAD_STAGE_REQUIREMENTS_UNMET") {
        setStageGateError({
          message: err.message,
          code: err.code,
          missingRequirements: err.missingRequirements as LeadStageGateErrorState["missingRequirements"],
          currentStage: err.currentStage as LeadStageGateErrorState["currentStage"],
          targetStage: err.targetStage as LeadStageGateErrorState["targetStage"],
        });
        setError(null);
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to save lead");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-4xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{isCreate ? "Lead Information" : "Lead Qualification"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          ) : null}
          {stageGateError ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              <p className="font-medium">{stageGateError.message}</p>
              {stageGateError.currentStage?.name && stageGateError.targetStage?.name ? (
                <p className="mt-1 text-xs text-amber-800">
                  {stageGateError.currentStage.name} {"->"} {stageGateError.targetStage.name}
                </p>
              ) : null}
              {stageGateError.missingRequirements?.qualificationFields?.length ? (
                <p className="mt-2 text-xs text-amber-800">
                  Missing qualification fields:{" "}
                  {stageGateError.missingRequirements.qualificationFields
                    .map(
                      (fieldId) =>
                        LEAD_QUALIFICATION_FIELD_LABELS.get(fieldId as LeadQualificationFieldId) ?? fieldId
                    )
                    .join(", ")}
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
            </div>
          ) : null}

          {isCreate ? (
            <>
              <div className="space-y-2">
                <Label>Company</Label>
                <CompanySelector value={companyId} onChange={setCompanyId} required />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="propertyId">Property</Label>
                  <PropertySelector
                    companyId={companyId}
                    value={formData.propertyId || null}
                    onChange={(propertyId) => handleFieldChange("propertyId", propertyId)}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="primaryContactId">Primary Contact</Label>
                  <Select
                    items={primaryContactSelectItems}
                    value={formData.primaryContactId || "__none__"}
                    onValueChange={(value) =>
                      handleFieldChange("primaryContactId", !value || value === "__none__" ? "" : value)
                    }
                  >
                    <SelectTrigger id="primaryContactId">
                      <SelectValue>{selectedPrimaryContactLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No primary contact</SelectItem>
                      {contacts.map((contact) => (
                        <SelectItem key={contact.id} value={contact.id}>
                          {contact.firstName} {contact.lastName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="name">Lead Name</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(event) => handleFieldChange("name", event.target.value)}
                    placeholder="e.g., Palm Villas exterior refresh"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="stageId">Initial Stage</Label>
                  <Select
                    items={stageSelectItems}
                    value={formData.stageId}
                    onValueChange={(value) => handleFieldChange("stageId", value ?? "")}
                    disabled={stagesLoading}
                  >
                    <SelectTrigger id="stageId">
                      <SelectValue>{selectedStageLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {leadStages.map((stage) => (
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
                  <QuestionLabel htmlFor="sourceCategory" required>
                    Source
                  </QuestionLabel>
                  <Select
                    value={formData.sourceCategory || "__none__"}
                    onValueChange={handleSourceCategoryChange}
                  >
                    <SelectTrigger id="sourceCategory">
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
                  <Label htmlFor="projectTypeId">Project Type</Label>
                  <Select
                    items={projectTypeSelectItems}
                    value={formData.projectTypeId || "__none__"}
                    onValueChange={(value) =>
                      handleFieldChange("projectTypeId", !value || value === "__none__" ? "" : value)
                    }
                  >
                    <SelectTrigger id="projectTypeId">
                      <SelectValue>{selectedProjectTypeLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Select project type</SelectItem>
                      {projectTypeHierarchy.flatMap((parent) => [
                        <SelectItem key={parent.id} value={parent.id} className="font-medium">
                          {parent.name}
                        </SelectItem>,
                        ...parent.children.map((child) => (
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
                  <QuestionLabel htmlFor="sourceDetail" required>
                    Source detail
                  </QuestionLabel>
                  <Input
                    id="sourceDetail"
                    value={formData.sourceDetail}
                    onChange={(event) => handleFieldChange("sourceDetail", event.target.value)}
                    placeholder="Describe the source"
                  />
                </div>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <textarea
                  id="description"
                  className="flex min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={formData.description}
                  onChange={(event) => handleFieldChange("description", event.target.value)}
                  placeholder="Brief summary of the lead..."
                />
              </div>
            </>
          ) : (
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <p className="text-muted-foreground">Lead</p>
                <p className="font-medium">{lead?.name ?? "--"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Company</p>
                <p className="font-medium">{lead?.companyName ?? "--"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Property</p>
                <p className="font-medium">
                  {lead
                    ? formatPropertyLabel({
                        name: lead.propertyName ?? "",
                        address: lead.propertyAddress,
                        city: lead.propertyCity,
                        state: lead.propertyState,
                        zip: lead.propertyZip,
                      })
                    : "--"}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="projectTypeId">Project Type</Label>
                <Select
                  items={projectTypeSelectItems}
                  value={formData.projectTypeId || "__none__"}
                  onValueChange={(value) =>
                    handleFieldChange("projectTypeId", !value || value === "__none__" ? "" : value)
                  }
                >
                  <SelectTrigger id="projectTypeId">
                    <SelectValue>{selectedProjectTypeLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Select project type</SelectItem>
                    {projectTypeHierarchy.flatMap((parent) => [
                      <SelectItem key={parent.id} value={parent.id} className="font-medium">
                        {parent.name}
                      </SelectItem>,
                      ...parent.children.map((child) => (
                        <SelectItem key={child.id} value={child.id} className="pl-6">
                          {child.name}
                        </SelectItem>
                      )),
                    ])}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <QuestionLabel htmlFor="sourceCategory" required>
                  Source
                </QuestionLabel>
                <Select
                  value={formData.sourceCategory || "__none__"}
                  onValueChange={handleSourceCategoryChange}
                >
                  <SelectTrigger id="sourceCategory">
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
              {formData.sourceCategory === "Other" ? (
                <div className="space-y-2">
                  <QuestionLabel htmlFor="sourceDetail" required>
                    Source detail
                  </QuestionLabel>
                  <Input
                    id="sourceDetail"
                    value={formData.sourceDetail}
                    onChange={(event) => handleFieldChange("sourceDetail", event.target.value)}
                    placeholder="Describe the source"
                  />
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sales Validation Fields</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>Existing Customer Status</Label>
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm font-medium">
              {lead?.existingCustomerStatus ?? "Computed on save"}
            </div>
          </div>
          {EDITABLE_QUALIFICATION_FIELDS.map(
            (field: { id: LeadQualificationFieldId; label: string; input: string }) => (
              <div key={field.id} className="space-y-2">
                <Label htmlFor={field.id}>{field.label}</Label>
                <Input
                  id={field.id}
                  type={field.input === "number" ? "number" : "text"}
                  value={formData.qualificationPayload[field.id] ?? ""}
                  onChange={(event) => handleQualificationChange(field.id, event.target.value)}
                />
              </div>
            )
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{useV2Questionnaire ? "Project Questions" : questionSet.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {useV2Questionnaire
            ? v2VisibleQuestionNodes.map((node) => {
                const currentValue = formData.projectTypeQuestionAnswers[node.key];
                const inputType = getQuestionInputType(node);
                const options = normalizeQuestionOptions(node.options);

                return (
                  <div key={node.id} className="space-y-2">
                    <QuestionLabel htmlFor={node.key} required={node.isRequired}>
                      {node.label}
                    </QuestionLabel>
                    {node.prompt ? <p className="text-sm text-muted-foreground">{node.prompt}</p> : null}
                    {inputType === "textarea" ? (
                      <textarea
                        id={node.key}
                        className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        value={typeof currentValue === "string" ? currentValue : ""}
                        onChange={(event) => handleQuestionAnswerChange(node.key, inputType, event.target.value)}
                      />
                    ) : inputType === "boolean" ? (
                      <Select
                        value={typeof currentValue === "boolean" ? String(currentValue) : "__unanswered__"}
                        onValueChange={(value) =>
                          handleQuestionAnswerChange(
                            node.key,
                            inputType,
                            !value || value === "__unanswered__" ? "" : value
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
                        items={[
                          { value: "__unanswered__", label: "Select" },
                          ...options.map((option) => ({ value: option.value, label: option.label })),
                        ]}
                        value={typeof currentValue === "string" && currentValue ? currentValue : "__unanswered__"}
                        onValueChange={(value) =>
                          handleQuestionAnswerChange(
                            node.key,
                            "text",
                            !value || value === "__unanswered__" ? "" : value
                          )
                        }
                      >
                        <SelectTrigger id={node.key}>
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__unanswered__">Select</SelectItem>
                          {options.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id={node.key}
                        type={inputType === "number" ? "number" : inputType === "date" ? "date" : "text"}
                        value={
                          typeof currentValue === "number"
                            ? String(currentValue)
                            : typeof currentValue === "string"
                              ? currentValue
                              : ""
                        }
                        onChange={(event) =>
                          handleQuestionAnswerChange(
                            node.key,
                            inputType === "date" ? "text" : inputType,
                            event.target.value
                          )
                        }
                      />
                    )}
                  </div>
                );
              })
            : questionSet.questions.map((question) => {
            const currentValue = formData.projectTypeQuestionAnswers[question.id];
            return (
              <div key={question.id} className="space-y-2">
                <Label htmlFor={question.id}>{question.label}</Label>
                <p className="text-sm text-muted-foreground">{question.prompt}</p>
                {question.input === "textarea" ? (
                  <textarea
                    id={question.id}
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={typeof currentValue === "string" ? currentValue : ""}
                    onChange={(event) =>
                      handleQuestionAnswerChange(question.id, question.input, event.target.value)
                    }
                  />
                ) : question.input === "boolean" ? (
                  <Select
                    value={typeof currentValue === "boolean" ? String(currentValue) : "__unanswered__"}
                    onValueChange={(value) =>
                      handleQuestionAnswerChange(
                        question.id,
                        question.input,
                        !value || value === "__unanswered__" ? "" : value
                      )
                    }
                  >
                    <SelectTrigger id={question.id}>
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__unanswered__">Unanswered</SelectItem>
                      <SelectItem value="true">Yes</SelectItem>
                      <SelectItem value="false">No</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={question.id}
                    type={question.input === "number" ? "number" : "text"}
                    value={
                      typeof currentValue === "number"
                        ? String(currentValue)
                        : typeof currentValue === "string"
                          ? currentValue
                          : ""
                    }
                    onChange={(event) =>
                      handleQuestionAnswerChange(question.id, question.input, event.target.value)
                    }
                  />
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting || (isCreate && stagesLoading)}>
          {submitting
            ? "Saving..."
            : isCreate && stagesLoading
              ? "Loading stages..."
              : isCreate
                ? "Create Lead"
                : "Save Qualification"}
        </Button>
        <Button type="button" variant="outline" onClick={() => navigate(isCreate ? "/leads" : `/leads/${lead?.id}`)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function LeadForm(props: LeadFormProps) {
  if (props.mode === "create") {
    return <EditableLeadForm mode="create" initialValues={props.initialValues} />;
  }

  if (props.mode === "edit") {
    return <EditableLeadForm mode="edit" lead={props.lead} onSaved={props.onSaved} />;
  }

  return <SummaryLeadForm {...props} />;
}
