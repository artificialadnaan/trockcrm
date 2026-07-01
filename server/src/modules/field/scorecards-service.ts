import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { fieldScorecards, fieldScorecardItems, fieldScorecardPhotos, files } from "@trock-crm/shared/schema";
import {
  FIELD_SCORECARD_SECTION_KEYS,
  actionItemsRequired,
  computeScorecardTotal,
  isLegalSectionPoints,
  isScorecardCriticalDeficiencyKey,
  isScorecardSectionKey,
  resolveScorecardRating,
  scorecardRatingLabel,
  type FieldScorecardDetail,
  type FieldScorecardSummary,
  type ScorecardRating,
  type ScorecardSectionKey,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;
type ScorecardRow = typeof fieldScorecards.$inferSelect;

export interface CreateFieldScorecardInput {
  userId: string;
  submittedByName?: string | null;
  dealId: string;
  clientSubmissionId: string;
  weekOf: string;
  superintendentName?: string | null;
  pmName?: string | null;
  projectNumber?: string | null;
  items: { sectionKey: string; points: number; note?: string | null }[];
  criticalDeficiencies: string[];
  actionItems: string[];
  photos: { sectionKey: string; clientUploadId: string }[];
}

type ValidatedItem = { sectionKey: ScorecardSectionKey; points: number; note: string | null };

/**
 * Persist a submitted scorecard. Server is the scoring authority: it re-validates every section, recomputes
 * total + rating, enforces the action-item gate, and resolves photo evidence by clientUploadId (asserting each
 * belongs to this deal). Idempotent on `clientSubmissionId` so the durable offline retry can't duplicate.
 * The caller (route) wraps this in an office transaction.
 */
export async function createFieldScorecard(
  tenantDb: TenantDb,
  input: CreateFieldScorecardInput,
): Promise<{ scorecard: FieldScorecardSummary; created: boolean }> {
  const priorCard = await findByClientSubmissionId(tenantDb, input.clientSubmissionId);
  if (priorCard) return { scorecard: toSummary(priorCard), created: false };

  const items = validateItems(input.items);
  const deficiencies = validateDeficiencies(input.criticalDeficiencies);
  const total = computeScorecardTotal(items);
  const rating = resolveScorecardRating(total);

  const actionItems = input.actionItems.map((s) => s.trim()).filter((s) => s.length > 0);
  if (actionItemsRequired({ total, deficiencyCount: deficiencies.length }) && actionItems.length === 0) {
    throw new AppError(
      422,
      "At least one action item is required when the score is below 85 or any critical deficiency is flagged.",
    );
  }

  const photoLinks = await resolvePhotoLinks(tenantDb, input);

  let card: ScorecardRow;
  try {
    const inserted = await tenantDb
      .insert(fieldScorecards)
      .values({
        clientSubmissionId: input.clientSubmissionId,
        dealId: input.dealId,
        weekOf: input.weekOf,
        projectNumber: input.projectNumber ?? null,
        superintendentName: input.superintendentName ?? null,
        pmName: input.pmName ?? null,
        totalScore: total,
        rating,
        criticalDeficiencies: deficiencies,
        actionItems,
        submittedBy: input.userId,
        submittedByName: input.submittedByName ?? null,
      })
      .returning();
    card = inserted[0];
  } catch (err) {
    // A concurrent retry won the unique(client_submission_id) race — return the winner, don't duplicate.
    if (isUniqueViolation(err)) {
      const raced = await findByClientSubmissionId(tenantDb, input.clientSubmissionId);
      if (raced) return { scorecard: toSummary(raced), created: false };
    }
    throw err;
  }

  await tenantDb.insert(fieldScorecardItems).values(
    items.map((it) => ({
      scorecardId: card.id,
      sectionKey: it.sectionKey,
      points: it.points,
      note: it.note,
    })),
  );
  if (photoLinks.length > 0) {
    await tenantDb
      .insert(fieldScorecardPhotos)
      .values(photoLinks.map((p) => ({ scorecardId: card.id, sectionKey: p.sectionKey, fileId: p.fileId })));
  }

  return { scorecard: toSummary(card), created: true };
}

export async function listFieldScorecardsForProject(
  tenantDb: TenantDb,
  dealId: string,
): Promise<{ scorecards: FieldScorecardSummary[] }> {
  const rows = await tenantDb
    .select()
    .from(fieldScorecards)
    .where(and(eq(fieldScorecards.dealId, dealId), eq(fieldScorecards.isActive, true)))
    .orderBy(desc(fieldScorecards.submittedAt));
  return { scorecards: rows.map(toSummary) };
}

export async function listRecentFieldScorecards(
  tenantDb: TenantDb,
  opts?: { limit?: number },
): Promise<{ scorecards: FieldScorecardSummary[] }> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const rows = await tenantDb
    .select()
    .from(fieldScorecards)
    .where(eq(fieldScorecards.isActive, true))
    .orderBy(desc(fieldScorecards.submittedAt))
    .limit(limit);
  return { scorecards: rows.map(toSummary) };
}

