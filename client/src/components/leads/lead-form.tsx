import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
import { CompanySelector } from "@/components/companies/company-selector";
import { LeadStageBadge } from "./lead-stage-badge";
import { useCompanyContacts } from "@/hooks/use-companies";
import { createLead, updateLead } from "@/hooks/use-leads";
import { usePipelineStages, useProjectTypes } from "@/hooks/use-pipeline-config";
import { formatPropertyLabel, useProperties } from "@/hooks/use-properties";
import {
  getValidationQuestionSetForProjectType,
  LEAD_QUALIFICATION_FIELDS,
} from "@/lib/validation-question-sets";
import { CRM_OWNED_LEAD_STAGE_SLUGS } from "@/lib/sales-workflow";

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
  description: string | null;
  projectTypeId?: string | null;
  qualificationPayload?: Record<string, LeadAnswerValue>;
  projectTypeQuestionPayload?: {
    projectTypeId: string | null;
    answers: Record<string, LeadAnswerValue>;
  };
  stageEnteredAt: string;
}

type LeadSummaryFormProps = {
  mode?: "summary";
  lead: LeadFormLead;
  converted?: boolean;
};

type LeadCreateFormProps = {
  mode: "create";
};

type LeadUpdateFormProps = {
  mode: "edit";
  lead: LeadFormLead;
};

type LeadFormProps = LeadSummaryFormProps | LeadCreateFormProps | LeadUpdateFormProps;

type LeadEditableMode = "create" | "edit";

function getEditableFormState(lead?: LeadFormLead) {
  return {
    companyId: lead?.companyId ?? "",
    propertyId: lead?.propertyId ?? "",
    primaryContactId: "",
    name: lead?.name ?? "",
    stageId: lead?.stageId ?? "",
    source: lead?.source ?? "",
    description: lead?.description ?? "",
    projectTypeId: lead?.projectTypeId ?? "",
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
    projectTypeQuestionAnswers: { ...(lead?.projectTypeQuestionPayload?.answers ?? {}) } as Record<
      string,
      LeadAnswerValue
    >,
  };
}

function renderAnswerValue(value: LeadAnswerValue | undefined) {
  if (value == null) {
    return "--";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "string") {
    return value.trim() || "--";
  }
  return String(value);
}

