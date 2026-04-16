// server/src/modules/migration/service.ts

import { eq, and, inArray, desc, sql } from "drizzle-orm";
import {
  stagedDeals,
  stagedContacts,
  stagedActivities,
  stagedCompanies,
  stagedProperties,
  stagedLeads,
  importRuns,
} from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  assertNoUnresolvedMigrationBucket,
  getMigrationExceptionGroups,
} from "./exception-service.js";
import { getValidationStats } from "./validator.js";

// ---------------------------------------------------------------------------
// Import runs
// ---------------------------------------------------------------------------

export async function getImportRuns() {
  return db
    .select()
    .from(importRuns)
    .orderBy(desc(importRuns.startedAt))
    .limit(20);
}

export async function createImportRun(
  type: "extract" | "validate" | "promote",
  runBy: string
) {
  const [row] = await db
    .insert(importRuns)
    .values({
      type,
      status: "running",
      stats: {},
      runBy,
      startedAt: new Date(),
    })
    .returning();
  return row;
}

export async function completeImportRun(
  runId: string,
  stats: Record<string, unknown>,
  errorLog?: string
) {
  await db
    .update(importRuns)
    .set({
      status: errorLog ? "failed" : "completed",
      stats,
      errorLog: errorLog ?? null,
      completedAt: new Date(),
    })
    .where(eq(importRuns.id, runId));
}

// ---------------------------------------------------------------------------
// Staged deals — list and update
// ---------------------------------------------------------------------------

export interface StagedDealFilter {
  validationStatus?: string;
  page?: number;
  limit?: number;
}

function buildQueueValidationWhere<T extends { validationStatus: unknown }>(
  column: T,
  validationStatus?: string
) {
  if (!validationStatus) return undefined;
  if (validationStatus === "unresolved") {
    return inArray((column as any).validationStatus, ["needs_review", "invalid"] as any[]);
  }
  return eq((column as any).validationStatus, validationStatus as any);
}

export async function listStagedDeals(filter: StagedDealFilter = {}) {
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = ((filter.page ?? 1) - 1) * limit;

  const where = filter.validationStatus
    ? eq(stagedDeals.validationStatus, filter.validationStatus as any)
    : undefined;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(stagedDeals)
      .where(where)
      .orderBy(desc(stagedDeals.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(stagedDeals)
      .where(where),
  ]);

  return { rows, total: countResult[0]?.count ?? 0 };
}

export async function approveStagedDeal(dealId: string, reviewedBy: string) {
  const [row] = await db
    .select({ validationStatus: stagedDeals.validationStatus })
    .from(stagedDeals)
    .where(eq(stagedDeals.id, dealId))
    .limit(1);

  if (!row) throw new AppError(404, "Staged deal not found");
  if (row.validationStatus === "promoted") {
    throw new AppError(400, "Deal already promoted");
  }
  if (["invalid", "duplicate", "orphan"].includes(row.validationStatus)) {
    throw new AppError(400, "Deal still has unresolved validation issues");
  }

  await db
    .update(stagedDeals)
    .set({ validationStatus: "approved", reviewedBy })
    .where(eq(stagedDeals.id, dealId));
}

export async function rejectStagedDeal(
  dealId: string,
  reviewedBy: string,
  reviewNotes?: string
) {
  await db
    .update(stagedDeals)
    .set({ validationStatus: "rejected", reviewedBy, reviewNotes: reviewNotes ?? null })
    .where(eq(stagedDeals.id, dealId));
}

