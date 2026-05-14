import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import type { LeadQualificationFieldId } from "@trock-crm/shared/types";
import {
  CONTACT_CATEGORIES,
  getLeadValidationQuestionSetForProjectType,
  isLegacyTimelineStatusValue,
  LEAD_BUDGET_STATUSES,
  LEAD_SOURCE_CATEGORIES,
  type LeadBudgetStatus,
  type LeadPocRole,
  type LeadSourceCategory,
  LEAD_QUALIFICATION_FIELDS,
  normalizeTimelineStatusForSave,
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
import { RecordAssignmentCard } from "@/components/assignment/record-assignment-card";
import { LeadStageBadge } from "./lead-stage-badge";
import { useCompanyContacts } from "@/hooks/use-companies";
import { createContact } from "@/hooks/use-contacts";
import { useTaskAssignees } from "@/hooks/use-task-assignees";
import { useSalesReps } from "@/hooks/use-sales-reps";
import {
  createLead,
  updateLead,
  useLeadQuestionnaireTemplate,
  type LeadAnswerValue,
  type LeadQuestionnaireSnapshot,
} from "@/hooks/use-leads";
import { usePipelineStages, useProjectTypes } from "@/hooks/use-pipeline-config";
import { formatPropertyLabel, updateProperty, useProperties, usePropertyDetail, type PropertySurface } from "@/hooks/use-properties";
import { CATEGORY_LABELS } from "@/lib/contact-utils";
import { isApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  buildOfficeSelectionOptions,
  resolveDefaultOfficeCode,
  type OfficeSelectionOption,
} from "@/lib/office-selection";
import {
  LEAD_BUDGET_STATUS_LABELS,
  LEAD_POC_ROLE_FORM_OPTIONS,
  LEAD_POC_ROLE_LABELS,
} from "@/lib/lead-display-labels";
import { getValidationQuestionSetForProjectType } from "@/lib/validation-question-sets";
import { useAccessibleOffices } from "@/hooks/use-accessible-offices";
import {
  getLeadCreationStages,
  getNormalizedLeadCreationStageId,
} from "@/pages/leads/lead-new-page.helpers";
import {
  formatQuestionAnswerValue,
  questionnaireRevealMatches,
} from "./questionnaire-display";
import { LeadQuestionnaireSections } from "./lead-questionnaire-sections";
import { uploadFile } from "@/hooks/use-files";
import { ALLOWED_EXTENSIONS, validateFileForUpload } from "@/lib/file-utils";
import { CLIENT_PROVIDED_DOCS_TAG, inferClientProvidedDocsCategory } from "@/lib/lead-attachment-routing";

export interface LeadFormLead {
  id: string;
  name: string;
  convertedDealId: string | null;
  convertedDealNumber: string | null;
  assignedRepId?: string | null;
  salesRepId?: string | null;
  assignedRepName?: string | null;
  companyId: string | null;
  companyName: string | null;
  stageId: string;
  propertyId: string | null;
  propertyName: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  primaryContactId?: string | null;
  primaryContactRole?: LeadPocRole | null;
  primaryContactRoleOtherLabel?: string | null;
  source: string | null;
  sourceCategory?: LeadSourceCategory | null;
  sourceDetail?: string | null;
  existingCustomerStatus?: "Existing" | "New" | null;
  description: string | null;
  budgetStatus?: LeadBudgetStatus | null;
  bidDueDate?: string | null;
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
  verificationStatus?: "not_required" | "pending" | "approved" | "rejected";
  verificationRequiredReason?: "new_company" | "dormant_company" | "active_company" | null;
  officeCode?: string | null;
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
    primaryContactRole: LeadPocRole;
    name: string;
    source: string;
    description: string;
    bidDueDate: string;
    budgetStatus: LeadBudgetStatus;
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
const V2_QUALIFICATION_DUPLICATE_KEYS = new Set(["timeline"]);
const V2_QUALIFICATION_DUPLICATE_LABELS = new Map([["timeline", "Timeline Target Date"]]);

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
  initialValues?: LeadCreateFormProps["initialValues"],
  fallbackOfficeCode = ""
) {
  const sourceState = normalizeLeadSourceForForm(lead, initialValues?.source);

  return {
    companyId: lead?.companyId ?? initialValues?.companyId ?? "",
    propertyId: lead?.propertyId ?? initialValues?.propertyId ?? "",
    primaryContactId: lead?.primaryContactId ?? initialValues?.primaryContactId ?? "",
    primaryContactRole: lead?.primaryContactRole ?? initialValues?.primaryContactRole ?? "",
    primaryContactRoleOtherLabel: lead?.primaryContactRoleOtherLabel ?? "",
    name: lead?.name ?? initialValues?.name ?? "",
    stageId: lead?.stageId ?? initialValues?.stageId ?? "",
    assignedRepId: lead?.assignedRepId ?? lead?.salesRepId ?? "",
    source: lead?.source ?? initialValues?.source ?? "",
    sourceCategory: sourceState.sourceCategory,
    sourceDetail: sourceState.sourceDetail,
    description: lead?.description ?? initialValues?.description ?? "",
    bidDueDate: lead?.bidDueDate ?? initialValues?.bidDueDate ?? "",
    officeCode: lead?.officeCode === "atl" || lead?.officeCode === "dfw" ? lead.officeCode : fallbackOfficeCode,
    projectTypeId: lead?.projectTypeId ?? initialValues?.projectTypeId ?? "",
    budgetStatus: lead?.budgetStatus ?? initialValues?.budgetStatus ?? "",
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

function renderAnswerValue(value: LeadAnswerValue | undefined, options: { formatStringEnums?: boolean } = {}) {
  const formatted = formatQuestionAnswerValue(value, options);
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

function isAnsweredQuestionValue(value: LeadAnswerValue | undefined) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function parseIntegerInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function isValidBuildYear(value: unknown, maxYear: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1800 && value <= maxYear;
}

function isPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function getPhoneValidationError(phone: string) {
  const raw = phone.trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) {
    return "Phone must be 10-15 digits.";
  }
  return null;
}

function QuestionLabel({
  htmlFor,
  children,
  required = false,
}: {
  htmlFor?: string;
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

function ClientProvidedDocsUploadField({
  files,
  onAddFiles,
  onRemoveFile,
  disabled = false,
}: {
  files: File[];
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  disabled?: boolean;
}) {
  const accept = Array.from(ALLOWED_EXTENSIONS).join(",");

  return (
    <div data-question-key="client_provided_docs" className="space-y-3 rounded-md border p-3">
      <QuestionLabel htmlFor="client-provided-docs-upload">
        Client Provided Docs (Plans, Scope, Specs)
      </QuestionLabel>
      <Input
        id="client-provided-docs-upload"
        type="file"
        multiple
        accept={accept}
        disabled={disabled}
        onChange={(event) => {
          const nextFiles = Array.from(event.target.files ?? []);
          onAddFiles(nextFiles);
          event.currentTarget.value = "";
        }}
      />
      <p className="text-xs text-muted-foreground">
        Upload plans, scope documents, specs, email exports, or site photos. Files are attached to this lead and auto-routed when converted.
      </p>
      {files.length > 0 ? (
        <div className="space-y-2">
          {files.map((file, index) => (
            <div key={`${file.name}-${file.size}-${index}`} className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">{file.name}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => onRemoveFile(index)}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CurrencyInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
        $
      </span>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        className="pl-7"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

const VERIFICATION_LABELS: Record<NonNullable<LeadFormLead["verificationStatus"]>, string> = {
  not_required: "Not required",
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

function SummaryLeadForm({
  lead,
  converted = false,
  showPrimaryAction = true,
  onSaved,
}: LeadSummaryFormProps) {
  const navigate = useNavigate();
  const { projectTypes } = useProjectTypes();
  const { user } = useAuth();
  const { assignees } = useTaskAssignees();
  const { salesReps } = useSalesReps();
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
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
  const verificationStatus = lead.verificationStatus ?? "not_required";
  const verificationLabel = VERIFICATION_LABELS[verificationStatus];
  const assignedRepId = lead.assignedRepId ?? lead.salesRepId ?? "";
  const assignedRepName =
    lead.assignedRepName ??
    salesReps.find((rep) => rep.id === assignedRepId)?.displayName ??
    assignees.find((assignee) => assignee.id === assignedRepId)?.displayName ??
    null;
  const canEditAssignment =
    Boolean(user) &&
    (user?.role === "admin" ||
      user?.role === "director" ||
      (user?.role === "rep" && assignedRepId === user.id));

  async function handleAssignmentSave(nextRepId: string) {
    if (!nextRepId || nextRepId === assignedRepId) {
      return;
    }

    setAssignmentSaving(true);
    setAssignmentError(null);
    try {
      await updateLead(lead.id, { assignedRepId: nextRepId, salesRepId: nextRepId });
      onSaved?.();
    } catch (err) {
      setAssignmentError(err instanceof Error ? err.message : "Could not update sales rep.");
    } finally {
      setAssignmentSaving(false);
    }
  }

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
          <div>
            <p className="text-muted-foreground">Verification</p>
            <p className="font-medium">{verificationLabel}</p>
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

        <RecordAssignmentCard
          label="Sales Rep"
          assignedRepId={assignedRepId}
          assignedRepName={assignedRepName}
          reps={salesReps.length > 0 ? salesReps : assignees}
          canEdit={canEditAssignment}
          saving={assignmentSaving}
          onSave={handleAssignmentSave}
        />
        {assignmentError ? (
          <p className="text-xs text-red-600" role="alert">{assignmentError}</p>
        ) : null}

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
                      {renderAnswerValue(lead.leadQuestionnaire?.answers?.[node.key], {
                        formatStringEnums: Array.isArray(node.options) && node.options.length > 0,
                      })}
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
  const { user } = useAuth();
  const { stages } = usePipelineStages();
  const { projectTypes, hierarchy: projectTypeHierarchy } = useProjectTypes();
  const { offices } = useAccessibleOffices();
  const isCreate = mode === "create";
  const activeOfficeId = user?.activeOfficeId ?? user?.officeId ?? null;
  const officeOptions = buildOfficeSelectionOptions(offices);
  const initialOfficeCode = resolveDefaultOfficeCode({
    offices,
    activeOfficeId,
    currentOfficeCode: lead?.officeCode === "atl" || lead?.officeCode === "dfw" ? lead.officeCode : "",
  });
  const [companyId, setCompanyId] = useState<string | null>(lead?.companyId ?? initialValues?.companyId ?? null);
  const leadStages = getLeadCreationStages(stages);

  const [formData, setFormData] = useState(() => getEditableFormState(lead, initialValues, initialOfficeCode));
  const selectedOffice = officeOptions.find((office) => office.code === formData.officeCode) ?? null;
  const { assignees } = useTaskAssignees({ officeId: isCreate ? selectedOffice?.officeId : null });
  const { properties } = useProperties(
    companyId ? { companyId, limit: 500 } : { limit: 0 },
    { officeId: isCreate ? selectedOffice?.officeId : null }
  );
  const { contacts, refetch: refetchContacts } = useCompanyContacts(
    companyId ?? undefined,
    { officeId: isCreate ? selectedOffice?.officeId : null }
  );
  const { property: resolvedSelectedProperty } = usePropertyDetail(
    isCreate && formData.propertyId ? formData.propertyId : undefined,
    { officeId: isCreate ? selectedOffice?.officeId : null }
  );
  const { questionnaire: questionnaireTemplate, loading: questionnaireTemplateLoading } = useLeadQuestionnaireTemplate(
    isCreate ? (formData.projectTypeId || null) : null
  );
  const [submitting, setSubmitting] = useState(false);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [contactSubmitting, setContactSubmitting] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);
  const [newContact, setNewContact] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    jobTitle: "",
    category: "client",
  });
  const [error, setError] = useState<string | null>(null);
  const [stageGateError, setStageGateError] = useState<LeadStageGateErrorState | null>(null);
  const [createGateMissingKeys, setCreateGateMissingKeys] = useState<string[]>([]);
  const [propertyRepair, setPropertyRepair] = useState<{
    address: string;
    city: string;
    state: string;
    zip: string;
    buildYear: number | null;
    unitCount: number | null;
  }>({
    address: "",
    city: "",
    state: "",
    zip: "",
    buildYear: null,
    unitCount: null,
  });
  const [repairedProperties, setRepairedProperties] = useState(new Map<string, PropertySurface>());
  const [clientProvidedDocFiles, setClientProvidedDocFiles] = useState<File[]>([]);

  useEffect(() => {
    setFormData(getEditableFormState(lead, initialValues, initialOfficeCode));
    setCompanyId(lead?.companyId ?? initialValues?.companyId ?? null);
  }, [initialValues, lead]);

  useEffect(() => {
    if (!isCreate) {
      return;
    }

    setFormData((current) => {
      const officeCode = resolveDefaultOfficeCode({
        offices,
        activeOfficeId,
        currentOfficeCode: current.officeCode,
      });
      return officeCode === current.officeCode ? current : { ...current, officeCode };
    });
  }, [activeOfficeId, isCreate, offices]);

  useEffect(() => {
    if (!isCreate || user?.role !== "rep") {
      return;
    }

    setFormData((current) =>
      current.assignedRepId ? current : { ...current, assignedRepId: user.id }
    );
  }, [isCreate, user?.id, user?.role]);

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
      propertyId: current.propertyId || (properties.length === 1 ? properties[0]?.id ?? "" : ""),
      primaryContactId:
        current.primaryContactId && contacts.some((contact) => contact.id === current.primaryContactId)
          ? current.primaryContactId
          : "",
    }));
  }, [companyId, contacts, isCreate, properties]);

  useEffect(() => {
    if (!isCreate) {
      return;
    }

    setPropertyRepair({ address: "", city: "", state: "", zip: "", buildYear: null, unitCount: null });
  }, [formData.propertyId, isCreate]);

  const selectedProjectType = projectTypes.find((entry) => entry.id === formData.projectTypeId) ?? null;
  const selectedProperty =
    repairedProperties.get(formData.propertyId) ??
    (resolvedSelectedProperty?.id === formData.propertyId ? resolvedSelectedProperty : null) ??
    properties.find((property) => property.id === formData.propertyId) ??
    null;
  const maxPropertyBuildYear = new Date().getFullYear() + 2;
  const propertyAddressNeedsRepair =
    isCreate && Boolean(selectedProperty) && !selectedProperty?.address?.trim();
  const propertyCityNeedsRepair =
    isCreate && Boolean(selectedProperty) && !selectedProperty?.city?.trim();
  const propertyStateNeedsRepair =
    isCreate && Boolean(selectedProperty) && !/^[A-Z]{2}$/.test((selectedProperty?.state ?? "").trim().toUpperCase());
  const propertyZipNeedsRepair =
    isCreate && Boolean(selectedProperty) && !/^\d{5}(-\d{4})?$/.test((selectedProperty?.zip ?? "").trim());
  const propertyBuildYearNeedsRepair =
    isCreate && Boolean(selectedProperty) && !isValidBuildYear(selectedProperty?.buildYear, maxPropertyBuildYear);
  const propertyUnitCountNeedsRepair =
    isCreate && Boolean(selectedProperty) && !isPositiveInteger(selectedProperty?.unitCount);
  const effectivePropertyAddress = propertyAddressNeedsRepair ? propertyRepair.address : selectedProperty?.address ?? "";
  const effectivePropertyCity = propertyCityNeedsRepair ? propertyRepair.city : selectedProperty?.city ?? "";
  const effectivePropertyState = propertyStateNeedsRepair ? propertyRepair.state : selectedProperty?.state ?? "";
  const effectivePropertyZip = propertyZipNeedsRepair ? propertyRepair.zip : selectedProperty?.zip ?? "";
  const effectivePropertyBuildYear = propertyBuildYearNeedsRepair
    ? propertyRepair.buildYear
    : selectedProperty?.buildYear ?? null;
  const effectivePropertyUnitCount = propertyUnitCountNeedsRepair
    ? propertyRepair.unitCount
    : selectedProperty?.unitCount ?? null;
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
  const pocRoleSelectItems = useMemo(
    () => [
      { value: "__none__", label: "Select POC role" },
      ...LEAD_POC_ROLE_FORM_OPTIONS.map((role) => ({ value: role, label: LEAD_POC_ROLE_LABELS[role] })),
    ],
    []
  );
  const budgetStatusSelectItems = useMemo(
    () => [
      { value: "__none__", label: "Select budget status" },
      ...LEAD_BUDGET_STATUSES.map((status) => ({ value: status, label: LEAD_BUDGET_STATUS_LABELS[status] })),
    ],
    []
  );
  const repSelectItems = useMemo(
    () => assignees.map((assignee) => ({ value: assignee.id, label: assignee.displayName })),
    [assignees]
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
    () => questionnaireTemplateNodes.filter((node) => node.nodeType === "question" && node.key !== "budget"),
    [questionnaireTemplateNodes]
  );
  const v2RenderedQuestionNodes = useMemo(
    () =>
      v2QuestionNodes.filter(
        (node) => !["bid_due_date", "number_of_bidders", "poc"].includes(node.key) &&
          !V2_QUALIFICATION_DUPLICATE_KEYS.has(node.key)
      ),
    [v2QuestionNodes]
  );
  const numberOfBiddersNode = useMemo(
    () => v2QuestionNodes.find((node) => node.key === "number_of_bidders") ?? null,
    [v2QuestionNodes]
  );
  const v2NodeById = useMemo(
    () => new Map(questionnaireTemplateNodes.map((node) => [node.id, node])),
    [questionnaireTemplateNodes]
  );
  const v2VisibleQuestionNodes = useMemo(() => {
    const visibleCache = new Map<string, boolean>();

    return v2RenderedQuestionNodes
      .filter((node) =>
        isVisibleQuestionNode(node.id, v2NodeById, formData.projectTypeQuestionAnswers, visibleCache)
      )
      .sort((left, right) => left.displayOrder - right.displayOrder);
  }, [formData.projectTypeQuestionAnswers, v2NodeById, v2RenderedQuestionNodes]);
  const useV2Questionnaire = isCreate && questionnaireTemplateNodes.length > 0;
  const createRequirementErrors = useMemo(() => {
    if (!isCreate) return new Map<string, string>();
    const errors = new Map<string, string>();
    if (!selectedProperty) {
      errors.set("propertyId", "Select or create a property.");
    } else {
      if (!effectivePropertyAddress.trim()) errors.set("property.address", "Address line 1 is required.");
      if (!effectivePropertyCity.trim()) errors.set("property.city", "City is required.");
      if (!effectivePropertyState.trim() || !/^[A-Z]{2}$/.test(effectivePropertyState.trim().toUpperCase())) {
        errors.set("property.state", "State must be a 2-letter US state code.");
      }
      if (!effectivePropertyZip.trim() || !/^\d{5}(-\d{4})?$/.test(effectivePropertyZip.trim())) {
        errors.set("property.zip", "ZIP must be 5 digits or ZIP+4.");
      }
      if (!isValidBuildYear(effectivePropertyBuildYear, maxPropertyBuildYear)) {
        errors.set("property.buildYear", `Year built must be between 1800 and ${maxPropertyBuildYear}.`);
      }
      if (!isPositiveInteger(effectivePropertyUnitCount)) {
        errors.set("property.unitCount", "Number of units must be a positive integer.");
      }
    }
    if (!formData.primaryContactId) errors.set("primaryContactId", "Point of contact is required.");
    if (!formData.primaryContactRole) errors.set("primaryContactRole", "POC role is required.");
    if (formData.primaryContactRole === "other" && !formData.primaryContactRoleOtherLabel.trim()) {
      errors.set("primaryContactRoleOtherLabel", "Describe the other POC role.");
    }
    if (!formData.name.trim()) errors.set("name", "Lead name is required.");
    if (!formData.budgetStatus) errors.set("budgetStatus", "Budget status is required.");
    if (!formData.officeCode || !selectedOffice?.officeId) errors.set("officeCode", "Office is required.");
    if (!formData.projectTypeId) errors.set("projectTypeId", "Project type is required.");
    if (!formData.bidDueDate) {
      errors.set("bidDueDate", "Bid Due Date is required.");
    }
    for (const key of createGateMissingKeys) {
      if (!errors.has(key)) errors.set(key, "Required before creating a lead.");
    }
    return errors;
  }, [
    createGateMissingKeys,
    effectivePropertyAddress,
    effectivePropertyBuildYear,
    effectivePropertyCity,
    effectivePropertyState,
    effectivePropertyUnitCount,
    effectivePropertyZip,
    formData.bidDueDate,
    formData.budgetStatus,
    formData.officeCode,
    formData.primaryContactId,
    formData.primaryContactRole,
    formData.primaryContactRoleOtherLabel,
    formData.name,
    formData.projectTypeId,
    formData.projectTypeQuestionAnswers,
    isCreate,
    maxPropertyBuildYear,
    selectedProperty,
    selectedOffice?.officeId,
  ]);
  const createSubmitDisabled = isCreate && (questionnaireTemplateLoading || createRequirementErrors.size > 0);
  const selectedPrimaryContactLabel =
    primaryContactSelectItems.find((item) => item.value === (formData.primaryContactId || "__none__"))?.label ??
    "Optional";
  const selectedPocRoleLabel =
    pocRoleSelectItems.find((item) => item.value === (formData.primaryContactRole || "__none__"))?.label ??
    (formData.primaryContactRole
      ? LEAD_POC_ROLE_LABELS[formData.primaryContactRole as LeadPocRole] ?? formData.primaryContactRole
      : null) ??
    "Select POC role";
  const selectedBudgetStatusLabel =
    budgetStatusSelectItems.find((item) => item.value === (formData.budgetStatus || "__none__"))?.label ??
    "Select budget status";
  const selectedOfficeLabel =
    officeOptions.find((item) => item.code === formData.officeCode)?.label ?? "Select office";
  const selectedRepLabel =
    repSelectItems.find((item) => item.value === formData.assignedRepId)?.label ??
    (user?.role === "rep" ? user.displayName : "Select sales rep");
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

  const clearCreateGateMissingKeys = (keys: string[]) => {
    setCreateGateMissingKeys((current) => current.filter((key) => !keys.includes(key)));
  };

  const clearCreateGateMissingKeysForField = (field: keyof typeof formData) => {
    const fieldMap: Partial<Record<keyof typeof formData, string[]>> = {
      propertyId: [
        "propertyId",
        "property.address",
        "property.city",
        "property.state",
        "property.zip",
        "property.buildYear",
        "property.unitCount",
      ],
      primaryContactId: ["primaryContactId"],
      primaryContactRole: ["primaryContactRole", "primaryContactRoleOtherLabel"],
      primaryContactRoleOtherLabel: ["primaryContactRoleOtherLabel"],
      budgetStatus: ["budgetStatus"],
      projectTypeId: ["projectTypeId"],
      bidDueDate: ["bidDueDate"],
    };
    const keys = fieldMap[field];
    if (keys) {
      clearCreateGateMissingKeys(keys);
    }
  };

  const handleFieldChange = (field: keyof typeof formData, value: string) => {
    if (field === "officeCode") {
      setCompanyId(null);
    }

    setFormData((current) => {
      if (field === "officeCode") {
        return {
          ...current,
          officeCode: value,
          companyId: "",
          propertyId: "",
          primaryContactId: "",
          assignedRepId: user?.role === "rep" ? user.id : "",
        };
      }

      return { ...current, [field]: value };
    });
    clearCreateGateMissingKeysForField(field);
  };

  const handlePropertyRepairChange = (field: keyof typeof propertyRepair, value: string) => {
    const nextValue =
      field === "buildYear" || field === "unitCount"
        ? parseIntegerInput(value)
        : field === "state"
          ? value.toUpperCase()
          : value;
    setPropertyRepair((current) => ({ ...current, [field]: nextValue }));
    const fieldKey =
      field === "buildYear" || field === "unitCount"
        ? `property.${field}`
        : `property.${field}`;
    clearCreateGateMissingKeys([fieldKey]);
  };

  const renderCreateFieldError = (fieldKey: string) =>
    isCreate && createRequirementErrors.has(fieldKey) ? (
      <p className="text-xs text-red-600">{createRequirementErrors.get(fieldKey)}</p>
    ) : null;

  const resetNewContact = () => {
    setNewContact({
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      jobTitle: "",
      category: "client",
    });
    setContactError(null);
  };

  const handleCreatePrimaryContact = async () => {
    if (!companyId) {
      setContactError("Select a company before adding a contact.");
      return;
    }
    if (!newContact.firstName.trim() || !newContact.lastName.trim()) {
      setContactError("First name and last name are required.");
      return;
    }
    if (newContact.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newContact.email.trim())) {
      setContactError("Enter a valid email address.");
      return;
    }
    const phoneValidationError = getPhoneValidationError(newContact.phone);
    if (phoneValidationError) {
      setContactError(phoneValidationError);
      return;
    }

    setContactSubmitting(true);
    setContactError(null);
    try {
      const result = await createContact(
        {
          firstName: newContact.firstName.trim(),
          lastName: newContact.lastName.trim(),
          email: newContact.email.trim() || null,
          phone: newContact.phone.trim() || null,
          jobTitle: newContact.jobTitle.trim() || null,
          category: newContact.category,
          companyId,
          skipDedupCheck: true,
        },
        { officeId: isCreate ? selectedOffice?.officeId : null }
      );

      if (!result.contact) {
        throw new Error("Contact was not created.");
      }

      await refetchContacts();
      handleFieldChange("primaryContactId", result.contact.id);
      setContactDialogOpen(false);
      resetNewContact();
    } catch (err) {
      setContactError(err instanceof Error ? err.message : "Failed to create contact.");
    } finally {
      setContactSubmitting(false);
    }
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
    input: "text" | "textarea" | "number" | "boolean" | "multiselect",
    value: string | string[]
  ) => {
    let nextValue: LeadAnswerValue = value;

    if (input === "number") {
      nextValue = typeof value === "string" && value.trim() === "" ? null : Number(value);
    }
    if (input === "boolean") {
      nextValue = value === "true";
    }
    if (input === "multiselect") {
      nextValue = Array.isArray(value) ? value : [];
    }

    setFormData((current) => ({
      ...current,
      projectTypeQuestionAnswers: {
        ...current.projectTypeQuestionAnswers,
        [questionId]: nextValue,
      },
    }));
    clearCreateGateMissingKeys([`leadQuestionAnswers.${questionId}`]);
  };

  const addClientProvidedDocs = (files: File[]) => {
    const invalidFile = files.find((file) => validateFileForUpload(file));
    if (invalidFile) {
      setError(validateFileForUpload(invalidFile));
      return;
    }
    setClientProvidedDocFiles((current) => [...current, ...files]);
    setFormData((current) => ({
      ...current,
      projectTypeQuestionAnswers: {
        ...current.projectTypeQuestionAnswers,
        [CLIENT_PROVIDED_DOCS_TAG]: "uploaded",
      },
    }));
    clearCreateGateMissingKeys([`leadQuestionAnswers.${CLIENT_PROVIDED_DOCS_TAG}`]);
  };

  const removeClientProvidedDoc = (index: number) => {
    setClientProvidedDocFiles((current) => {
      const nextFiles = current.filter((_, itemIndex) => itemIndex !== index);
      if (nextFiles.length === 0) {
        setFormData((form) => ({
          ...form,
          projectTypeQuestionAnswers: {
            ...form.projectTypeQuestionAnswers,
            [CLIENT_PROVIDED_DOCS_TAG]: null,
          },
        }));
      }
      return nextFiles;
    });
  };

  const uploadClientProvidedDocs = async (leadId: string) => {
    for (const file of clientProvidedDocFiles) {
      await uploadFile({
        file,
        leadId,
        category: inferClientProvidedDocsCategory(file),
        tags: [CLIENT_PROVIDED_DOCS_TAG],
      });
    }
    setClientProvidedDocFiles([]);
  };

  const renderClientProvidedDocsQuestion = (node: LeadQuestionnaireSnapshot["allNodes"][number]) => {
    if (node.key !== CLIENT_PROVIDED_DOCS_TAG) return null;
    return (
      <ClientProvidedDocsUploadField
        files={clientProvidedDocFiles}
        onAddFiles={addClientProvidedDocs}
        onRemoveFile={removeClientProvidedDoc}
        disabled={submitting}
      />
    );
  };

  const serializeLeadQuestionAnswer = (key: string, value: LeadAnswerValue | undefined): LeadAnswerValue => {
    if (key === CLIENT_PROVIDED_DOCS_TAG && value === "uploaded") {
      return null;
    }
    return value ?? null;
  };

  const handleV2QuestionAnswerChange = (questionKey: string, value: LeadAnswerValue) => {
    setFormData((current) => ({
      ...current,
      projectTypeQuestionAnswers: {
        ...current.projectTypeQuestionAnswers,
        [questionKey]: value,
      },
    }));
    clearCreateGateMissingKeys([`leadQuestionAnswers.${questionKey}`]);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const effectiveStageId = isCreate
      ? getNormalizedLeadCreationStageId(leadStages, formData.stageId)
      : formData.stageId;

    if (isCreate && createRequirementErrors.size > 0) {
      setError("Complete the required lead creation fields before creating a lead.");
      return;
    }

    if (!formData.companyId || !formData.propertyId || !formData.name.trim() || (!isCreate && !effectiveStageId)) {
      setError(isCreate ? "Company, property, and lead name are required." : "Company, property, lead name, and stage are required.");
      return;
    }

    if (!formData.sourceCategory) {
      setError("Source is required.");
      return;
    }

    if (!formData.assignedRepId) {
      setError("Sales rep is required.");
      return;
    }

    if (formData.sourceCategory === "Other" && !formData.sourceDetail.trim()) {
      setError("Source detail is required when Source is Other.");
      return;
    }

    if (isLegacyTimelineStatusValue(formData.qualificationPayload.timeline_status)) {
      setError(
        `Timeline Target Date holds a legacy value ("${formData.qualificationPayload.timeline_status.trim()}"). Pick a real date before saving.`
      );
      return;
    }

    if (isCreate && useV2Questionnaire) {
      const visibleCache = new Map<string, boolean>();
      const missingRequiredQuestions = v2VisibleQuestionNodes
        .filter((node) => node.isRequired && !isAnsweredQuestionValue(formData.projectTypeQuestionAnswers[node.key]))
        .map((node) => node.label);
      const missingRequiredQualificationQuestions = v2QuestionNodes
        .filter((node) => V2_QUALIFICATION_DUPLICATE_KEYS.has(node.key))
        .filter((node) => node.isRequired)
        .filter((node) => isVisibleQuestionNode(node.id, v2NodeById, formData.projectTypeQuestionAnswers, visibleCache))
        .filter((node) =>
          node.key === "timeline"
            ? !isAnsweredQuestionValue(formData.qualificationPayload.timeline_status)
            : true
        )
        .map((node) => V2_QUALIFICATION_DUPLICATE_LABELS.get(node.key) ?? node.label);
      missingRequiredQuestions.push(...missingRequiredQualificationQuestions);

      if (missingRequiredQuestions.length > 0) {
        setError(`Answer required project intake questions: ${missingRequiredQuestions.join(", ")}`);
        return;
      }
    }

    setSubmitting(true);
    setError(null);
    setStageGateError(null);

    try {
      const normalizedTimelineStatus = normalizeTimelineStatusForSave(formData.qualificationPayload.timeline_status);
      const workflowPayload = {
        projectTypeId: formData.projectTypeId || null,
        qualificationPayload: {
          existing_customer_status: null,
          estimated_value:
            formData.qualificationPayload.estimated_value.trim() === ""
              ? null
              : Number(formData.qualificationPayload.estimated_value),
          timeline_status: normalizedTimelineStatus,
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
              v2QuestionNodes.map((node) => [
                node.key,
                node.key === "timeline"
                  ? normalizedTimelineStatus
                  : serializeLeadQuestionAnswer(node.key, formData.projectTypeQuestionAnswers[node.key]),
              ])
            )
          : Object.fromEntries(
              questionSet.questions.map((question) => [
                question.id,
                formData.projectTypeQuestionAnswers[question.id] ?? null,
              ])
            ),
      };

      if (isCreate) {
        if (!selectedOffice?.officeId) {
          setError("Cannot create lead: selected office is unavailable. Contact admin.");
          return;
        }

        if (
          selectedProperty &&
          (propertyAddressNeedsRepair ||
            propertyCityNeedsRepair ||
            propertyStateNeedsRepair ||
            propertyZipNeedsRepair ||
            propertyBuildYearNeedsRepair ||
            propertyUnitCountNeedsRepair)
        ) {
          const propertyPatch: {
            address?: string;
            city?: string;
            state?: string;
            zip?: string;
            buildYear?: number;
            unitCount?: number;
          } = {};
          if (propertyAddressNeedsRepair && propertyRepair.address.trim()) {
            propertyPatch.address = propertyRepair.address.trim();
          }
          if (propertyCityNeedsRepair && propertyRepair.city.trim()) {
            propertyPatch.city = propertyRepair.city.trim();
          }
          if (propertyStateNeedsRepair && propertyRepair.state.trim()) {
            propertyPatch.state = propertyRepair.state.trim().toUpperCase();
          }
          if (propertyZipNeedsRepair && propertyRepair.zip.trim()) {
            propertyPatch.zip = propertyRepair.zip.trim();
          }
          if (propertyBuildYearNeedsRepair && propertyRepair.buildYear != null) {
            propertyPatch.buildYear = propertyRepair.buildYear;
          }
          if (propertyUnitCountNeedsRepair && propertyRepair.unitCount != null) {
            propertyPatch.unitCount = propertyRepair.unitCount;
          }

          try {
            const result = await updateProperty(selectedProperty.id, propertyPatch, { officeId: selectedOffice.officeId });
            setRepairedProperties((current) => new Map(current).set(result.property.id, result.property));
          } catch (err) {
            setError(`Failed to update property: ${err instanceof Error ? err.message : "Unknown error"}`);
            return;
          }
        }

        const result = await createLead(
          {
            companyId: formData.companyId,
            propertyId: formData.propertyId,
            primaryContactId: formData.primaryContactId || null,
            primaryContactRole: formData.primaryContactRole as LeadPocRole,
            primaryContactRoleOtherLabel: formData.primaryContactRoleOtherLabel.trim() || null,
            name: formData.name.trim(),
            assignedRepId: formData.assignedRepId,
            salesRepId: formData.assignedRepId,
            source: formData.source.trim() || null,
            sourceCategory: formData.sourceCategory as LeadSourceCategory,
            sourceDetail: formData.sourceDetail.trim() || null,
            description: formData.description.trim() || null,
            bidDueDate: formData.bidDueDate || null,
            budgetStatus: formData.budgetStatus as LeadBudgetStatus,
            officeCode: formData.officeCode,
            ...workflowPayload,
          },
          { officeId: selectedOffice.officeId }
        );

        await uploadClientProvidedDocs(result.lead.id);
        navigate(`/leads/${result.lead.id}`);
      } else if (lead) {
        await updateLead(lead.id, {
          source: formData.source.trim() || null,
          assignedRepId: formData.assignedRepId,
          salesRepId: formData.assignedRepId,
          sourceCategory: formData.sourceCategory as LeadSourceCategory,
          sourceDetail: formData.sourceDetail.trim() || null,
          description: formData.description.trim() || null,
          bidDueDate: formData.bidDueDate || null,
          ...workflowPayload,
        });
        await uploadClientProvidedDocs(lead.id);
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
      if (isApiError(err) && err.code === "LEAD_CREATE_REQUIREMENTS_UNMET") {
        const fields = (err.missingRequirements as { fields?: Array<{ key?: string }> } | undefined)?.fields ?? [];
        setCreateGateMissingKeys(fields.map((field) => field.key).filter((key): key is string => Boolean(key)));
        setError(err.message);
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
          <CardTitle>{isCreate ? "Lead Creation Requirements" : "Lead Qualification"}</CardTitle>
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
                <QuestionLabel required>Company</QuestionLabel>
                <CompanySelector
                  value={companyId}
                  onChange={setCompanyId}
                  officeId={selectedOffice?.officeId}
                  required
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <QuestionLabel htmlFor="propertyId" required>Project Address</QuestionLabel>
                  <PropertySelector
                    companyId={companyId}
                    value={formData.propertyId || null}
                    onChange={(propertyId) => handleFieldChange("propertyId", propertyId)}
                    officeId={selectedOffice?.officeId}
                    required
                    requireLeadCreateFields
                    onPropertyRepaired={(property) => {
                      setRepairedProperties((current) => new Map(current).set(property.id, property));
                    }}
                  />
                  {selectedProperty ? (
                    <p className="text-xs text-muted-foreground">
                      {formatPropertyLabel(selectedProperty)}
                      {selectedProperty.buildYear ? ` · Built ${selectedProperty.buildYear}` : ""}
                      {selectedProperty.unitCount ? ` · ${selectedProperty.unitCount} units` : ""}
                    </p>
                  ) : null}
                  {propertyAddressNeedsRepair ||
                  propertyCityNeedsRepair ||
                  propertyStateNeedsRepair ||
                  propertyZipNeedsRepair ||
                  propertyBuildYearNeedsRepair ||
                  propertyUnitCountNeedsRepair ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3">
                      <p className="text-sm font-medium text-amber-900">
                        This property is missing required information. Please provide:
                      </p>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        {propertyAddressNeedsRepair ? (
                          <div className="space-y-1">
                            <QuestionLabel htmlFor="property-repair-address" required>
                              Street Address
                            </QuestionLabel>
                            <Input
                              id="property-repair-address"
                              value={propertyRepair.address}
                              onChange={(event) => handlePropertyRepairChange("address", event.target.value)}
                              required
                            />
                            {renderCreateFieldError("property.address")}
                          </div>
                        ) : null}
                        {propertyCityNeedsRepair ? (
                          <div className="space-y-1">
                            <QuestionLabel htmlFor="property-repair-city" required>
                              City
                            </QuestionLabel>
                            <Input
                              id="property-repair-city"
                              value={propertyRepair.city}
                              onChange={(event) => handlePropertyRepairChange("city", event.target.value)}
                              required
                            />
                            {renderCreateFieldError("property.city")}
                          </div>
                        ) : null}
                        {propertyStateNeedsRepair ? (
                          <div className="space-y-1">
                            <QuestionLabel htmlFor="property-repair-state" required>
                              State
                            </QuestionLabel>
                            <Input
                              id="property-repair-state"
                              maxLength={2}
                              value={propertyRepair.state}
                              onChange={(event) => handlePropertyRepairChange("state", event.target.value)}
                              required
                            />
                            {renderCreateFieldError("property.state")}
                          </div>
                        ) : null}
                        {propertyZipNeedsRepair ? (
                          <div className="space-y-1">
                            <QuestionLabel htmlFor="property-repair-zip" required>
                              ZIP
                            </QuestionLabel>
                            <Input
                              id="property-repair-zip"
                              value={propertyRepair.zip}
                              onChange={(event) => handlePropertyRepairChange("zip", event.target.value)}
                              required
                            />
                            {renderCreateFieldError("property.zip")}
                          </div>
                        ) : null}
                        {propertyBuildYearNeedsRepair ? (
                          <div className="space-y-1">
                            <QuestionLabel htmlFor="property-repair-build-year" required>
                              Year Built
                            </QuestionLabel>
                            <Input
                              id="property-repair-build-year"
                              type="number"
                              min={1800}
                              max={maxPropertyBuildYear}
                              value={propertyRepair.buildYear ?? ""}
                              onChange={(event) => handlePropertyRepairChange("buildYear", event.target.value)}
                              required
                            />
                            {renderCreateFieldError("property.buildYear")}
                          </div>
                        ) : null}
                        {propertyUnitCountNeedsRepair ? (
                          <div className="space-y-1">
                            <QuestionLabel htmlFor="property-repair-unit-count" required>
                              Number of Units
                            </QuestionLabel>
                            <Input
                              id="property-repair-unit-count"
                              type="number"
                              min={1}
                              value={propertyRepair.unitCount ?? ""}
                              onChange={(event) => handlePropertyRepairChange("unitCount", event.target.value)}
                              required
                            />
                            {renderCreateFieldError("property.unitCount")}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {renderCreateFieldError("propertyId")}
                  {!propertyAddressNeedsRepair ? renderCreateFieldError("property.address") : null}
                  {!propertyCityNeedsRepair ? renderCreateFieldError("property.city") : null}
                  {!propertyStateNeedsRepair ? renderCreateFieldError("property.state") : null}
                  {!propertyZipNeedsRepair ? renderCreateFieldError("property.zip") : null}
                  {!propertyBuildYearNeedsRepair ? renderCreateFieldError("property.buildYear") : null}
                  {!propertyUnitCountNeedsRepair ? renderCreateFieldError("property.unitCount") : null}
                </div>

                <div className="space-y-2">
                  <QuestionLabel htmlFor="primaryContactId" required>Point of Contact</QuestionLabel>
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
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!companyId}
                    onClick={() => {
                      resetNewContact();
                      setContactDialogOpen(true);
                    }}
                  >
                    + Add new contact
                  </Button>
                  {renderCreateFieldError("primaryContactId")}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <QuestionLabel htmlFor="primaryContactRole" required>POC Role</QuestionLabel>
                  <Select
                    items={pocRoleSelectItems}
                    value={formData.primaryContactRole || "__none__"}
                    onValueChange={(value) =>
                      handleFieldChange("primaryContactRole", !value || value === "__none__" ? "" : value)
                    }
                  >
                    <SelectTrigger id="primaryContactRole">
                      <SelectValue>{selectedPocRoleLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Select POC role</SelectItem>
                      {LEAD_POC_ROLE_FORM_OPTIONS.map((role) => (
                        <SelectItem key={role} value={role}>
                          {LEAD_POC_ROLE_LABELS[role]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {renderCreateFieldError("primaryContactRole")}
                </div>
                {formData.primaryContactRole === "other" ? (
                  <div className="space-y-2">
                    <QuestionLabel htmlFor="primaryContactRoleOtherLabel" required>Other POC Role</QuestionLabel>
                    <Input
                      id="primaryContactRoleOtherLabel"
                      value={formData.primaryContactRoleOtherLabel}
                      onChange={(event) => handleFieldChange("primaryContactRoleOtherLabel", event.target.value)}
                    />
                    {renderCreateFieldError("primaryContactRoleOtherLabel")}
                  </div>
                ) : null}
              </div>

              <Dialog open={contactDialogOpen} onOpenChange={setContactDialogOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add Primary Contact</DialogTitle>
                    <DialogDescription>Create a contact for the selected company.</DialogDescription>
                  </DialogHeader>
                  {contactError ? (
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                      {contactError}
                    </div>
                  ) : null}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <QuestionLabel htmlFor="newContactFirstName" required>
                        First Name
                      </QuestionLabel>
                      <Input
                        id="newContactFirstName"
                        value={newContact.firstName}
                        onChange={(event) =>
                          setNewContact((current) => ({ ...current, firstName: event.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <QuestionLabel htmlFor="newContactLastName" required>
                        Last Name
                      </QuestionLabel>
                      <Input
                        id="newContactLastName"
                        value={newContact.lastName}
                        onChange={(event) =>
                          setNewContact((current) => ({ ...current, lastName: event.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="newContactEmail">Email</Label>
                      <Input
                        id="newContactEmail"
                        type="email"
                        value={newContact.email}
                        onChange={(event) =>
                          setNewContact((current) => ({ ...current, email: event.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="newContactPhone">Phone</Label>
                      <Input
                        id="newContactPhone"
                        value={newContact.phone}
                        onChange={(event) =>
                          setNewContact((current) => ({ ...current, phone: event.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="newContactTitle">Title</Label>
                      <Input
                        id="newContactTitle"
                        value={newContact.jobTitle}
                        onChange={(event) =>
                          setNewContact((current) => ({ ...current, jobTitle: event.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <QuestionLabel htmlFor="newContactCategory" required>
                        Category
                      </QuestionLabel>
                      <Select
                        value={newContact.category}
                        onValueChange={(value) =>
                          setNewContact((current) => ({ ...current, category: value || "client" }))
                        }
                      >
                        <SelectTrigger id="newContactCategory">
                          <SelectValue>
                            {CATEGORY_LABELS[newContact.category] ?? newContact.category}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {CONTACT_CATEGORIES.map((category) => (
                            <SelectItem key={category} value={category}>
                              {CATEGORY_LABELS[category] ?? category}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setContactDialogOpen(false);
                        resetNewContact();
                      }}
                    >
                      Cancel
                    </Button>
                    <Button type="button" disabled={contactSubmitting} onClick={handleCreatePrimaryContact}>
                      {contactSubmitting ? "Saving..." : "Save Contact"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <QuestionLabel htmlFor="name" required>Lead Name</QuestionLabel>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(event) => handleFieldChange("name", event.target.value)}
                    placeholder="e.g., Palm Villas exterior refresh"
                  />
                  {renderCreateFieldError("name")}
                </div>

                <div className="space-y-2">
                  <QuestionLabel htmlFor="budgetStatus" required>Budget Status</QuestionLabel>
                  <Select
                    items={budgetStatusSelectItems}
                    value={formData.budgetStatus || "__none__"}
                    onValueChange={(value) =>
                      handleFieldChange("budgetStatus", !value || value === "__none__" ? "" : value)
                    }
                  >
                    <SelectTrigger id="budgetStatus">
                      <SelectValue>{selectedBudgetStatusLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Select budget status</SelectItem>
                      {LEAD_BUDGET_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          {LEAD_BUDGET_STATUS_LABELS[status]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {renderCreateFieldError("budgetStatus")}
                </div>
              </div>

              <div className="space-y-2">
                <QuestionLabel htmlFor="assignedRepId" required>
                  Sales Rep
                </QuestionLabel>
                <Select
                  items={repSelectItems}
                  value={formData.assignedRepId}
                  onValueChange={(value) => handleFieldChange("assignedRepId", value ?? "")}
                  disabled={user?.role === "rep"}
                >
                  <SelectTrigger id="assignedRepId">
                    <SelectValue>{selectedRepLabel}</SelectValue>
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

                <div className="space-y-4">
                  <div className="space-y-2">
                    <QuestionLabel htmlFor="officeCode" required>Office</QuestionLabel>
                    <Select
                      items={officeOptions.map((office) => ({ value: office.code, label: office.label }))}
                      value={formData.officeCode || "__none__"}
                      onValueChange={(value) =>
                        handleFieldChange("officeCode", !value || value === "__none__" ? "" : value)
                      }
                    >
                      <SelectTrigger id="officeCode">
                        <SelectValue>{selectedOfficeLabel}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {officeOptions.length === 0 ? (
                          <SelectItem value="__none__" disabled>
                            No offices available
                          </SelectItem>
                        ) : (
                          officeOptions.map((office: OfficeSelectionOption) => (
                            <SelectItem key={office.code} value={office.code}>
                              {office.label}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    {renderCreateFieldError("officeCode")}
                  </div>

                  <div className="space-y-2">
                    <QuestionLabel htmlFor="projectTypeId" required>Project Type</QuestionLabel>
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
                    {renderCreateFieldError("projectTypeId")}
                  </div>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <QuestionLabel htmlFor="bidDueDate" required>Bid Due Date</QuestionLabel>
                  <Input
                    id="bidDueDate"
                    type="date"
                    value={formData.bidDueDate}
                    onChange={(event) => handleFieldChange("bidDueDate", event.target.value)}
                  />
                  {renderCreateFieldError("bidDueDate")}
                </div>
                {numberOfBiddersNode ? (
                  <div className="space-y-2">
                    <Label htmlFor="number_of_bidders">Number of Bidders</Label>
                    <Input
                      id="number_of_bidders"
                      type="number"
                      value={
                        typeof formData.projectTypeQuestionAnswers.number_of_bidders === "number"
                          ? String(formData.projectTypeQuestionAnswers.number_of_bidders)
                          : ""
                      }
                      onChange={(event) => handleQuestionAnswerChange("number_of_bidders", "number", event.target.value)}
                    />
                  </div>
                ) : null}
              </div>
              {formData.sourceCategory === "Other" ? (
                <div className="space-y-2">
                  <QuestionLabel htmlFor="sourceDetail" required>
                    Source detail
                  </QuestionLabel>
                  <Input
                    id="sourceDetail"
                    required
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
              <div>
                <p className="text-muted-foreground">POC Role</p>
                <p className="font-medium">
                  {formData.primaryContactRole
                    ? LEAD_POC_ROLE_LABELS[formData.primaryContactRole as LeadPocRole]
                    : "--"}
                </p>
              </div>
              {formData.primaryContactRole === "other" ? (
                <div>
                  <p className="text-muted-foreground">Other POC Role</p>
                  <p className="font-medium">{formData.primaryContactRoleOtherLabel || "--"}</p>
                </div>
              ) : null}
              <div>
                <p className="text-muted-foreground">Budget Status</p>
                <p className="font-medium">
                  {formData.budgetStatus
                    ? LEAD_BUDGET_STATUS_LABELS[formData.budgetStatus as LeadBudgetStatus]
                    : "--"}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bidDueDate">Bid Due Date</Label>
                <Input
                  id="bidDueDate"
                  type="date"
                  value={formData.bidDueDate}
                  onChange={(event) => handleFieldChange("bidDueDate", event.target.value)}
                />
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
                    required
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
            (field: { id: LeadQualificationFieldId; label: string; input: string }) => {
              const currentValue = formData.qualificationPayload[field.id] ?? "";
              const showLegacyHint =
                field.id === "timeline_status" && isLegacyTimelineStatusValue(currentValue);
              return (
                <div key={field.id} className="space-y-2">
                  <Label htmlFor={field.id}>{field.label}</Label>
                  {field.input === "date" ? (
                    <DateField
                      id={field.id}
                      value={currentValue}
                      onChange={(value) => handleQualificationChange(field.id, value)}
                    />
                  ) : field.id === "estimated_value" ? (
                    <CurrencyInput
                      id={field.id}
                      value={currentValue}
                      onChange={(value) => handleQualificationChange(field.id, value)}
                    />
                  ) : (
                    <Input
                      id={field.id}
                      type={field.input === "number" ? "number" : "text"}
                      value={currentValue}
                      onChange={(event) => handleQualificationChange(field.id, event.target.value)}
                    />
                  )}
                  {showLegacyHint ? (
                    <p className="text-xs text-amber-700">
                      Legacy value: <span className="font-medium">"{currentValue}"</span>. Pick a date to update.
                    </p>
                  ) : null}
                </div>
              );
            }
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{useV2Questionnaire ? "Project Questions" : questionSet.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {useV2Questionnaire
            ? (
                <LeadQuestionnaireSections
                  nodes={v2RenderedQuestionNodes}
                  answers={formData.projectTypeQuestionAnswers}
                  onAnswerChange={handleV2QuestionAnswerChange}
                  renderQuestionOverride={renderClientProvidedDocsQuestion}
                />
              )
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
                      <SelectItem value="__unanswered__">Select...</SelectItem>
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
        <Button type="submit" disabled={submitting || createSubmitDisabled}>
          {submitting
            ? "Saving..."
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
