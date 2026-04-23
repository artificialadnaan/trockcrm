import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { files, leadScopingIntake } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { LeadScopingReadiness, LeadScopingSectionData } from "@trock-crm/shared/types";
import { evaluateLeadScopingReadiness } from "./scoping-rules.js";

type TenantDb = NodePgDatabase<typeof schema>;

function normalizeSectionData(value: unknown): LeadScopingSectionData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as LeadScopingSectionData;
}

function mergeSectionData(
  existing: LeadScopingSectionData,
  patch: LeadScopingSectionData
): LeadScopingSectionData {
  const merged: LeadScopingSectionData = { ...existing };

  for (const [sectionKey, sectionPatch] of Object.entries(patch)) {
    if (!sectionPatch || typeof sectionPatch !== "object" || Array.isArray(sectionPatch)) {
      continue;
    }
    const currentSection =
      existing[sectionKey as keyof LeadScopingSectionData] &&
      typeof existing[sectionKey as keyof LeadScopingSectionData] === "object" &&
      !Array.isArray(existing[sectionKey as keyof LeadScopingSectionData])
        ? (existing[sectionKey as keyof LeadScopingSectionData] as Record<string, unknown>)
        : {};

    merged[sectionKey as keyof LeadScopingSectionData] = {
      ...currentSection,
      ...(sectionPatch as Record<string, unknown>),
    };
  }

  return merged;
}

async function listLinkedAttachmentKeys(tenantDb: TenantDb, leadId: string): Promise<string[]> {
  const rows = await tenantDb
    .select()
    .from(files)
    .where(
      and(
        eq(files.leadId, leadId),
        eq(files.intakeSource, "lead_scoping_intake"),
        eq(files.isActive, true)
      )
    );

  return rows
    .filter(
      (row) =>
        row.leadId === leadId &&
        row.intakeSource === "lead_scoping_intake" &&
        row.isActive === true &&
        typeof row.intakeRequirementKey === "string" &&
        row.intakeRequirementKey.length > 0
    )
    .map((row) => row.intakeRequirementKey as string);
}

export async function getLeadScopingIntakeByLeadId(tenantDb: TenantDb, leadId: string) {
  const rows = await tenantDb
    .select()
    .from(leadScopingIntake)
    .where(eq(leadScopingIntake.leadId, leadId))
    .limit(1);

  return rows.find((row) => row.leadId === leadId) ?? null;
}

export async function getLeadScopingSnapshot(
  tenantDb: TenantDb,
  leadId: string
): Promise<{
  intake: Awaited<ReturnType<typeof getLeadScopingIntakeByLeadId>>;
  readiness: LeadScopingReadiness;
}> {
  const [intake, linkedAttachmentKeys] = await Promise.all([
    getLeadScopingIntakeByLeadId(tenantDb, leadId),
    listLinkedAttachmentKeys(tenantDb, leadId),
  ]);

  const readiness = evaluateLeadScopingReadiness({
    sectionData: normalizeSectionData(intake?.sectionData),
    linkedAttachmentKeys,
  });

  return { intake, readiness };
}

export async function upsertLeadScopingIntake(
  tenantDb: TenantDb,
  input: {
    leadId: string;
    officeId: string;
    userId: string;
    sectionData: LeadScopingSectionData;
  }
) {
  const existing = await getLeadScopingIntakeByLeadId(tenantDb, input.leadId);
  const now = new Date();
  const nextSectionData = mergeSectionData(
    normalizeSectionData(existing?.sectionData),
    normalizeSectionData(input.sectionData)
  );
  const linkedAttachmentKeys = await listLinkedAttachmentKeys(tenantDb, input.leadId);
  const readiness = evaluateLeadScopingReadiness({
    sectionData: nextSectionData,
    linkedAttachmentKeys,
  });

  if (existing) {
    const [updated] = await tenantDb
      .update(leadScopingIntake)
      .set({
        officeId: input.officeId,
        status: readiness.status,
        sectionData: nextSectionData,
        completionState: readiness.completionState,
        readinessErrors: readiness.errors,
        firstReadyAt: existing.firstReadyAt ?? (readiness.isReadyForGoNoGo ? now : null),
        lastAutosavedAt: now,
        lastEditedBy: input.userId,
        updatedAt: now,
      })
      .where(eq(leadScopingIntake.id, existing.id))
      .returning();

    return { intake: updated ?? null, readiness };
  }

  const [created] = await tenantDb
    .insert(leadScopingIntake)
    .values({
      leadId: input.leadId,
      officeId: input.officeId,
      status: readiness.status,
      sectionData: nextSectionData,
      completionState: readiness.completionState,
      readinessErrors: readiness.errors,
      firstReadyAt: readiness.isReadyForGoNoGo ? now : null,
      completedAt: null,
      lastAutosavedAt: now,
      createdBy: input.userId,
      lastEditedBy: input.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return { intake: created ?? null, readiness };
}
