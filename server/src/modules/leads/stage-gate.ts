import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { companies, leads } from "@trock-crm/shared/schema";
import {
  LEAD_COMPANY_PREQUAL_FIELD_KEYS,
  LEAD_VALUE_ASSIGNMENT_FIELD_KEYS,
  WORKFLOW_GATE_FIELD_LABELS,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { getStageById } from "../pipeline/service.js";
import { computeExistingCustomerStatus } from "../companies/customer-status-service.js";
import { getLeadQualificationByLeadId } from "./qualification-service.js";
import {
  evaluateLeadQuestionGate,
  isLeadEditV2Enabled,
  type LeadQuestionGateMissing,
  type LeadQuestionAnswerValue,
} from "./questionnaire-service.js";

type TenantDb = NodePgDatabase<any>;

type LeadStageRecord = {
  id: string;
  name: string;
  slug: string;
  displayOrder?: number;
  isTerminal: boolean;
  isActivePipeline?: boolean;
};

type LeadSnapshot = {
  id: string;
  companyId: string | null;
  propertyId: string | null;
  source: string | null;
  sourceCategory?: string | null;
  projectTypeId?: string | null;
  qualificationPayload?: unknown;
};

type QualificationSnapshot = {
  estimatedOpportunityValue?: string | null;
  goDecision?: string | null;
  goDecisionNotes?: string | null;
  qualificationData?: Record<string, unknown>;
  scopingSubsetData?: Record<string, unknown>;
} | null;

export interface LeadStageGateResult {
  allowed: boolean;
  currentStage: LeadStageRecord;
  targetStage: LeadStageRecord;
  missingRequirements: {
    fields: string[];
    effectiveChecklist: {
      fields: Array<{
        key: string;
        label: string;
        satisfied: boolean;
        source: "stage";
      }>;
    };
  };
  blockReason?: string;
}

const LEAD_STAGE_REQUIREMENTS: Record<string, string[]> = {
  qualified_lead: [
    "source",
    "projectTypeId",
    "qualificationPayload.existing_customer_status",
  ],
  company_pre_qualified: [
    "companyId",
    "propertyId",
    "source",
    ...LEAD_COMPANY_PREQUAL_FIELD_KEYS,
  ],
  scoping_in_progress: [...LEAD_COMPANY_PREQUAL_FIELD_KEYS],
  pre_qual_value_assigned: [
    ...LEAD_COMPANY_PREQUAL_FIELD_KEYS,
    ...LEAD_VALUE_ASSIGNMENT_FIELD_KEYS,
  ],
  qualified_for_opportunity: ["goDecision", "goDecisionNotes"],
};

function fallbackLabel(field: string) {
  return field
    .replace(/^[^.]+\./, "")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (char) => char.toUpperCase());
}

