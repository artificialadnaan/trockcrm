import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { deals, fieldScorecards, fieldScorecardItems, fieldScorecardPhotos, files, jobQueue } from "@trock-crm/shared/schema";
import { generateDownloadUrl, putObject } from "../../lib/r2-client.js";
import { buildScorecardPdfData, renderFieldScorecardPdf } from "./scorecard-pdf.js";
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
import { activeProjectWhere, assertActiveFieldProject, type FieldAccessContext } from "./projects-service.js";

type TenantDb = NodePgDatabase<typeof schema>;
type ScorecardRow = typeof fieldScorecards.$inferSelect;

export interface CreateFieldScorecardInput {
  userId: string;
  userRole: FieldAccessContext["userRole"];
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

// The subset of columns a summary needs — satisfied by both a Drizzle row and the aliased raw-SQL rows
// from the gated recent-list query.
interface ScorecardSummarySource {
  id: string;
  dealId: string;
  weekOf: unknown;
  totalScore: number;
  rating: string;
  superintendentName: string | null;
  pmName: string | null;
  projectNumber: string | null;
  criticalDeficiencies: string[] | null;
  submittedByName: string | null;
  submittedAt: unknown;
}

/**
 * Persist a submitted scorecard. Server is the scoring authority: it gates on the deal being a
 * browsable field project, re-validates every section, recomputes total + rating, enforces the
 * action-item gate, and resolves photo evidence by clientUploadId (asserting each belongs to this deal
 * and is still active). Idempotent on `clientSubmissionId` — a retried offline submit returns the
 * existing card, never duplicates. The caller (route) wraps this in an office transaction.
 */
export async function createFieldScorecard(
  tenantDb: TenantDb,
  input: CreateFieldScorecardInput,
): Promise<{ scorecard: FieldScorecardSummary; created: boolean }> {
  // Idempotency runs FIRST so a retry of an already-submitted card still succeeds even if the deal has
  // since dropped off the field surface (e.g. moved to Lost after the original submit).
  const priorCard = await findByClientSubmissionId(tenantDb, input.clientSubmissionId);
  if (priorCard) return { scorecard: toSummary(priorCard), created: false };

  // Only browsable field projects (active pipeline OR Won-family, never Lost/terminal/inactive) may be
  // scored — same gate the field project reads use. Runs in the resolved office; an off-office deal isn't
  // present here, so this 404s cleanly instead of failing later on the deal_id FK.
  const project = await assertActiveFieldProject(
    tenantDb,
    { userId: input.userId, userRole: input.userRole },
    input.dealId,
  );

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

  // ON CONFLICT DO NOTHING keeps the transaction usable if a concurrent retry inserted the same
  // clientSubmissionId first — catching a 23505 here would instead poison the open txn (aborted state).
  const inserted = await tenantDb
    .insert(fieldScorecards)
    .values({
      clientSubmissionId: input.clientSubmissionId,
      dealId: input.dealId,
      weekOf: input.weekOf,
      // Snapshot the SERVER-resolved canonical display number (project_number, else non-HubSpot
      // deal_number, else null) — never the client-sent value, which may be stale/spoofed/absent.
      projectNumber: project.projectNumber ?? null,
      superintendentName: input.superintendentName ?? null,
      pmName: input.pmName ?? null,
      totalScore: total,
      rating,
      criticalDeficiencies: deficiencies,
      actionItems,
      submittedBy: input.userId,
      submittedByName: input.submittedByName ?? null,
    })
    .onConflictDoNothing({ target: fieldScorecards.clientSubmissionId })
    .returning();

  if (inserted.length === 0) {
    const raced = await findByClientSubmissionId(tenantDb, input.clientSubmissionId);
    if (raced) return { scorecard: toSummary(raced), created: false };
    throw new AppError(409, "Could not save the scorecard — please try again.");
  }
  const card = inserted[0];

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
  access: FieldAccessContext,
  dealId: string,
): Promise<{ scorecards: FieldScorecardSummary[] }> {
  // 404s if the deal isn't a browsable field project — same gate the project reads apply.
  await assertActiveFieldProject(tenantDb, access, dealId);
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
  // Join back to the deal + stage so the landing list only surfaces cards for still-browsable projects
  // (activeProjectWhere = active pipeline OR Won-family, never Lost/terminal/inactive) — a deal later
  // archived or moved to Lost stops appearing here without touching the scorecard row.
  const result = await tenantDb.execute(sql`
    SELECT
      sc.id AS "id",
      sc.deal_id AS "dealId",
      sc.total_score AS "totalScore",
      sc.rating AS "rating",
      sc.superintendent_name AS "superintendentName",
      sc.pm_name AS "pmName",
      sc.project_number AS "projectNumber",
      sc.critical_deficiencies AS "criticalDeficiencies",
      sc.submitted_by_name AS "submittedByName",
      sc.week_of::text AS "weekOf",
      sc.submitted_at AS "submittedAt"
    FROM field_scorecards sc
    JOIN deals d ON d.id = sc.deal_id
    LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE sc.is_active = true
      AND ${activeProjectWhere()}
    ORDER BY sc.submitted_at DESC
    LIMIT ${limit}
  `);
  const rows = (((result as any).rows ?? result) as ScorecardSummarySource[]) ?? [];
  return { scorecards: rows.map(toSummary) };
}

export async function getFieldScorecardDetail(
  tenantDb: TenantDb,
  id: string,
  access: FieldAccessContext,
  opts?: { resolvePhotoUrl?: (fileId: string) => Promise<string | null> },
): Promise<FieldScorecardDetail> {
  const rows = await tenantDb
    .select()
    .from(fieldScorecards)
    .where(and(eq(fieldScorecards.id, id), eq(fieldScorecards.isActive, true)))
    .limit(1);
  const card = rows[0];
  if (!card) throw new AppError(404, "Scorecard not found");
  // Gate on the underlying project's browsability — a card whose deal is Lost/terminal/inactive is
  // hidden from the field surface, exactly like the project itself.
  await assertActiveFieldProject(tenantDb, access, card.dealId);

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

  // Resolve presigned URLs concurrently (order preserved by Promise.all) so detail latency doesn't scale
  // with the photo count.
  const photos = await Promise.all(
    photoRows.map(async (p) => ({
      id: p.id,
      sectionKey: p.sectionKey as ScorecardSectionKey,
      fileId: p.fileId,
      url: opts?.resolvePhotoUrl ? await opts.resolvePhotoUrl(p.fileId) : null,
      caption: p.caption ?? null,
    })),
  );

  return {
    ...toSummary(card),
    items,
    criticalDeficiencies: card.criticalDeficiencies ?? [],
    actionItems: card.actionItems ?? [],
    photos,
  };
}

// job_type string — MUST match the worker's registerJobHandler(FIELD_SCORECARD_EMAIL_JOB, ...). The server
// can't import from the worker package, so the string is duplicated (as with the other enqueue sites).
const FIELD_SCORECARD_EMAIL_JOB = "field_scorecard_email";
const SCORECARD_PDF_DOWNLOAD_EXPIRY_SECONDS = 60 * 60;

/**
 * Render + store the scorecard PDF and enqueue its email job. Called POST-COMMIT (outside the submit
 * transaction) so R2 I/O never holds a DB txn open and a PDF/R2 hiccup can NEVER lose the submission — the
 * scorecard row is already durably committed. Best-effort by design: the caller swallows failures (the
 * email job re-drives delivery; a missing PDF degrades the email to a no-attachment notice).
 */
export async function finalizeFieldScorecardArtifacts(
  tenantDb: TenantDb,
  office: { id: string; slug: string },
  scorecardId: string,
): Promise<void> {
  const [card] = await tenantDb.select().from(fieldScorecards).where(eq(fieldScorecards.id, scorecardId)).limit(1);
  if (!card) return;

  const itemRows = await tenantDb
    .select()
    .from(fieldScorecardItems)
    .where(eq(fieldScorecardItems.scorecardId, scorecardId));
  const [deal] = await tenantDb
    .select({ name: deals.name, dealNumber: deals.dealNumber })
    .from(deals)
    .where(eq(deals.id, card.dealId))
    .limit(1);

  const pdfData = buildScorecardPdfData({
    dealName: deal?.name ?? "Project",
    projectNumber: card.projectNumber ?? null,
    weekOf: typeof card.weekOf === "string" ? card.weekOf : String(card.weekOf),
    superintendentName: card.superintendentName ?? null,
    pmName: card.pmName ?? null,
    submittedByName: card.submittedByName ?? null,
    submittedAt: toIso(card.submittedAt),
    totalScore: card.totalScore,
    rating: card.rating as ScorecardRating,
    items: itemRows.map((r) => ({ sectionKey: r.sectionKey, points: r.points, note: r.note ?? null })),
    criticalDeficiencyKeys: card.criticalDeficiencies ?? [],
    actionItems: card.actionItems ?? [],
  });

  const pdf = await renderFieldScorecardPdf(pdfData);
  const bucket = process.env.R2_BUCKET_NAME || "trock-crm-files";
  // Organise under the deal like photo reports; scorecardId keeps the key unique. RAW deal_number (the
  // photo-report key convention), falling back to the deal id when a deal has none.
  const dealKeySegment = deal?.dealNumber?.trim() || card.dealId;
  const r2Key = `office_${office.slug}/deals/${dealKeySegment}/documents/scorecards/${scorecardId}.pdf`;
  await putObject(r2Key, pdf, "application/pdf");

  await tenantDb
    .update(fieldScorecards)
    .set({ pdfR2Key: r2Key, pdfR2Bucket: bucket, pdfGeneratedAt: new Date() })
    .where(eq(fieldScorecards.id, scorecardId));

  // Outbox: enqueue the email job (worker fetches the PDF from R2 + sends with it attached).
  await tenantDb.insert(jobQueue).values({
    jobType: FIELD_SCORECARD_EMAIL_JOB,
    payload: {
      tenantSchema: `office_${office.slug}`,
      scorecardId,
      dealId: card.dealId,
      dealName: deal?.name ?? null,
      projectNumber: card.projectNumber ?? null,
      weekOf: pdfData.weekOf,
      totalScore: card.totalScore,
      ratingLabel: pdfData.ratingLabel,
      submittedByName: card.submittedByName ?? null,
      pdfR2Key: r2Key,
      officeId: office.id,
    },
    officeId: office.id,
    status: "pending",
    runAfter: new Date(),
    maxAttempts: 6,
  });
}

/**
 * Presigned download URL for a scorecard's stored PDF. Gated on the underlying project's browsability
 * (same as the detail read). 404s cleanly while the PDF is still generating (no key yet).
 */
export async function getFieldScorecardPdfDownload(
  tenantDb: TenantDb,
  id: string,
  access: FieldAccessContext,
): Promise<{ url: string; expiresAt: string }> {
  const [card] = await tenantDb
    .select({ dealId: fieldScorecards.dealId, pdfR2Key: fieldScorecards.pdfR2Key })
    .from(fieldScorecards)
    .where(and(eq(fieldScorecards.id, id), eq(fieldScorecards.isActive, true)))
    .limit(1);
  if (!card) throw new AppError(404, "Scorecard not found");
  await assertActiveFieldProject(tenantDb, access, card.dealId);
  if (!card.pdfR2Key) throw new AppError(404, "The scorecard PDF is still generating — please try again shortly.");
  const url = await generateDownloadUrl(card.pdfR2Key, SCORECARD_PDF_DOWNLOAD_EXPIRY_SECONDS, `field-scorecard-${id}.pdf`);
  return { url, expiresAt: new Date(Date.now() + SCORECARD_PDF_DOWNLOAD_EXPIRY_SECONDS * 1000).toISOString() };
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
  for (const p of input.photos) {
    if (!isScorecardSectionKey(p.sectionKey)) {
      throw new AppError(422, `Unknown scorecard section: ${p.sectionKey}`);
    }
  }
  const uploadIds = [...new Set(input.photos.map((p) => p.clientUploadId))];
  if (uploadIds.length === 0) return [];

  // ONE lookup for every referenced photo (no N+1 inside the write transaction): the already-uploaded
  // gallery files by their clientUploadId (the key the photo pipeline stamps), scoped to the submitting
  // user and only if still ACTIVE — a soft-deleted photo can't be presigned on the detail path, so
  // linking it would persist missing evidence.
  const rows = await tenantDb
    .select({ id: files.id, dealId: files.dealId, clientUploadId: files.clientUploadId })
    .from(files)
    .where(
      and(
        inArray(files.clientUploadId, uploadIds),
        eq(files.uploadedBy, input.userId),
        eq(files.isActive, true),
        isNull(files.deletedAt),
      ),
    );
  const byUploadId = new Map(rows.map((r) => [r.clientUploadId, r]));

  const links: { sectionKey: ScorecardSectionKey; fileId: string }[] = [];
  const seenFile = new Set<string>();
  for (const p of input.photos) {
    const file = byUploadId.get(p.clientUploadId);
    if (!file) {
      throw new AppError(422, `Evidence photo not found (or no longer available) for upload ${p.clientUploadId}.`);
    }
    if (file.dealId !== input.dealId) {
      throw new AppError(422, `Evidence photo ${p.clientUploadId} does not belong to this deal.`);
    }
    if (seenFile.has(file.id)) continue; // a photo backs one section; ignore duplicates
    seenFile.add(file.id);
    // Section key already validated in the first loop above.
    links.push({ sectionKey: p.sectionKey as ScorecardSectionKey, fileId: file.id });
  }
  return links;
}

function toSummary(row: ScorecardSummarySource): FieldScorecardSummary {
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
