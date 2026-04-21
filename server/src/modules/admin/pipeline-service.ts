import { eq, asc } from "drizzle-orm";
import { pipelineStageConfig } from "@trock-crm/shared/schema";
import {
  LEAD_QUALIFICATION_FIELD_KEYS,
  LEAD_SCOPING_SUBSET_FIELD_KEYS,
  OPPORTUNITY_GATE_FIELD_KEYS,
} from "../../../../shared/src/types/workflow-gates.js";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";

export const STAGE_GATE_ALLOWED_FIELDS = [
  "primaryContactId",
  "companyId",
  "projectTypeId",
  "regionId",
  "expectedCloseDate",
  "ddEstimate",
  "bidEstimate",
  "awardedAmount",
  "propertyAddress",
  "propertyCity",
  "propertyState",
  "propertyZip",
  "winProbability",
  "description",
  "estimatedOpportunityValue",
  "lostReasonId",
  "lostNotes",
  "lostCompetitor",
  ...LEAD_QUALIFICATION_FIELD_KEYS,
  ...LEAD_SCOPING_SUBSET_FIELD_KEYS,
  ...OPPORTUNITY_GATE_FIELD_KEYS,
] as const;

export const STAGE_GATE_ALLOWED_DOCUMENTS = [
  "photo",
  "contract",
  "rfp",
  "estimate",
  "change_order",
  "proposal",
  "permit",
  "inspection",
  "correspondence",
  "insurance",
  "warranty",
  "closeout",
  "other",
] as const;

export const STAGE_GATE_ALLOWED_APPROVALS = ["director", "admin"] as const;

export function normalizeStageGateValues(
  values: unknown,
  allowedValues: readonly string[],
  fieldName: "requiredFields" | "requiredDocuments" | "requiredApprovals"
): string[] {
  if (!Array.isArray(values)) {
    throw new AppError(400, `${fieldName} must be an array`);
  }

  const allowed = new Set(allowedValues);
  const normalized: string[] = [];

  for (const entry of values) {
    if (typeof entry !== "string") {
      throw new AppError(400, `${fieldName} entries must be strings`);
    }

    const trimmed = entry.trim();
    if (!trimmed) continue;

    if (!allowed.has(trimmed)) {
      throw new AppError(400, `Unknown ${fieldName} value: ${trimmed}`);
    }

    if (!normalized.includes(trimmed)) {
      normalized.push(trimmed);
    }
  }

  return normalized;
}

export async function listPipelineStages() {
  return db
    .select()
    .from(pipelineStageConfig)
    .orderBy(asc(pipelineStageConfig.displayOrder));
}

export async function updatePipelineStage(
  id: string,
  input: Partial<{
    name: string;
    color: string;
    staleThresholdDays: number | null;
    procoreStageMapping: string | null;
    requiredFields: string[];
    requiredDocuments: string[];
    requiredApprovals: string[];
    isActive: boolean;
  }>
) {
  const existing = await db
    .select({ id: pipelineStageConfig.id, isTerminal: pipelineStageConfig.isTerminal })
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.id, id))
    .limit(1);

  if (!existing[0]) throw new AppError(404, "Pipeline stage not found");

  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.color !== undefined) updates.color = input.color;
  if (input.staleThresholdDays !== undefined) updates.staleThresholdDays = input.staleThresholdDays;
  if (input.procoreStageMapping !== undefined) updates.procoreStageMapping = input.procoreStageMapping;
  if (input.requiredFields !== undefined) {
    updates.requiredFields = normalizeStageGateValues(
      input.requiredFields,
      STAGE_GATE_ALLOWED_FIELDS,
      "requiredFields"
    );
  }
  if (input.requiredDocuments !== undefined) {
    updates.requiredDocuments = normalizeStageGateValues(
      input.requiredDocuments,
      STAGE_GATE_ALLOWED_DOCUMENTS,
      "requiredDocuments"
    );
  }
  if (input.requiredApprovals !== undefined) {
    updates.requiredApprovals = normalizeStageGateValues(
      input.requiredApprovals,
      STAGE_GATE_ALLOWED_APPROVALS,
      "requiredApprovals"
    );
  }

  if (Object.keys(updates).length === 0) {
    return existing[0];
  }

  const [updated] = await db
    .update(pipelineStageConfig)
    .set(updates)
    .where(eq(pipelineStageConfig.id, id))
    .returning();

  return updated;
}

/** Reorder stages by providing ordered array of stage IDs. */
export async function reorderPipelineStages(orderedIds: string[]) {
  for (let i = 0; i < orderedIds.length; i++) {
    await db
      .update(pipelineStageConfig)
      .set({ displayOrder: i + 1 })
      .where(eq(pipelineStageConfig.id, orderedIds[i]));
  }
}