function getFieldLabel(field: string) {
  return WORKFLOW_GATE_FIELD_LABELS[field as keyof typeof WORKFLOW_GATE_FIELD_LABELS] ?? fallbackLabel(field);
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

function getRequirementValue(
  lead: LeadSnapshot,
  qualification: QualificationSnapshot,
  field: string
) {
  if (field.startsWith("qualification.")) {
    return qualification?.qualificationData?.[field.slice("qualification.".length)];
  }

  if (field.startsWith("qualificationPayload.")) {
    const qualificationPayload =
      lead.qualificationPayload && typeof lead.qualificationPayload === "object"
        ? (lead.qualificationPayload as Record<string, unknown>)
        : null;
    return qualificationPayload?.[field.slice("qualificationPayload.".length)];
  }

  if (field.startsWith("scopingSubset.")) {
    return qualification?.scopingSubsetData?.[field.slice("scopingSubset.".length)];
  }

  if (field === "estimatedOpportunityValue") {
    return qualification?.estimatedOpportunityValue;
  }

  if (field === "goDecision") {
    return qualification?.goDecision;
  }

  if (field === "goDecisionNotes") {
    return qualification?.goDecisionNotes;
  }

  if (field === "source") {
    return lead.sourceCategory ?? lead.source;
  }

  return lead[field as keyof LeadSnapshot];
}

function normalizeQualificationSnapshot(
  qualification: Record<string, unknown> | null
): QualificationSnapshot {
  if (!qualification) {
    return null;
  }

  return {
    estimatedOpportunityValue:
      typeof qualification.estimatedOpportunityValue === "string"
        ? qualification.estimatedOpportunityValue
        : null,
    goDecision: typeof qualification.goDecision === "string" ? qualification.goDecision : null,
    goDecisionNotes:
      typeof qualification.goDecisionNotes === "string"
        ? qualification.goDecisionNotes
        : null,
    qualificationData:
      qualification.qualificationData &&
      typeof qualification.qualificationData === "object" &&
      !Array.isArray(qualification.qualificationData)
        ? (qualification.qualificationData as Record<string, unknown>)
        : {},
    scopingSubsetData:
      qualification.scopingSubsetData &&
      typeof qualification.scopingSubsetData === "object" &&
      !Array.isArray(qualification.scopingSubsetData)
        ? (qualification.scopingSubsetData as Record<string, unknown>)
        : {},
  };
}

function questionnaireFieldKey(rawKey: string): string {
  if (rawKey === "estimated_value" || rawKey === "timeline_status" || rawKey === "existing_customer_status") {
    return `qualificationPayload.${rawKey}`;
  }
  return `question.${rawKey}`;
}

function questionnaireFieldLabel(key: string): string {
  const known = WORKFLOW_GATE_FIELD_LABELS[key as keyof typeof WORKFLOW_GATE_FIELD_LABELS];
  if (known) return known;
  if (key === "company.verification_pending") {
    return "Company verification (pending approver review)";
  }
  if (key.startsWith("question.")) {
    return key
      .slice("question.".length)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (key.startsWith("qualificationPayload.")) {
    return key
      .slice("qualificationPayload.".length)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return getFieldLabel(key);
}

export function evaluateLeadStageGate(input: {
  lead: LeadSnapshot;
  qualification: QualificationSnapshot;
  currentStage: LeadStageRecord;
  targetStage: LeadStageRecord;
  userRole?: string;
  questionnaireGate?: LeadQuestionGateMissing | null;
  companyVerificationPending?: boolean;
}): LeadStageGateResult {
  const requiredFields = LEAD_STAGE_REQUIREMENTS[input.targetStage.slug] ?? [];
  const missingFields = requiredFields.filter(
    (field) =>
      !hasValue(
        getRequirementValue(
          input.lead,
          input.qualification,
          field
        )
      )
  );
  const blockedByApprovalRole =
    input.targetStage.slug === "qualified_for_opportunity" &&
    input.userRole !== "director" &&
    input.userRole !== "admin";

  const questionnaireMissingKeys: string[] = input.questionnaireGate
    ? [
        ...input.questionnaireGate.qualificationFields.map(questionnaireFieldKey),
        ...input.questionnaireGate.projectTypeQuestionIds.map(questionnaireFieldKey),
      ]
    : [];

  const companyVerificationKeys = input.companyVerificationPending
    ? ["company.verification_pending"]
    : [];

  const effectiveMissingFields = [
    ...missingFields,
    ...(blockedByApprovalRole ? ["approval.directorAdmin"] : []),
    ...questionnaireMissingKeys,
    ...companyVerificationKeys,
  ];

  // Render every checked item — missing AND satisfied — so the checklist UI
  // can paint a complete picture instead of only listing missing items.
  const checklistKeys = [
    ...requiredFields,
    ...(blockedByApprovalRole ? ["approval.directorAdmin"] : []),
    ...questionnaireMissingKeys,
    ...companyVerificationKeys,
  ];
  const seen = new Set<string>();
  const dedupedChecklistKeys = checklistKeys.filter((key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    allowed: effectiveMissingFields.length === 0,
    currentStage: input.currentStage,
    targetStage: input.targetStage,
    missingRequirements: {
      fields: effectiveMissingFields,
      effectiveChecklist: {
        fields: dedupedChecklistKeys.map((field) => ({
          key: field,
          label: questionnaireFieldLabel(field),
          satisfied: !effectiveMissingFields.includes(field),
          source: "stage" as const,
        })),
      },
    },
    blockReason:
      blockedByApprovalRole
        ? "Lead stage change requires director/admin approval"
        : effectiveMissingFields.length > 0
          ? "Lead stage change not allowed until required intake is complete"
          : undefined,
  };
}

export async function validateLeadStageGate(
  tenantDb: TenantDb,
  leadId: string,
  targetStageId: string,
  userRole: string,
  userId: string
) {
  const [lead] = await tenantDb.select().from(leads).where(eq(leads.id, leadId)).limit(1);

  if (!lead) {
    throw new AppError(404, "Lead not found");
  }

  if (userRole === "rep" && lead.assignedRepId !== userId) {
    throw new AppError(403, "You can only edit your own leads");
  }

  const [currentStage, targetStage, qualification] = await Promise.all([
    getStageById(lead.stageId, "lead"),
    getStageById(targetStageId, "lead"),
    getLeadQualificationByLeadId(tenantDb, leadId),
  ]);

  if (!currentStage || !targetStage) {
    throw new AppError(400, "Invalid lead stage ID");
  }

  const computedExistingCustomerStatus = lead.companyId
    ? await computeExistingCustomerStatus(tenantDb, lead.companyId, new Date(), {
        excludeLeadId: lead.id,
      })
    : null;
  const qualificationPayload =
    lead.qualificationPayload && typeof lead.qualificationPayload === "object"
      ? {
          ...(lead.qualificationPayload as Record<string, unknown>),
          existing_customer_status:
            computedExistingCustomerStatus?.status ??
            (lead.qualificationPayload as Record<string, unknown>).existing_customer_status,
        }
      : {
          existing_customer_status: computedExistingCustomerStatus?.status ?? null,
        };

  // Mirror the runtime V2 gate condition so preflight surfaces the same
  // missing items the actual move would, eliminating the "preflight green +
  // runtime red" contradiction in the modal.
  const v2GateApplies =
    isLeadEditV2Enabled() &&
    (
      (targetStage.slug === "sales_validation_stage" && currentStage.slug !== "sales_validation_stage") ||
      (currentStage.slug === "sales_validation_stage" &&
        (targetStage.displayOrder ?? 0) > (currentStage.displayOrder ?? 0))
    );

  let questionnaireGate: LeadQuestionGateMissing | null = null;
  if (v2GateApplies && lead.companyId) {
    questionnaireGate = await evaluateLeadQuestionGate(tenantDb, {
      leadId: lead.id,
      projectTypeId: lead.projectTypeId ?? null,
      qualificationPayload: qualificationPayload as Record<string, LeadQuestionAnswerValue>,
      existingCustomerStatus: computedExistingCustomerStatus?.status ?? null,
    });
  }

  // Block advancement past sales_validation while the linked company's
  // verification is still pending. Belt-and-suspenders for legacy leads
  // that got into sales_validation before PR1's verificationStatus gate
  // existed; new leads are already blocked at the qualified_lead boundary
  // by lead-level verificationStatus.
  const advancingPastSalesValidation =
    currentStage.slug === "sales_validation_stage" &&
    (targetStage.displayOrder ?? 0) > (currentStage.displayOrder ?? 0);

  let companyVerificationPending = false;
  if (advancingPastSalesValidation && lead.companyId) {
    const [companyRow] = await tenantDb
      .select({ status: companies.companyVerificationStatus })
      .from(companies)
      .where(eq(companies.id, lead.companyId))
      .limit(1);
    companyVerificationPending = companyRow?.status === "pending";
  }

  return evaluateLeadStageGate({
    lead: {
      ...lead,
      qualificationPayload,
    },
    qualification: normalizeQualificationSnapshot(
      qualification as Record<string, unknown> | null
    ),
    currentStage,
    targetStage,
    userRole,
    questionnaireGate,
    companyVerificationPending,
  });
}

export const preflightLeadStageCheck = validateLeadStageGate;
