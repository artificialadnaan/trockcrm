// server/src/modules/migration/service.ts

import { eq, and, inArray, desc, sql } from "drizzle-orm";
import {
  stagedDeals,
  stagedContacts,
  stagedActivities,
  importRuns,
} from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";

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
  const [dealStats, contactStats, activityStats, recentRuns] = await Promise.all([
    db.execute(sql`
      SELECT validation_status, COUNT(*)::int AS count
      FROM migration.staged_deals
      GROUP BY validation_status
    `),
    db.execute(sql`
      SELECT validation_status, COUNT(*)::int AS count
      FROM migration.staged_contacts
      GROUP BY validation_status
    `),
    db.execute(sql`
      SELECT validation_status, COUNT(*)::int AS count
      FROM migration.staged_activities
      GROUP BY validation_status
    `),
    db
      .select()
      .from(importRuns)
      .orderBy(desc(importRuns.startedAt))
      .limit(5),
  ]);

  function toMap(rows: any): Record<string, number> {
    const arr = (rows as any).rows ?? rows;
    const m: Record<string, number> = {};
    for (const r of arr) m[r.validation_status] = Number(r.count ?? 0);
    return m;
  }

  return {
    deals: toMap(dealStats),
    contacts: toMap(contactStats),
    activities: toMap(activityStats),
    recentRuns,
  };
}