function SummaryLeadForm({ lead, converted = false }: LeadSummaryFormProps) {
  const navigate = useNavigate();
  const { projectTypes } = useProjectTypes();
  const propertyLabel = [lead.propertyAddress, [lead.propertyCity, lead.propertyState].filter(Boolean).join(", "), lead.propertyZip]
    .filter(Boolean)
    .join(" ") || lead.propertyName || "--";
  const projectType = projectTypes.find((entry) => entry.id === lead.projectTypeId) ?? null;
  const questionSet = getValidationQuestionSetForProjectType(projectType?.slug ?? null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Lead Summary</CardTitle>
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
            <p className="font-medium">{lead.source ?? "--"}</p>
          </div>
        </div>

        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          <p className="text-muted-foreground">Property</p>
          {lead.propertyId ? (
            <Link to={`/properties/${lead.propertyId}`} className="font-medium text-primary hover:underline">
              {propertyLabel || "--"}
            </Link>
          ) : (
            <p className="font-medium">{propertyLabel || "--"}</p>
          )}
        </div>

        {lead.description && (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{lead.description}</p>
        )}

        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-sm font-medium">Sales Validation</p>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            {LEAD_QUALIFICATION_FIELDS.map((field) => (
              <div key={field.id}>
                <p className="text-muted-foreground">{field.label}</p>
                <p className="font-medium">{renderAnswerValue(lead.qualificationPayload?.[field.id])}</p>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {questionSet.title}
            </p>
            <div className="grid gap-3 text-sm">
              {questionSet.questions.map((question) => (
                <div key={question.id}>
                  <p className="text-muted-foreground">{question.label}</p>
                  <p className="font-medium">
                    {renderAnswerValue(lead.projectTypeQuestionPayload?.answers?.[question.id])}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={converted && !lead.convertedDealId}
            onClick={() => navigate(converted ? `/deals/${lead.convertedDealId}` : "/deals/new")}
          >
            {converted ? "Open Deal" : "Convert to Deal"}
          </Button>
          {lead.companyId && (
            <Button variant="outline" onClick={() => navigate(`/companies/${lead.companyId}`)}>
              View Company
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          This lead surface is backed by the pre-RFP lead record and preserves its activity history through conversion.
        </p>
      </CardContent>
    </Card>
  );
}

function EditableLeadForm({ mode, lead }: { mode: LeadEditableMode; lead?: LeadFormLead }) {
  const navigate = useNavigate();
  const { stages } = usePipelineStages();
  const { projectTypes, hierarchy: projectTypeHierarchy } = useProjectTypes();
  const isCreate = mode === "create";
  const [companyId, setCompanyId] = useState<string | null>(lead?.companyId ?? null);
  const { properties } = useProperties(companyId ? { companyId, limit: 500 } : { limit: 0 });
  const { contacts } = useCompanyContacts(companyId ?? undefined);
  const leadStages = stages.filter(
    (stage) => CRM_OWNED_LEAD_STAGE_SLUGS.includes(stage.slug as (typeof CRM_OWNED_LEAD_STAGE_SLUGS)[number]) && !stage.isTerminal
  );

  const [formData, setFormData] = useState(() => getEditableFormState(lead));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFormData(getEditableFormState(lead));
    setCompanyId(lead?.companyId ?? null);
  }, [lead]);

  useEffect(() => {
    if (isCreate && !formData.stageId && leadStages.length > 0) {
      setFormData((current) => ({ ...current, stageId: leadStages[0].id }));
    }
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
          : "",
      primaryContactId:
        current.primaryContactId && contacts.some((contact) => contact.id === current.primaryContactId)
          ? current.primaryContactId
          : "",
    }));
  }, [companyId, contacts, isCreate, properties]);

  const selectedProjectType = projectTypes.find((entry) => entry.id === formData.projectTypeId) ?? null;
  const questionSet = useMemo(
    () => getValidationQuestionSetForProjectType(selectedProjectType?.slug ?? null),
    [selectedProjectType?.slug]
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

    if (!formData.companyId || !formData.propertyId || !formData.name.trim() || !formData.stageId) {
      setError("Company, property, lead name, and initial stage are required.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const payload = {
        projectTypeId: formData.projectTypeId || null,
        qualificationPayload: {
          existing_customer_status: formData.qualificationPayload.existing_customer_status.trim() || null,
          estimated_value:
            formData.qualificationPayload.estimated_value.trim() === ""
              ? null
              : Number(formData.qualificationPayload.estimated_value),
          timeline_status: formData.qualificationPayload.timeline_status.trim() || null,
        },
        projectTypeQuestionPayload: {
          projectTypeId: formData.projectTypeId || null,
          answers: Object.fromEntries(
            questionSet.questions.map((question) => [
              question.id,
              formData.projectTypeQuestionAnswers[question.id] ?? null,
            ])
          ),
        },
      };

      if (isCreate) {
        const result = await createLead({
          companyId: formData.companyId,
          propertyId: formData.propertyId,
          primaryContactId: formData.primaryContactId || null,
          name: formData.name.trim(),
          stageId: formData.stageId,
          source: formData.source.trim() || null,
          description: formData.description.trim() || null,
          ...payload,
        });

        navigate(`/leads/${result.lead.id}`);
      } else if (lead) {
        const result = await updateLead(lead.id, payload);
        navigate(`/leads/${result.lead.id}`);
      }
    } catch (err: unknown) {
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
          {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {isCreate ? (
            <>
              <div className="space-y-2">
                <Label>Company</Label>
                <CompanySelector value={companyId} onChange={setCompanyId} required />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="propertyId">Property</Label>
                  <Select
                    value={formData.propertyId || "__none__"}
                    onValueChange={(value) =>
                      handleFieldChange("propertyId", !value || value === "__none__" ? "" : value)
                    }
                  >
                    <SelectTrigger id="propertyId">
                      <SelectValue placeholder="Select property" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Select property</SelectItem>
                      {properties.map((property) => (
                        <SelectItem key={property.id} value={property.id}>
                          {formatPropertyLabel(property)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="primaryContactId">Primary Contact</Label>
                  <Select
                    value={formData.primaryContactId || "__none__"}
                    onValueChange={(value) =>
                      handleFieldChange("primaryContactId", !value || value === "__none__" ? "" : value)
                    }
                  >
                    <SelectTrigger id="primaryContactId">
                      <SelectValue placeholder="Optional" />
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
                    value={formData.stageId}
                    onValueChange={(value) => handleFieldChange("stageId", value ?? "")}
                  >
                    <SelectTrigger id="stageId">
                      <SelectValue placeholder="Select stage" />
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
                  <Label htmlFor="source">Source</Label>
                  <Input
                    id="source"
                    value={formData.source}
                    onChange={(event) => handleFieldChange("source", event.target.value)}
                    placeholder="Referral, inbound, repeat customer..."
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="projectTypeId">Project Type</Label>
                  <Select
                    value={formData.projectTypeId || "__none__"}
                    onValueChange={(value) =>
                      handleFieldChange("projectTypeId", !value || value === "__none__" ? "" : value)
                    }
                  >
                    <SelectTrigger id="projectTypeId">
                      <SelectValue placeholder="Select project type" />
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
            <>
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
                    value={formData.projectTypeId || "__none__"}
                    onValueChange={(value) =>
                      handleFieldChange("projectTypeId", !value || value === "__none__" ? "" : value)
                    }
                  >
                    <SelectTrigger id="projectTypeId">
                      <SelectValue placeholder="Select project type" />
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
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sales Validation Fields</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {LEAD_QUALIFICATION_FIELDS.map((field) => (
            <div key={field.id} className="space-y-2">
              <Label htmlFor={field.id}>{field.label}</Label>
              <Input
                id={field.id}
                type={field.input === "number" ? "number" : "text"}
                value={formData.qualificationPayload[field.id] ?? ""}
                onChange={(event) => handleQualificationChange(field.id, event.target.value)}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{questionSet.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {questionSet.questions.map((question) => {
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
                    value={
                      typeof currentValue === "boolean"
                        ? String(currentValue)
                        : "__unanswered__"
                    }
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
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving..." : isCreate ? "Create Lead" : "Save Qualification"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate(isCreate ? "/leads" : `/leads/${lead?.id}`)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function LeadForm(props: LeadFormProps) {
  if (props.mode === "create") {
    return <EditableLeadForm mode="create" />;
  }

  if (props.mode === "edit") {
    return <EditableLeadForm mode="edit" lead={props.lead} />;
  }

  return <SummaryLeadForm {...props} />;
}