export async function batchApproveStagedDeals(
  dealIds: string[],
  reviewedBy: string
) {
  if (dealIds.length === 0) return 0;
  const result = await db
    .update(stagedDeals)
    .set({ validationStatus: "approved", reviewedBy })
    .where(
      and(
        inArray(stagedDeals.id, dealIds),
        inArray(stagedDeals.validationStatus, ["valid", "needs_review"] as any[])
      )
  );
  return (result as any).rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Staged companies — list and update
// ---------------------------------------------------------------------------

export async function listStagedCompanies(filter: StagedDealFilter = {}) {
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = ((filter.page ?? 1) - 1) * limit;

  const where = buildQueueValidationWhere(stagedCompanies, filter.validationStatus);

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(stagedCompanies)
      .where(where)
      .orderBy(desc(stagedCompanies.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(stagedCompanies)
      .where(where),
  ]);

  return { rows, total: countResult[0]?.count ?? 0 };
}

export async function approveStagedCompany(companyId: string, reviewedBy: string) {
  const [row] = await db
    .select({ validationStatus: stagedCompanies.validationStatus, exceptionBucket: stagedCompanies.exceptionBucket })
    .from(stagedCompanies)
    .where(eq(stagedCompanies.id, companyId))
    .limit(1);

  if (!row) throw new AppError(404, "Staged company not found");
  assertNoUnresolvedMigrationBucket({
    entityType: "company",
    validationStatus: row.validationStatus,
    exceptionBucket: row.exceptionBucket as any,
  });

  await db
    .update(stagedCompanies)
    .set({ validationStatus: "approved", reviewedBy })
    .where(eq(stagedCompanies.id, companyId));
}

export async function rejectStagedCompany(
  companyId: string,
  reviewedBy: string,
  reviewNotes?: string
) {
  await db
    .update(stagedCompanies)
    .set({
      validationStatus: "rejected",
      reviewedBy,
      reviewNotes: reviewNotes ?? null,
    })
    .where(eq(stagedCompanies.id, companyId));
}

// ---------------------------------------------------------------------------
// Staged properties — list and update
// ---------------------------------------------------------------------------

export async function listStagedProperties(filter: StagedDealFilter = {}) {
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = ((filter.page ?? 1) - 1) * limit;

  const where = buildQueueValidationWhere(stagedProperties, filter.validationStatus);

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(stagedProperties)
      .where(where)
      .orderBy(desc(stagedProperties.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(stagedProperties)
      .where(where),
  ]);

  return { rows, total: countResult[0]?.count ?? 0 };
}

export async function approveStagedProperty(propertyId: string, reviewedBy: string) {
  const [row] = await db
    .select({ validationStatus: stagedProperties.validationStatus, exceptionBucket: stagedProperties.exceptionBucket })
    .from(stagedProperties)
    .where(eq(stagedProperties.id, propertyId))
    .limit(1);

  if (!row) throw new AppError(404, "Staged property not found");
  assertNoUnresolvedMigrationBucket({
    entityType: "property",
    validationStatus: row.validationStatus,
    exceptionBucket: row.exceptionBucket as any,
  });

  await db
    .update(stagedProperties)
    .set({ validationStatus: "approved", reviewedBy })
    .where(eq(stagedProperties.id, propertyId));
}

export async function rejectStagedProperty(
  propertyId: string,
  reviewedBy: string,
  reviewNotes?: string
) {
  await db
    .update(stagedProperties)
    .set({
      validationStatus: "rejected",
      reviewedBy,
      reviewNotes: reviewNotes ?? null,
    })
    .where(eq(stagedProperties.id, propertyId));
}

// ---------------------------------------------------------------------------
// Staged leads — list and update
// ---------------------------------------------------------------------------

export async function listStagedLeads(filter: StagedDealFilter = {}) {
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = ((filter.page ?? 1) - 1) * limit;

  const where = buildQueueValidationWhere(stagedLeads, filter.validationStatus);

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(stagedLeads)
      .where(where)
      .orderBy(desc(stagedLeads.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(stagedLeads)
      .where(where),
  ]);

  return { rows, total: countResult[0]?.count ?? 0 };
}

export async function approveStagedLead(leadId: string, reviewedBy: string) {
  const [row] = await db
    .select({ validationStatus: stagedLeads.validationStatus, exceptionBucket: stagedLeads.exceptionBucket })
    .from(stagedLeads)
    .where(eq(stagedLeads.id, leadId))
    .limit(1);

  if (!row) throw new AppError(404, "Staged lead not found");
  assertNoUnresolvedMigrationBucket({
    entityType: "lead",
    validationStatus: row.validationStatus,
    exceptionBucket: row.exceptionBucket as any,
  });

  await db
    .update(stagedLeads)
    .set({ validationStatus: "approved", reviewedBy })
    .where(eq(stagedLeads.id, leadId));
}

export async function rejectStagedLead(
  leadId: string,
  reviewedBy: string,
  reviewNotes?: string
) {
  await db
    .update(stagedLeads)
    .set({
      validationStatus: "rejected",
      reviewedBy,
      reviewNotes: reviewNotes ?? null,
    })
    .where(eq(stagedLeads.id, leadId));
}

// ---------------------------------------------------------------------------
// Staged contacts — list and update
// ---------------------------------------------------------------------------

export async function listStagedContacts(
  filter: { validationStatus?: string; page?: number; limit?: number } = {}
) {
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = ((filter.page ?? 1) - 1) * limit;

  const where = filter.validationStatus
    ? eq(stagedContacts.validationStatus, filter.validationStatus as any)
    : undefined;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(stagedContacts)
      .where(where)
      .orderBy(desc(stagedContacts.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(stagedContacts)
      .where(where),
  ]);

  return { rows, total: countResult[0]?.count ?? 0 };
}

export async function approveStagedContact(contactId: string, reviewedBy: string) {
  const [row] = await db
    .select({
      validationStatus: stagedContacts.validationStatus,
      duplicateOfStagedId: stagedContacts.duplicateOfStagedId,
      duplicateOfLiveId: stagedContacts.duplicateOfLiveId,
    })
    .from(stagedContacts)
    .where(eq(stagedContacts.id, contactId))
    .limit(1);

  if (!row) throw new AppError(404, "Staged contact not found");
  if (
    ["invalid", "duplicate", "orphan"].includes(row.validationStatus) ||
    row.duplicateOfStagedId ||
    row.duplicateOfLiveId
  ) {
    throw new AppError(400, "Contact still has unresolved validation issues");
  }

  await db
    .update(stagedContacts)
    .set({ validationStatus: "approved", reviewedBy })
    .where(eq(stagedContacts.id, contactId));
}

export async function rejectStagedContact(
  contactId: string,
  reviewedBy: string,
  notes?: string
) {
  await db
    .update(stagedContacts)
    .set({
      validationStatus: "rejected",
      reviewedBy,
      reviewNotes: notes ?? null,
    })
    .where(eq(stagedContacts.id, contactId));
}

export async function mergeStagedContact(
  contactId: string,
  mergeTargetId: string,
  reviewedBy: string
) {
  await db
    .update(stagedContacts)
    .set({
      validationStatus: "merged",
      mergeTargetId,
      reviewedBy,
    })
    .where(eq(stagedContacts.id, contactId));
}

export async function batchApproveStagedContacts(
  contactIds: string[],
  reviewedBy: string
) {
  if (contactIds.length === 0) return 0;
  const result = await db
    .update(stagedContacts)
    .set({ validationStatus: "approved", reviewedBy })
    .where(
      and(
        inArray(stagedContacts.id, contactIds),
        inArray(stagedContacts.validationStatus, ["valid", "needs_review"] as any[])
      )
    );
  return (result as any).rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------------

export async function getMigrationSummary() {
  const [validationStats, recentRuns] = await Promise.all([
    getValidationStats(),
    db
      .select()
      .from(importRuns)
      .orderBy(desc(importRuns.startedAt))
      .limit(5),
  ]);

  return {
    deals: validationStats.deals,
    contacts: validationStats.contacts,
    activities: validationStats.activities,
    companies: validationStats.companies,
    properties: validationStats.properties,
    leads: validationStats.leads,
    recentRuns,
  };
}

export async function getMigrationExceptions() {
  const groups = await getMigrationExceptionGroups();
  return { groups };
}
