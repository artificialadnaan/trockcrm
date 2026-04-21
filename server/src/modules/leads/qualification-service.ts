import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { leadQualification } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<any>;

function normalizeNumericInput(value: string | null | undefined, label: string) {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/[$,\s]/g, "");
  const numericValue = Number(normalized);
  if (!Number.isFinite(numericValue)) {
    throw new AppError(400, `${label} must be a valid number`);
  }

  return numericValue.toFixed(2);
}

export interface LeadQualificationPatch {
  estimatedOpportunityValue?: string | null;
  goDecision?: "go" | "no_go" | null;
  goDecisionNotes?: string | null;
  qualificationData?: Record<string, unknown>;
  scopingSubsetData?: Record<string, unknown>;
  disqualificationReason?: string | null;
  disqualificationNotes?: string | null;
}

export async function getLeadQualificationByLeadId(
  tenantDb: TenantDb,
  leadId: string
) {
  const [record] = await tenantDb
    .select()
    .from(leadQualification)
    .where(eq(leadQualification.leadId, leadId))
    .limit(1);

  return record ?? null;
}

export async function upsertLeadQualification(
  tenantDb: TenantDb,
  leadId: string,
  patch: LeadQualificationPatch
) {
  const existing = await getLeadQualificationByLeadId(tenantDb, leadId);
  const now = new Date();
  const nextQualificationData = {
    ...(existing?.qualificationData ?? {}),
    ...(patch.qualificationData ?? {}),
  };
  const nextScopingSubsetData = {
    ...(existing?.scopingSubsetData ?? {}),
    ...(patch.scopingSubsetData ?? {}),
  };
  const normalizedEstimatedOpportunityValue =
    patch.estimatedOpportunityValue !== undefined
      ? normalizeNumericInput(patch.estimatedOpportunityValue, "Estimated opportunity value")
      : undefined;

  if (existing) {
    const [updated] = await tenantDb
      .update(leadQualification)
      .set({
        estimatedOpportunityValue:
          normalizedEstimatedOpportunityValue ?? existing.estimatedOpportunityValue,
        goDecision: patch.goDecision ?? existing.goDecision,
        goDecisionNotes: patch.goDecisionNotes ?? existing.goDecisionNotes,
        qualificationData: nextQualificationData,
        scopingSubsetData: nextScopingSubsetData,
        disqualificationReason:
          patch.disqualificationReason ?? existing.disqualificationReason,
        disqualificationNotes:
          patch.disqualificationNotes ?? existing.disqualificationNotes,
        updatedAt: now,
      })
      .where(eq(leadQualification.id, existing.id))
      .returning();

    return updated ?? null;
  }

  const [created] = await tenantDb
    .insert(leadQualification)
    .values({
      leadId,
      estimatedOpportunityValue: normalizedEstimatedOpportunityValue ?? null,
      goDecision: patch.goDecision ?? null,
      goDecisionNotes: patch.goDecisionNotes ?? null,
      qualificationData: nextQualificationData,
      scopingSubsetData: nextScopingSubsetData,
      disqualificationReason: patch.disqualificationReason ?? null,
      disqualificationNotes: patch.disqualificationNotes ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return created ?? null;
}