export async function getFieldScorecardDetail(
  tenantDb: TenantDb,
  id: string,
  opts?: { resolvePhotoUrl?: (fileId: string) => Promise<string | null> },
): Promise<FieldScorecardDetail> {
  const rows = await tenantDb
    .select()
    .from(fieldScorecards)
    .where(and(eq(fieldScorecards.id, id), eq(fieldScorecards.isActive, true)))
    .limit(1);
  const card = rows[0];
  if (!card) throw new AppError(404, "Scorecard not found");

  const itemRows = await tenantDb
    .select()
    .from(fieldScorecardItems)
    .where(eq(fieldScorecardItems.scorecardId, id));
  const itemByKey = new Map(itemRows.map((r) => [r.sectionKey, r]));
  const items = FIELD_SCORECARD_SECTION_KEYS.filter((k) => itemByKey.has(k)).map((k) => {
    const r = itemByKey.get(k)!;
    return { sectionKey: k, points: r.points, note: r.note ?? null };
  });

  const photoRows = await tenantDb
    .select({
      id: fieldScorecardPhotos.id,
      sectionKey: fieldScorecardPhotos.sectionKey,
      fileId: fieldScorecardPhotos.fileId,
      caption: files.description,
    })
    .from(fieldScorecardPhotos)
    .leftJoin(files, eq(files.id, fieldScorecardPhotos.fileId))
    .where(eq(fieldScorecardPhotos.scorecardId, id));

  const photos: FieldScorecardDetail["photos"] = [];
  for (const p of photoRows) {
    const url = opts?.resolvePhotoUrl ? await opts.resolvePhotoUrl(p.fileId) : null;
    photos.push({
      id: p.id,
      sectionKey: p.sectionKey as ScorecardSectionKey,
      fileId: p.fileId,
      url,
      caption: p.caption ?? null,
    });
  }

  return {
    ...toSummary(card),
    items,
    criticalDeficiencies: card.criticalDeficiencies ?? [],
    actionItems: card.actionItems ?? [],
    photos,
  };
}

// ── internals ───────────────────────────────────────────────────────────────

async function findByClientSubmissionId(tenantDb: TenantDb, clientSubmissionId: string): Promise<ScorecardRow | null> {
  const rows = await tenantDb
    .select()
    .from(fieldScorecards)
    .where(eq(fieldScorecards.clientSubmissionId, clientSubmissionId))
    .limit(1);
  return rows[0] ?? null;
}

function validateItems(rawItems: CreateFieldScorecardInput["items"]): ValidatedItem[] {
  const seen = new Map<ScorecardSectionKey, ValidatedItem>();
  for (const it of rawItems) {
    if (!isScorecardSectionKey(it.sectionKey)) {
      throw new AppError(422, `Unknown scorecard section: ${it.sectionKey}`);
    }
    if (seen.has(it.sectionKey)) {
      throw new AppError(422, `Duplicate scorecard section: ${it.sectionKey}`);
    }
    if (!isLegalSectionPoints(it.sectionKey, it.points)) {
      throw new AppError(422, `Invalid point value ${it.points} for section ${it.sectionKey}.`);
    }
    seen.set(it.sectionKey, { sectionKey: it.sectionKey, points: it.points, note: it.note?.trim() ? it.note.trim() : null });
  }
  const missing = FIELD_SCORECARD_SECTION_KEYS.filter((k) => !seen.has(k));
  if (missing.length > 0) {
    throw new AppError(422, `Missing scorecard section(s): ${missing.join(", ")}.`);
  }
  // Canonical section order.
  return FIELD_SCORECARD_SECTION_KEYS.map((k) => seen.get(k)!);
}

function validateDeficiencies(keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    if (!isScorecardCriticalDeficiencyKey(k)) {
      throw new AppError(422, `Unknown critical deficiency: ${k}`);
    }
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

async function resolvePhotoLinks(
  tenantDb: TenantDb,
  input: CreateFieldScorecardInput,
): Promise<{ sectionKey: ScorecardSectionKey; fileId: string }[]> {
  const links: { sectionKey: ScorecardSectionKey; fileId: string }[] = [];
  const seenFile = new Set<string>();
  for (const p of input.photos) {
    if (!isScorecardSectionKey(p.sectionKey)) {
      throw new AppError(422, `Unknown scorecard section: ${p.sectionKey}`);
    }
    // Resolve the already-uploaded gallery photo by its clientUploadId (same key the photo pipeline
    // stamps), scoped to the submitting user. Only id + dealId are needed to link + authorize.
    const rows = await tenantDb
      .select({ id: files.id, dealId: files.dealId })
      .from(files)
      .where(and(eq(files.clientUploadId, p.clientUploadId), eq(files.uploadedBy, input.userId)))
      .limit(1);
    const file = rows[0];
    if (!file) {
      throw new AppError(422, `Evidence photo not found for upload ${p.clientUploadId}.`);
    }
    if (file.dealId !== input.dealId) {
      throw new AppError(422, `Evidence photo ${p.clientUploadId} does not belong to this deal.`);
    }
    if (seenFile.has(file.id)) continue; // a photo backs one section; ignore duplicates
    seenFile.add(file.id);
    links.push({ sectionKey: p.sectionKey, fileId: file.id });
  }
  return links;
}

function toSummary(row: ScorecardRow): FieldScorecardSummary {
  const rating = row.rating as ScorecardRating;
  return {
    id: row.id,
    dealId: row.dealId,
    weekOf: typeof row.weekOf === "string" ? row.weekOf : String(row.weekOf),
    totalScore: row.totalScore,
    rating,
    ratingLabel: scorecardRatingLabel(rating),
    superintendentName: row.superintendentName ?? null,
    pmName: row.pmName ?? null,
    projectNumber: row.projectNumber ?? null,
    criticalDeficiencyCount: (row.criticalDeficiencies ?? []).length,
    submittedByName: row.submittedByName ?? null,
    submittedAt: toIso(row.submittedAt),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
