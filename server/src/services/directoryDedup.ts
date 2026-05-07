import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  companies,
  contacts,
  deals,
  directoryMergeAudit,
  directoryMergeQueue,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type DirectoryEntityKind = "company" | "contact";
export type DirectoryMatchBand = "auto_merge" | "review_queue" | "none";

export interface DirectoryCompanyCandidate {
  id?: string;
  name: string;
  state?: string | null;
  zip?: string | null;
}

export interface DirectoryContactCandidate {
  id?: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  state?: string | null;
}

export interface DirectoryMatchInput {
  kind: DirectoryEntityKind;
  left: DirectoryCompanyCandidate | DirectoryContactCandidate;
  right: DirectoryCompanyCandidate | DirectoryContactCandidate;
}

export interface DirectoryMatchResult {
  band: DirectoryMatchBand;
  score: number;
  reasons: string[];
}

const COMPANY_SUFFIXES = /\b(inc|llc|ltd|co|corp|corporation|company|lp|pllc)\b/g;

export function normalizeDirectoryName(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeZip(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}

export function normalizeEmailDomain(value: string | null | undefined): string | null {
  const email = (value ?? "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(at + 1);
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] =
        a[i - 1] === b[j - 1]
          ? rows[i - 1][j - 1]
          : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1]);
    }
  }
  const distance = rows[a.length][b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

function sameState(left: { state?: string | null }, right: { state?: string | null }): boolean {
  const a = left.state?.trim().toUpperCase();
  const b = right.state?.trim().toUpperCase();
  return Boolean(a && b && a === b);
}

function contactName(candidate: DirectoryContactCandidate): string {
  return normalizeDirectoryName(`${candidate.firstName} ${candidate.lastName}`);
}

export function classifyDirectoryMatch(input: DirectoryMatchInput): DirectoryMatchResult {
  const reasons: string[] = [];
  let score = 0;

  if (input.kind === "company") {
    const left = input.left as DirectoryCompanyCandidate;
    const right = input.right as DirectoryCompanyCandidate;
    const leftName = normalizeDirectoryName(left.name);
    const rightName = normalizeDirectoryName(right.name);
    const leftZip = normalizeZip(left.zip);
    const rightZip = normalizeZip(right.zip);
    const nameScore = similarity(leftName, rightName);

    if (leftName && rightName && leftName === rightName && leftZip && leftZip === rightZip) {
      reasons.push("exact_normalized_name_zip");
      score = 0.99;
    } else if (sameState(left, right) && nameScore >= 0.9) {
      reasons.push("fuzzy_name_same_state");
      score = Math.min(0.94, Math.max(0.8, nameScore));
    }
  } else {
    const left = input.left as DirectoryContactCandidate;
    const right = input.right as DirectoryContactCandidate;
    const leftDomain = normalizeEmailDomain(left.email);
    const rightDomain = normalizeEmailDomain(right.email);
    const nameScore = similarity(contactName(left), contactName(right));

    if (left.email && right.email && left.email.trim().toLowerCase() === right.email.trim().toLowerCase()) {
      reasons.push("exact_email");
      score = 0.99;
    } else if (leftDomain && rightDomain && leftDomain === rightDomain) {
      reasons.push("domain_match");
      score = Math.max(score, 0.86);
    }

    if (sameState(left, right) && nameScore >= 0.9) {
      reasons.push("fuzzy_name_same_state");
      score = Math.max(score, Math.min(0.94, nameScore));
    }
  }

  return {
    band: score >= 0.95 ? "auto_merge" : score >= 0.8 ? "review_queue" : "none",
    score: Number(score.toFixed(3)),
    reasons,
  };
}

function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function directoryPairLockKey(entityType: DirectoryEntityKind, a: string, b: string): string {
  const [entityAId, entityBId] = orderedPair(a, b);
  return `directory-dedup:${entityType}:${entityAId}:${entityBId}`;
}

async function tryAcquireDirectoryPairLock(
  tenantDb: TenantDb,
  entityType: DirectoryEntityKind,
  a: string,
  b: string
): Promise<boolean> {
  const lockKey = directoryPairLockKey(entityType, a, b);
  const result = await tenantDb.execute(sql`
    SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked
  `);
  const rows = (result as any).rows ?? result;
  return Boolean(rows[0]?.locked);
}

async function upsertQueueEntry(
  tenantDb: TenantDb,
  entityType: DirectoryEntityKind,
  a: string,
  b: string,
  match: DirectoryMatchResult,
  status: "pending" | "auto_merged" = "pending"
) {
  const [entityAId, entityBId] = orderedPair(a, b);
  await tenantDb
    .insert(directoryMergeQueue)
    .values({
      entityType,
      entityAId,
      entityBId,
      confidenceScore: String(match.score),
      matchReasons: match.reasons,
      status,
    })
    .onConflictDoUpdate({
      target: [directoryMergeQueue.entityType, directoryMergeQueue.entityAId, directoryMergeQueue.entityBId],
      set: {
        confidenceScore: String(match.score),
        matchReasons: match.reasons,
        updatedAt: new Date(),
      },
    });
}

export async function scanDirectoryDuplicates(
  tenantDb: TenantDb,
  options: { autoMerge?: boolean; limit?: number } = {}
) {
  const autoMerge = options.autoMerge ?? false;
  const limit = options.limit ?? 1000;
  const companyRows = await tenantDb.select().from(companies).where(eq(companies.isActive, true)).limit(limit);
  const contactRows = await tenantDb.select().from(contacts).where(eq(contacts.isActive, true)).limit(limit);
  let queued = 0;
  let autoMerged = 0;

  for (let i = 0; i < companyRows.length; i++) {
    for (let j = i + 1; j < companyRows.length; j++) {
      const match = classifyDirectoryMatch({ kind: "company", left: companyRows[i], right: companyRows[j] });
      if (match.band === "none") continue;
      if (!(await tryAcquireDirectoryPairLock(tenantDb, "company", companyRows[i].id, companyRows[j].id))) {
        continue;
      }
      if (match.band === "auto_merge" && autoMerge) {
        await mergeDirectoryEntities(tenantDb, "company", companyRows[i].id, companyRows[j].id, {
          mode: "auto",
          confidenceScore: match.score,
          matchReasons: match.reasons,
        });
        await upsertQueueEntry(tenantDb, "company", companyRows[i].id, companyRows[j].id, match, "auto_merged");
        autoMerged += 1;
      } else {
        await upsertQueueEntry(tenantDb, "company", companyRows[i].id, companyRows[j].id, match);
        queued += 1;
      }
    }
  }

  for (let i = 0; i < contactRows.length; i++) {
    for (let j = i + 1; j < contactRows.length; j++) {
      const match = classifyDirectoryMatch({ kind: "contact", left: contactRows[i], right: contactRows[j] });
      if (match.band === "none") continue;
      if (!(await tryAcquireDirectoryPairLock(tenantDb, "contact", contactRows[i].id, contactRows[j].id))) {
        continue;
      }
      if (match.band === "auto_merge" && autoMerge) {
        await mergeDirectoryEntities(tenantDb, "contact", contactRows[i].id, contactRows[j].id, {
          mode: "auto",
          confidenceScore: match.score,
          matchReasons: match.reasons,
        });
        await upsertQueueEntry(tenantDb, "contact", contactRows[i].id, contactRows[j].id, match, "auto_merged");
        autoMerged += 1;
      } else {
        await upsertQueueEntry(tenantDb, "contact", contactRows[i].id, contactRows[j].id, match);
        queued += 1;
      }
    }
  }

  return { scannedCompanies: companyRows.length, scannedContacts: contactRows.length, queued, autoMerged };
}

export async function listDirectoryMergeQueue(tenantDb: TenantDb, status = "pending") {
  const entries = await tenantDb
    .select()
    .from(directoryMergeQueue)
    .where(eq(directoryMergeQueue.status, status as any))
    .orderBy(sql`${directoryMergeQueue.confidenceScore} DESC`, directoryMergeQueue.createdAt)
    .limit(100);

  return Promise.all(
    entries.map(async (entry) => {
      const table = entry.entityType === "company" ? companies : contacts;
      const [entityA, entityB] = await Promise.all([
        tenantDb.select().from(table as any).where(eq((table as any).id, entry.entityAId)).limit(1),
        tenantDb.select().from(table as any).where(eq((table as any).id, entry.entityBId)).limit(1),
      ]);
      return { ...entry, entityA: entityA[0] ?? null, entityB: entityB[0] ?? null };
    })
  );
}

export async function mergeDirectoryEntities(
  tenantDb: TenantDb,
  entityType: DirectoryEntityKind,
  winnerId: string,
  loserId: string,
  options: {
    queueEntryId?: string;
    mergedBy?: string | null;
    mode: "auto" | "manual";
    confidenceScore: number;
    matchReasons: string[];
  }
) {
  if (winnerId === loserId) throw new AppError(400, "Cannot merge an entity with itself");

  if (entityType === "company") {
    await tenantDb.update(contacts).set({ companyId: winnerId }).where(eq(contacts.companyId, loserId));
    await tenantDb.update(deals).set({ companyId: winnerId }).where(eq(deals.companyId, loserId));
    await tenantDb
      .update(companies)
      .set({
        isActive: false,
        sourceRefs: sql`COALESCE(source_refs, '{}'::jsonb) || jsonb_build_object('merged_into', ${winnerId})`,
      } as any)
      .where(eq(companies.id, loserId));
  } else {
    await tenantDb
      .update(contacts)
      .set({
        isActive: false,
        sourceRefs: sql`COALESCE(source_refs, '{}'::jsonb) || jsonb_build_object('merged_into', ${winnerId})`,
      } as any)
      .where(eq(contacts.id, loserId));
  }

  await tenantDb.insert(directoryMergeAudit).values({
    queueEntryId: options.queueEntryId ?? null,
    entityType,
    winnerId,
    loserId,
    confidenceScore: String(options.confidenceScore),
    matchReasons: options.matchReasons,
    mode: options.mode,
    mergedBy: options.mergedBy ?? null,
    fieldChanges: { loserIsActive: false, winnerId },
  });

  if (options.queueEntryId) {
    await tenantDb
      .update(directoryMergeQueue)
      .set({
        status: options.mode === "auto" ? "auto_merged" : "merged",
        resolvedBy: options.mergedBy ?? null,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(directoryMergeQueue.id, options.queueEntryId));
  }

  return { winnerId, loserId, entityType };
}

export async function resolveDirectoryMergeQueueEntry(
  tenantDb: TenantDb,
  queueEntryId: string,
  action: "merge" | "dismiss",
  actorUserId: string,
  winnerId?: string
) {
  const [entry] = await tenantDb.select().from(directoryMergeQueue).where(eq(directoryMergeQueue.id, queueEntryId)).limit(1);
  if (!entry || entry.status !== "pending") throw new AppError(404, "Directory merge queue entry not found");

  if (action === "dismiss") {
    await tenantDb
      .update(directoryMergeQueue)
      .set({ status: "dismissed", resolvedBy: actorUserId, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(directoryMergeQueue.id, queueEntryId));
    return { dismissed: true };
  }

  const chosenWinnerId = winnerId ?? entry.entityAId;
  const loserId = chosenWinnerId === entry.entityAId ? entry.entityBId : entry.entityAId;
  return mergeDirectoryEntities(tenantDb, entry.entityType, chosenWinnerId, loserId, {
    queueEntryId,
    mergedBy: actorUserId,
    mode: "manual",
    confidenceScore: Number(entry.confidenceScore),
    matchReasons: entry.matchReasons,
  });
}
