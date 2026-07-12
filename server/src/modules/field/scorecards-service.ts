import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { deals, fieldScorecards, fieldScorecardItems, fieldScorecardPhotos, files, jobQueue } from "@trock-crm/shared/schema";
import { generateDownloadUrl, putObject } from "../../lib/r2-client.js";
import { buildScorecardPdfData, renderFieldScorecardPdf, MAX_EVIDENCE_PHOTOS } from "./scorecard-pdf.js";
import { loadScorecardEvidenceImage, prioritizeAndCapEvidencePhotos } from "./scorecard-evidence-image.js";
import {
  FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS,
  FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY,
  FIELD_SCORECARD_SECTION_KEYS,
  FIELD_SCORECARD_V2_SECTION_KEYS,
  actionItemsRequired,
  computeScorecardLeadershipAverage,
  computeScorecardTotal,
  computeScorecardV2Average,
  isLeadershipSectionKey,
  isLegalSectionPoints,
  isScorecardCriticalDeficiencyKey,
  isScorecardSectionKey,
  isScorecardV2CriticalDeficiencyKey,
  isScorecardV2SectionKey,
  resolveScorecardLeadershipRating,
  resolveScorecardRating,
  resolveScorecardV2Rating,
  scorecardLeadershipRatingLabel,
  scorecardRatingLabel,
  scorecardV2RatingLabel,
  type FieldScorecardDetail,
  type FieldScorecardSummary,
  type ScorecardKind,
  type ScorecardLeadershipSectionKey,
  type ScorecardRating,
  type ScorecardSectionKey,
  type ScorecardFormVersion,
  type ScorecardV2SectionKey,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { activeProjectWhere, assertActiveFieldProject, type FieldAccessContext } from "./projects-service.js";
import { runInOffice, runInOfficeTransaction } from "./cross-office.js";
import { resolveScorecardTeamEmails } from "../deals/team-service.js";

type TenantDb = NodePgDatabase<typeof schema>;
type ScorecardRow = typeof fieldScorecards.$inferSelect;

export interface CreateFieldScorecardInput {
  userId: string;
  userRole: FieldAccessContext["userRole"];
  submittedByName?: string | null;
  dealId: string;
  /** Owning office (id + slug) — used to enqueue the email job IN the submit txn (durable outbox). */
  office: { id: string; slug: string };
  clientSubmissionId: string;
  weekOf: string;
  formVersion?: ScorecardFormVersion;
  /** Discriminates project (default) vs leadership scorecards; both share the same tables. */
  kind?: ScorecardKind;
  superintendentName?: string | null;
  pmName?: string | null;
  projectNumber?: string | null;
  items: { sectionKey: string; points: number; note?: string | null }[];
  criticalDeficiencies: string[];
  criticalDeficiencyNotes?: Record<string, string>;
  actionItems: string[];
  photos: { sectionKey: string; deficiencyKey?: string | null; clientUploadId: string }[];
  superintendentSignature?: string | null;
  pmSignature?: string | null;
  /** Leadership Project Summary free text (voice-dictatable). */
  summary?: string | null;
}

type ValidatedItem = {
  sectionKey: ScorecardSectionKey | ScorecardV2SectionKey | ScorecardLeadershipSectionKey;
  points: number;
  note: string | null;
};

// The subset of columns a summary needs — satisfied by both a Drizzle row and the aliased raw-SQL rows
// from the gated recent-list query.
interface ScorecardSummarySource {
  id: string;
  dealId: string;
  weekOf: unknown;
  totalScore: number;
  formVersion: number | null;
  kind?: string | null;
  averageScore: string | number | null;
  rating: string;
  superintendentName: string | null;
  pmName: string | null;
  projectNumber: string | null;
  criticalDeficiencies: string[] | null;
  submittedByName: string | null;
  submittedAt: unknown;
  superintendentSignature?: string | null;
  pmSignature?: string | null;
  pdfR2Key?: string | null;
  pdfGeneratedAt?: unknown;
}

// job_type string — MUST match the worker's registerJobHandler(FIELD_SCORECARD_EMAIL_JOB, ...). The server
// can't import from the worker package, so the string is duplicated (as with the other enqueue sites).
const FIELD_SCORECARD_EMAIL_JOB = "field_scorecard_email";
const SCORECARD_PDF_DOWNLOAD_EXPIRY_SECONDS = 60 * 60;
// Give the synchronous render + R2 upload (sub-second) a head start over the worker's poll, so the email
// job normally finds the PDF already stored. If render/upload failed, the worker degrades to a
// no-attachment notice — the notification is never lost.
const SCORECARD_EMAIL_RUN_AFTER_SECONDS = 120;
const PDF_EVIDENCE_DOWNLOAD_CONCURRENCY = 4;

/**
 * Deterministic R2 key for a scorecard's PDF. Shared by the enqueue (createFieldScorecard, which stamps it
 * into the job payload IN the submit txn) and the render/upload (finalizeFieldScorecardArtifacts), so the
 * worker fetches exactly what was stored. RAW deal_number (photo-report key convention), else the deal id.
 */
export function scorecardPdfR2Key(
  officeSlug: string,
  dealNumber: string | null | undefined,
  dealId: string,
  scorecardId: string,
): string {
  const segment = dealNumber?.trim() || dealId;
  return `office_${officeSlug}/deals/${segment}/documents/scorecards/${scorecardId}.pdf`;
}

/**
 * Persist a submitted scorecard. Server is the scoring authority: it gates on the deal being a
 * browsable field project, re-validates every section, recomputes total + rating, enforces the
 * action-item gate, and resolves photo evidence by clientUploadId (asserting each belongs to this deal
 * and is still active). Idempotent on `clientSubmissionId` — a retried offline submit returns the
 * existing card, never duplicates. The caller (route) wraps this in an office transaction; the email job
 * is enqueued in that SAME txn (durable outbox) so a post-response render/upload failure or process death
 * can't drop the notification.
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

  // Leadership is a distinct scorecard KIND in the same tables: 4 categories rated 1-10 (average out of
  // 10, V2 bands), no deficiencies, no signatures; a free-text summary + photos attach to the Project
  // Summary. It always uses the V2-style 1-10 average scoring under the hood.
  const kind: ScorecardKind = input.kind === "leadership" ? "leadership" : "project";
  const formVersion: ScorecardFormVersion = kind === "leadership" ? 2 : input.formVersion === 2 ? 2 : 1;
  const items = validateItems(input.items, formVersion, kind);
  // Leadership cards don't support critical deficiencies. Reject a submission that carries any (rather than
  // silently dropping them) so a client bug can't quietly discard flagged concerns — the parser guards the
  // HTTP boundary, and this mirrors it for direct service callers. Project cards validate as before.
  if (kind === "leadership" && (input.criticalDeficiencies.length > 0 || Object.keys(input.criticalDeficiencyNotes ?? {}).length > 0)) {
    throw new AppError(400, "Leadership scorecards do not support critical deficiencies.");
  }
  const deficiencies = kind === "leadership" ? [] : validateDeficiencies(input.criticalDeficiencies, formVersion);
  const deficiencyNotes = kind === "leadership"
    ? {}
    : validateDeficiencyNotes(input.criticalDeficiencyNotes ?? {}, deficiencies, formVersion);
  const averageScore = kind === "leadership"
    ? computeScorecardLeadershipAverage(items as { sectionKey: ScorecardLeadershipSectionKey; points: number }[])
    : formVersion === 2
    ? computeScorecardV2Average(items as { sectionKey: ScorecardV2SectionKey; points: number }[])
    : null;
  // `total_score` remains populated for existing reports. V2/leadership store average * 10 beside the
  // true average.
  const total = averageScore != null
    ? Math.round(averageScore * 10)
    : computeScorecardTotal(items as { sectionKey: ScorecardSectionKey; points: number }[]);
  const rating = kind === "leadership"
    ? resolveScorecardLeadershipRating(averageScore ?? 0)
    : formVersion === 2
    ? resolveScorecardV2Rating(averageScore ?? 0)
    : resolveScorecardRating(total);

  const actionItems = kind === "leadership" ? [] : input.actionItems.map((s) => s.trim()).filter((s) => s.length > 0);
  if (formVersion === 1 && actionItemsRequired({ total, deficiencyCount: deficiencies.length }) && actionItems.length === 0) {
    throw new AppError(
      422,
      "At least one action item is required when the score is below 85 or any critical deficiency is flagged.",
    );
  }

  const photoLinks = await resolvePhotoLinks(tenantDb, input, formVersion, kind, deficiencies);
  // Week Of is the LOCAL date the field app stamps (todayIso, device-local) — trust it for every kind rather
  // than recomputing here. The server runs in UTC, so `new Date().toISOString()` stamped the NEXT day for any
  // evening submit west of UTC (e.g. 8 PM CDT files under tomorrow) — that off-by-one hit every leadership/V2
  // card, which always took this path. Mirrors the project card, which already persists the client's local weekOf.
  const weekOf = input.weekOf;
  // Persist the summary for leadership cards only (bounded); project cards never carry one.
  const summary = kind === "leadership" ? (input.summary?.trim() ? input.summary.trim().slice(0, 8000) : null) : null;

  // ON CONFLICT DO NOTHING keeps the transaction usable if a concurrent retry inserted the same
  // clientSubmissionId first — catching a 23505 here would instead poison the open txn (aborted state).
  const inserted = await tenantDb
    .insert(fieldScorecards)
    .values({
      clientSubmissionId: input.clientSubmissionId,
      dealId: input.dealId,
      weekOf,
      // Snapshot the SERVER-resolved canonical display number (project_number, else non-HubSpot
      // deal_number, else null) — never the client-sent value, which may be stale/spoofed/absent.
      projectNumber: project.projectNumber ?? null,
      superintendentName: input.superintendentName ?? null,
      pmName: input.pmName ?? null,
      formVersion,
      kind,
      summary,
      averageScore: averageScore == null ? null : String(averageScore),
      superintendentSignature: normalizeSignature(input.superintendentSignature),
      pmSignature: normalizeSignature(input.pmSignature),
      totalScore: total,
      rating,
      criticalDeficiencies: deficiencies,
      criticalDeficiencyNotes: deficiencyNotes,
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
      .values(photoLinks.map((p) => ({ scorecardId: card.id, sectionKey: p.sectionKey, deficiencyKey: p.deficiencyKey ?? null, fileId: p.fileId })));
  }

  // Durable outbox: enqueue the email job IN THIS TRANSACTION so it commits atomically with the scorecard.
  // The PDF is rendered + stored post-response (best-effort); if that fails or the process dies first, the
  // job still exists and the worker sends a no-attachment fallback — the notification is never dropped.
  // Deterministic key matches what finalizeFieldScorecardArtifacts uploads.
  const pdfR2Key = scorecardPdfR2Key(input.office.slug, project.dealNumber, input.dealId, card.id);
  // Route the scorecard email to the deal's assigned superintendent + project_manager (resolved from the
  // active deal_team_members rows → linked user/contact email). Nulls when a role is unassigned or has no
  // email — the worker just skips that CC. Read inside the submit txn so the recipients commit atomically
  // with the card + job (durable outbox).
  const teamEmails = await resolveScorecardTeamEmails(tenantDb, input.dealId);
  await tenantDb.insert(jobQueue).values({
    jobType: FIELD_SCORECARD_EMAIL_JOB,
    payload: {
      tenantSchema: `office_${input.office.slug}`,
      scorecardId: card.id,
      dealId: input.dealId,
      dealName: project.name,
      projectNumber: project.projectNumber ?? null,
      weekOf,
      totalScore: total,
      formVersion,
      kind,
      averageScore,
      ratingLabel: ratingLabelFor(kind, formVersion, rating),
      submittedByName: input.submittedByName ?? null,
      superintendentEmail: teamEmails.superintendentEmail,
      projectManagerEmail: teamEmails.projectManagerEmail,
      pdfR2Key,
      officeId: input.office.id,
    },
    officeId: input.office.id,
    status: "pending",
    runAfter: new Date(Date.now() + SCORECARD_EMAIL_RUN_AFTER_SECONDS * 1000),
    maxAttempts: 6,
  });

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
      sc.form_version AS "formVersion",
      sc.kind AS "kind",
      sc.average_score AS "averageScore",
      sc.rating AS "rating",
      sc.superintendent_name AS "superintendentName",
      sc.pm_name AS "pmName",
      sc.project_number AS "projectNumber",
      sc.critical_deficiencies AS "criticalDeficiencies",
      sc.submitted_by_name AS "submittedByName",
      sc.week_of::text AS "weekOf",
      sc.submitted_at AS "submittedAt",
      sc.pdf_r2_key AS "pdfR2Key",
      sc.pdf_generated_at AS "pdfGeneratedAt"
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
  const sectionKeys: readonly string[] = card.kind === "leadership"
    ? FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS
    : card.formVersion === 2
    ? FIELD_SCORECARD_V2_SECTION_KEYS
    : FIELD_SCORECARD_SECTION_KEYS;
  const items = sectionKeys.filter((k) => itemByKey.has(k)).map((k) => {
    const r = itemByKey.get(k)!;
    return { sectionKey: k as FieldScorecardDetail["items"][number]["sectionKey"], points: r.points, note: r.note ?? null };
  });

  const photoRows = await tenantDb
    .select({
      id: fieldScorecardPhotos.id,
      sectionKey: fieldScorecardPhotos.sectionKey,
      deficiencyKey: fieldScorecardPhotos.deficiencyKey,
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
      sectionKey: p.sectionKey as FieldScorecardDetail["photos"][number]["sectionKey"],
      deficiencyKey: p.deficiencyKey ?? null,
      fileId: p.fileId,
      url: opts?.resolvePhotoUrl ? await opts.resolvePhotoUrl(p.fileId) : null,
      caption: p.caption ?? null,
    })),
  );

  return {
    ...toSummary(card),
    items,
    criticalDeficiencies: card.criticalDeficiencies ?? [],
    criticalDeficiencyNotes: card.criticalDeficiencyNotes ?? {},
    actionItems: card.actionItems ?? [],
    photos,
    superintendentSignature: card.superintendentSignature ?? null,
    pmSignature: card.pmSignature ?? null,
    summary: card.summary ?? null,
  };
}

/**
 * Render + store the scorecard PDF (best-effort), then record its key. The email job was ALREADY enqueued
 * durably in the submit txn (createFieldScorecard), so this is purely artifact production: called
 * POST-COMMIT so R2 I/O never holds a txn open, and a throw here is harmless (the caller swallows it; the
 * worker sends a no-attachment fallback if the PDF isn't there). Uses the SAME key builder as the enqueue,
 * so the worker fetches exactly what this uploads. Manages its own connections.
 */
export async function finalizeFieldScorecardArtifacts(
  office: { id: string; slug: string },
  userId: string,
  scorecardId: string,
): Promise<void> {
  // 1. READ the scorecard + items + deal on a read-only connection.
  const loaded = await runInOffice(office, async (db) => {
    const [card] = await db.select().from(fieldScorecards).where(eq(fieldScorecards.id, scorecardId)).limit(1);
    if (!card) return null;
    const itemRows = await db
      .select()
      .from(fieldScorecardItems)
      .where(eq(fieldScorecardItems.scorecardId, scorecardId));
    const photoRows = await db
      .select({
        sectionKey: fieldScorecardPhotos.sectionKey,
        deficiencyKey: fieldScorecardPhotos.deficiencyKey,
        caption: files.description,
        r2Key: files.r2Key,
        thumbnailR2Key: files.thumbnailR2Key,
        mimeType: files.mimeType,
      })
      .from(fieldScorecardPhotos)
      .innerJoin(files, eq(files.id, fieldScorecardPhotos.fileId))
      .where(eq(fieldScorecardPhotos.scorecardId, scorecardId))
      // Deterministic order (link time, then PK tie-breaker) so the downstream MAX_EVIDENCE_PHOTOS cap
      // always keeps/drops the SAME photos across renders, not an arbitrary Postgres physical-row order.
      .orderBy(fieldScorecardPhotos.createdAt, fieldScorecardPhotos.id);
    const [deal] = await db
      .select({ name: deals.name, dealNumber: deals.dealNumber })
      .from(deals)
      .where(eq(deals.id, card.dealId))
      .limit(1);
    return { card, itemRows, photoRows, deal: deal ?? null };
  });
  if (!loaded) return;
  const { card, itemRows, photoRows, deal } = loaded;

  // Cap + prioritize BEFORE downloading bytes: a scorecard may carry up to 100 photos but the PDF embeds
  // at most MAX_EVIDENCE_PHOTOS, so fetching/transcoding the rest is wasted R2/CPU (and lengthens the
  // post-response render, making the email more likely to send without the PDF). Deficiency evidence is
  // kept first; the omitted count drives the PDF's "available in the CRM" note.
  const { keep: photosToLoad, omitted: omittedEvidenceCount } = prioritizeAndCapEvidencePhotos(photoRows, MAX_EVIDENCE_PHOTOS);

  // Resolve each kept evidence tile to a small JPEG (thumbnail-first, transcoded-original fallback — see
  // loadScorecardEvidenceImage). A miss leaves an explicit placeholder in the PDF, never a broken render.
  const loadPhoto = async (photo: typeof photosToLoad[number]) => ({
    sectionKey: photo.sectionKey,
    deficiencyKey: photo.deficiencyKey ?? null,
    caption: photo.caption ?? null,
    image: await loadScorecardEvidenceImage(photo),
  });
  const photos: Awaited<ReturnType<typeof loadPhoto>>[] = [];
  for (let index = 0; index < photosToLoad.length; index += PDF_EVIDENCE_DOWNLOAD_CONCURRENCY) {
    const batch = photosToLoad.slice(index, index + PDF_EVIDENCE_DOWNLOAD_CONCURRENCY);
    photos.push(...await Promise.all(batch.map(loadPhoto)));
  }

  const pdfData = buildScorecardPdfData({
    dealName: deal?.name ?? "Project",
    projectNumber: card.projectNumber ?? null,
    weekOf: typeof card.weekOf === "string" ? card.weekOf : String(card.weekOf),
    superintendentName: card.superintendentName ?? null,
    pmName: card.pmName ?? null,
    submittedByName: card.submittedByName ?? null,
    submittedAt: toIso(card.submittedAt),
    totalScore: card.totalScore,
    formVersion: card.formVersion === 2 ? 2 : 1,
    kind: card.kind === "leadership" ? "leadership" : "project",
    summary: card.summary ?? null,
    averageScore: card.averageScore == null ? null : Number(card.averageScore),
    superintendentSignature: card.superintendentSignature ?? null,
    pmSignature: card.pmSignature ?? null,
    rating: card.rating as ScorecardRating,
    items: itemRows.map((r) => ({ sectionKey: r.sectionKey, points: r.points, note: r.note ?? null })),
    criticalDeficiencyKeys: card.criticalDeficiencies ?? [],
    criticalDeficiencyNotes: card.criticalDeficiencyNotes ?? {},
    actionItems: card.actionItems ?? [],
    photos,
    omittedEvidenceCount,
  });
  const bucket = process.env.R2_BUCKET_NAME || "trock-crm-files";
  // Same deterministic key the enqueue (createFieldScorecard) stamped into the job payload.
  const r2Key = scorecardPdfR2Key(office.slug, deal?.dealNumber, card.dealId, scorecardId);

  // Render + store the PDF. A throw propagates to the caller's .catch — harmless, the email job is already
  // enqueued (submit txn) and the worker sends the no-attachment fallback if this key stays empty.
  const pdf = await renderFieldScorecardPdf(pdfData);
  await putObject(r2Key, pdf, "application/pdf");
  await runInOfficeTransaction(office, userId, async (db) => {
    await db
      .update(fieldScorecards)
      .set({ pdfR2Key: r2Key, pdfR2Bucket: bucket, pdfGeneratedAt: new Date() })
      .where(eq(fieldScorecards.id, scorecardId));
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

function validateItems(
  rawItems: CreateFieldScorecardInput["items"],
  formVersion: ScorecardFormVersion,
  kind: ScorecardKind,
): ValidatedItem[] {
  const allowedKeys: readonly string[] = kind === "leadership"
    ? FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS
    : formVersion === 2
    ? FIELD_SCORECARD_V2_SECTION_KEYS
    : FIELD_SCORECARD_SECTION_KEYS;
  const seen = new Map<string, ValidatedItem>();
  for (const it of rawItems) {
    const validKey = kind === "leadership"
      ? isLeadershipSectionKey(it.sectionKey)
      : formVersion === 2
      ? isScorecardV2SectionKey(it.sectionKey)
      : isScorecardSectionKey(it.sectionKey);
    if (!validKey) {
      throw new AppError(422, `Unknown scorecard section: ${it.sectionKey}`);
    }
    if (seen.has(it.sectionKey)) {
      throw new AppError(422, `Duplicate scorecard section: ${it.sectionKey}`);
    }
    // Leadership + V2 categories are each rated 1-10; V1 sections use their fixed option ladder.
    const legalPoints = kind === "leadership" || formVersion === 2
      ? Number.isInteger(it.points) && it.points >= 1 && it.points <= 10
      : isLegalSectionPoints(it.sectionKey as ScorecardSectionKey, it.points);
    if (!legalPoints) {
      throw new AppError(422, `Invalid point value ${it.points} for section ${it.sectionKey}.`);
    }
    seen.set(it.sectionKey, { sectionKey: it.sectionKey as ValidatedItem["sectionKey"], points: it.points, note: it.note?.trim() ? it.note.trim() : null });
  }
  const missing = allowedKeys.filter((k) => !seen.has(k));
  if (missing.length > 0) {
    throw new AppError(422, `Missing scorecard section(s): ${missing.join(", ")}.`);
  }
  // Canonical section order.
  return allowedKeys.map((k) => seen.get(k)!);
}

/** The rating-band label for the card's kind/version — leadership reuses the V2 bands + labels. */
function ratingLabelFor(kind: ScorecardKind, formVersion: ScorecardFormVersion, rating: ScorecardRating): string {
  if (kind === "leadership") return scorecardLeadershipRatingLabel(rating);
  return formVersion === 2 ? scorecardV2RatingLabel(rating) : scorecardRatingLabel(rating);
}

function validateDeficiencies(keys: string[], formVersion: ScorecardFormVersion): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const valid = formVersion === 2 ? isScorecardV2CriticalDeficiencyKey(k) : isScorecardCriticalDeficiencyKey(k);
    if (!valid) {
      throw new AppError(422, `Unknown critical deficiency: ${k}`);
    }
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

function validateDeficiencyNotes(
  notes: Record<string, string>,
  deficiencies: string[],
  formVersion: ScorecardFormVersion,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(notes)) {
    const valid = formVersion === 2 ? isScorecardV2CriticalDeficiencyKey(key) : isScorecardCriticalDeficiencyKey(key);
    if (!valid || !deficiencies.includes(key)) {
      throw new AppError(422, `Critical-deficiency description does not match a selected deficiency: ${key}.`);
    }
    const text = value.trim();
    if (text) out[key] = text.slice(0, 4000);
  }
  return out;
}

async function resolvePhotoLinks(
  tenantDb: TenantDb,
  input: CreateFieldScorecardInput,
  formVersion: ScorecardFormVersion,
  kind: ScorecardKind,
  deficiencies: string[],
): Promise<{ sectionKey: string; deficiencyKey: string | null; fileId: string }[]> {
  for (const p of input.photos) {
    if (kind === "leadership") {
      // Leadership photos attach ONLY to the Project Summary — no per-category or deficiency evidence.
      if (p.sectionKey !== FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY) {
        throw new AppError(422, `Unknown scorecard section: ${p.sectionKey}`);
      }
      continue;
    }
    const validSection = formVersion === 2 ? isScorecardV2SectionKey(p.sectionKey) : isScorecardSectionKey(p.sectionKey);
    const deficiencyEvidence = formVersion === 2 && p.sectionKey === "critical_deficiency" && p.deficiencyKey && deficiencies.includes(p.deficiencyKey);
    if (!validSection && !deficiencyEvidence) {
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

  const links: { sectionKey: string; deficiencyKey: string | null; fileId: string }[] = [];
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
    links.push({ sectionKey: p.sectionKey, deficiencyKey: p.deficiencyKey ?? null, fileId: file.id });
  }
  return links;
}

function toSummary(row: ScorecardSummarySource): FieldScorecardSummary {
  const formVersion: ScorecardFormVersion = row.formVersion === 2 ? 2 : 1;
  const kind: ScorecardKind = row.kind === "leadership" ? "leadership" : "project";
  const rating = row.rating as ScorecardRating;
  return {
    id: row.id,
    dealId: row.dealId,
    weekOf: typeof row.weekOf === "string" ? row.weekOf : String(row.weekOf),
    totalScore: row.totalScore,
    formVersion,
    kind,
    averageScore: row.averageScore == null ? null : Number(row.averageScore),
    rating,
    ratingLabel: ratingLabelFor(kind, formVersion, rating),
    superintendentName: row.superintendentName ?? null,
    pmName: row.pmName ?? null,
    projectNumber: row.projectNumber ?? null,
    criticalDeficiencyCount: (row.criticalDeficiencies ?? []).length,
    submittedByName: row.submittedByName ?? null,
    submittedAt: toIso(row.submittedAt),
    // PDF is rendered/uploaded post-response (best-effort/async) — null right after submit until the
    // artifact lands. Surface availability so downstream (mobile + CRM) can gate the download action.
    hasPdf: Boolean(row.pdfR2Key ?? row.pdfGeneratedAt),
  };
}

function normalizeSignature(value: string | null | undefined): string | null {
  const signature = value?.trim() ?? "";
  if (!signature) return null;
  if (signature.length > 500_000) throw new AppError(400, "Signature is too large.");
  return signature;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
