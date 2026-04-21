import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { leads } from "@trock-crm/shared/schema";
import {
  LEAD_COMPANY_PREQUAL_FIELD_KEYS,
  LEAD_SCOPING_SUBSET_FIELD_KEYS,
  LEAD_VALUE_ASSIGNMENT_FIELD_KEYS,
  WORKFLOW_GATE_FIELD_LABELS,
} from "../../../../shared/src/types/workflow-gates.js";
import { AppError } from "../../middleware/error-handler.js";
import { getStageById } from "../pipeline/service.js";
import { getLeadQualificationByLeadId } from "./qualification-service.js";

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
  lead_go_no_go: ["estimatedOpportunityValue"],
  qualified_for_opportunity: [
    "goDecision",
    "goDecisionNotes",
    ...LEAD_SCOPING_SUBSET_FIELD_KEYS,
  ],
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

export function evaluateLeadStageGate(input: {
  lead: LeadSnapshot;
  qualification: QualificationSnapshot;
  currentStage: LeadStageRecord;
  targetStage: LeadStageRecord;
}): LeadStageGateResult {
  const requiredFields = LEAD_STAGE_REQUIREMENTS[input.targetStage.slug] ?? [];
  const missingFields = requiredFields.filter(
    (field) => !hasValue(getRequirementValue(input.lead, input.qualification, field))
  );

  return {
    allowed: missingFields.length === 0,
    currentStage: input.currentStage,
    targetStage: input.targetStage,
    missingRequirements: {
      fields: missingFields,
      effectiveChecklist: {
        fields: requiredFields.map((field) => ({
          key: field,
          label: getFieldLabel(field),
          satisfied: !missingFields.includes(field),
          source: "stage" as const,
        })),
      },
    },
    blockReason:
      missingFields.length > 0 ? "Lead stage change not allowed until required intake is complete" : undefined,
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

  return evaluateLeadStageGate({
    lead,
    qualification: normalizeQualificationSnapshot(
      qualification as Record<string, unknown> | null
    ),
    currentStage,
    targetStage,
  });
}

export const preflightLeadStageCheck = validateLeadStageGate;
