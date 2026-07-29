import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
  files,
  scorecardCorrectiveActions,
} from "@trock-crm/shared/schema";
import {
  FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS,
  FIELD_SCORECARD_SECTION_KEYS,
  FIELD_SCORECARD_V2_SECTION_KEYS,
  scorecardLeadershipRatingLabel,
  scorecardRatingLabel,
  scorecardV2RatingLabel,
  type CorrectiveActionItemView,
  type FieldScorecardDetail,
  type FieldScorecardSummary,
  type ScorecardFormVersion,
  type ScorecardKind,
  type ScorecardRating,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { generateDownloadUrl } from "../../lib/r2-client.js";
import {
  needsScorecardPdfRegeneration,
  type ScorecardPdfArtifactState,
} from "../field/scorecard-pdf-artifact.js";
import {
  getCorrectiveActionEventsByItem,
  getDetachedCorrectiveActionEvents,
} from "../field/corrective-action-events.js";
import { isOriginalEvidencePhoto } from "../field/scorecard-evidence-predicate.js";

// Tenant-scoped (web CRM) reads of the Field Scorecards a rep submitted from T-Rock Cam. The DEAL ROUTE
// already gates access (assertDealCollaboratorAccess) before these run, so — unlike the field module's
// services — these do NOT re-apply the field-contractor / browsable-project gate. Every query is scoped by
// BOTH scorecard id AND dealId so a scorecard can't be read through the wrong deal's endpoint.

type TenantDb = NodePgDatabase<typeof schema>;
const SCORECARD_PDF_DOWNLOAD_EXPIRY_SECONDS = 60 * 60;

// The deal-tab LIST, DETAIL, + PDF-download surface BOTH kinds — leadership cards share the field_scorecards
// table (kind = 'leadership') and need a CRM surface (the completed-email fallback tells PM/Super recipients
// to open the deal, so the full card must be viewable even when the PDF hasn't landed yet). Each summary row
// carries its `kind` so the web tab branches, and the DETAIL read below is KIND-AWARE: it maps items through
// the section vocabulary for the card's kind (project → FIELD_SCORECARD_SECTION_KEYS / V2, leadership →
// FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS) so a leadership card resolves into its own shape (category scores +
// comment notes, Project Summary text, and category/project_summary photos) rather than 404ing or rendering mangled.

export async function listDealScorecards(
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

export async function getDealScorecardDetail(
  tenantDb: TenantDb,
  dealId: string,
  scorecardId: string,
  opts?: { resolvePhotoUrl?: (fileId: string) => Promise<string | null> },
): Promise<FieldScorecardDetail> {
  const [card] = await tenantDb
    .select()
    .from(fieldScorecards)
    .where(
      and(
        eq(fieldScorecards.id, scorecardId),
        eq(fieldScorecards.dealId, dealId),
        eq(fieldScorecards.isActive, true),
      ),
    )
    .limit(1);
  if (!card) throw new AppError(404, "Scorecard not found");

  const itemRows = await tenantDb
    .select()
    .from(fieldScorecardItems)
    .where(eq(fieldScorecardItems.scorecardId, scorecardId));
  const itemByKey = new Map(itemRows.map((r) => [r.sectionKey, r]));
  // Branch the section vocabulary on the card's kind so a leadership card maps its 4 categories (and a V2
  // project its 8 sections), not the V1 7-section set — mirrors getFieldScorecardDetail + the mobile detail.
  const sectionKeys: readonly string[] =
    card.kind === "leadership"
      ? FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS
      : card.formVersion === 2
        ? FIELD_SCORECARD_V2_SECTION_KEYS
        : FIELD_SCORECARD_SECTION_KEYS;
  const items = sectionKeys
    .filter((k) => itemByKey.has(k))
    .map((k) => {
      const r = itemByKey.get(k)!;
      return {
        sectionKey: k as FieldScorecardDetail["items"][number]["sectionKey"],
        points: r.points,
        note: r.note ?? null,
      };
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
    .where(
      and(
        eq(fieldScorecardPhotos.scorecardId, scorecardId),
        // ORIGINAL evidence only. A corrective-action RESPONSE photo (corrective_action_id set) is threaded
        // under correctiveActions[] below; excluding it here keeps it from double-rendering in the Evidence
        // grid AND avoids emitting a sectionKey: null row (a DTO violation — response photos have no section),
        // matching the PDF/edit evidence reads.
        isOriginalEvidencePhoto(),
      ),
    );

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

  // A below-band scorecard seeds one corrective-action item per flagged issue; read them + their inline
  // responses so the tab can thread each response under its original item (spec §9). A passing card has no
  // rows → correctiveActions is []. Response photos resolve their URL through the same presigner as evidence.
  const correctiveActions = await getScorecardCorrectiveActionThread(tenantDb, scorecardId, opts?.resolvePhotoUrl);
  // Thread entries whose flagged item a later edit removed. Loaded UNCONDITIONALLY: the case that matters is
  // the one where every item was removed, which is precisely when a per-item read returns nothing and the
  // history would silently disappear from the CRM.
  const detached = await getDetachedCorrectiveActionEvents(tenantDb, scorecardId);
  // Their photos SURVIVE the item now (0202 sets the item link null rather than cascading), so hard-coding
  // an empty set would discard the very evidence the detachment was designed to keep.
  const detachedPhotoRows = detached.length
    ? await tenantDb
        .select({
          id: fieldScorecardPhotos.id,
          correctiveActionEventId: fieldScorecardPhotos.correctiveActionEventId,
          fileId: fieldScorecardPhotos.fileId,
          caption: files.description,
        })
        .from(fieldScorecardPhotos)
        .innerJoin(
          files,
          and(eq(files.id, fieldScorecardPhotos.fileId), eq(files.isActive, true), isNull(files.deletedAt)),
        )
        .where(
          inArray(
            fieldScorecardPhotos.correctiveActionEventId,
            detached.map((e) => e.id),
          ),
        )
    : [];
  const detachedByEvent = new Map<string, typeof detachedPhotoRows>();
  for (const row of detachedPhotoRows) {
    if (!row.correctiveActionEventId) continue;
    const list = detachedByEvent.get(row.correctiveActionEventId) ?? [];
    list.push(row);
    detachedByEvent.set(row.correctiveActionEventId, list);
  }
  const removedItemEvents = await Promise.all(
    detached.map(async (event) => ({
      id: event.id,
      eventType: event.eventType,
      itemLabel: event.itemLabel,
      actorName: event.actorName ?? event.actorEmail ?? null,
      actorEmail: event.actorEmail,
      comment: event.comment,
      createdAt: event.createdAt,
      photos: await Promise.all(
        (detachedByEvent.get(event.id) ?? []).map(async (p) => ({
          id: p.id,
          fileId: p.fileId,
          url: opts?.resolvePhotoUrl ? await opts.resolvePhotoUrl(p.fileId) : null,
          caption: p.caption ?? null,
        })),
      ),
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
    // Leadership Project Summary free text; null for project cards.
    summary: card.summary ?? null,
    correctiveActions,
    removedItemEvents,
  };
}

/**
 * The corrective-action items for a scorecard (each flagged action item / critical deficiency) with their
 * inline response (comment + responder + response photos), for the deal-tab thread. Unlike Plan 2's
 * getCorrectiveActionItems (which 404s a scorecard with no items), this returns [] for a passing card so the
 * detail read never throws. Response photos (corrective_action_id set) resolve their presigned URL.
 */
async function getScorecardCorrectiveActionThread(
  tenantDb: TenantDb,
  scorecardId: string,
  resolvePhotoUrl?: (fileId: string) => Promise<string | null>,
): Promise<CorrectiveActionItemView[]> {
  const rows = await tenantDb
    .select()
    .from(scorecardCorrectiveActions)
    .where(eq(scorecardCorrectiveActions.scorecardId, scorecardId))
    // Group by kind (item_type), then order refs NUMERICALLY (mirrors getCorrectiveActionItems): an
    // action-item item_ref is a numeric STRING, so a lexical sort gives 0,1,10,11,2,… once there are ≥11
    // items. Zero-pad numeric refs so they sort numerically; deficiency KEY refs (non-numeric) fall through.
    .orderBy(
      scorecardCorrectiveActions.itemType,
      sql`CASE WHEN ${scorecardCorrectiveActions.itemRef} ~ '^[0-9]+$' THEN lpad(${scorecardCorrectiveActions.itemRef}, 12, '0') ELSE ${scorecardCorrectiveActions.itemRef} END`,
    );
  if (rows.length === 0) return [];

  const itemIds = rows.map((r) => r.id);
  const photoRows = await tenantDb
    .select({
      id: fieldScorecardPhotos.id,
      correctiveActionId: fieldScorecardPhotos.correctiveActionId,
      // Which ATTEMPT filed it, so the thread can show each round's own evidence rather than one merged pile.
      correctiveActionEventId: fieldScorecardPhotos.correctiveActionEventId,
      fileId: fieldScorecardPhotos.fileId,
      caption: files.description,
    })
    .from(fieldScorecardPhotos)
    // INNER join on the active-file predicate: a LEFT join keeps the photo row (fileId still set) for a
    // soft-deleted/inactive backing file, so resolvePhotoUrl would still run on a stale file → a broken photo
    // in the deal thread. INNER dropping the link entirely when its file is inactive/soft-deleted.
    .innerJoin(
      files,
      and(eq(files.id, fieldScorecardPhotos.fileId), eq(files.isActive, true), isNull(files.deletedAt)),
    )
    .where(inArray(fieldScorecardPhotos.correctiveActionId, itemIds));

  type PhotoRow = { id: string; fileId: string; caption: string | null };
  const photosByItem = new Map<string, PhotoRow[]>();
  const photosByEvent = new Map<string, PhotoRow[]>();
  for (const p of photoRows) {
    if (!p.correctiveActionId) continue;
    const view: PhotoRow = { id: p.id, fileId: p.fileId, caption: p.caption ?? null };
    const list = photosByItem.get(p.correctiveActionId) ?? [];
    list.push(view);
    photosByItem.set(p.correctiveActionId, list);
    if (p.correctiveActionEventId) {
      const perEvent = photosByEvent.get(p.correctiveActionEventId) ?? [];
      perEvent.push(view);
      photosByEvent.set(p.correctiveActionEventId, perEvent);
    }
  }

  // THE thread. This mapper is a second implementation of the same view as corrective-action-api.ts, and it
  // silently lacked events entirely — so the approval UI rendered an empty thread on the CRM surface the
  // whole feature exists for, while the responder API returned it correctly. A parity test now pins that the
  // two readers agree; until they are merged, anything added to one has to be added here too.
  const eventsByItem = await getCorrectiveActionEventsByItem(tenantDb, scorecardId);
  const resolvePhotos = async (photos: PhotoRow[]) =>
    Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        fileId: p.fileId,
        url: resolvePhotoUrl ? await resolvePhotoUrl(p.fileId) : null,
        caption: p.caption,
      })),
    );

  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      itemType: r.itemType,
      itemRef: r.itemRef,
      itemLabel: r.itemLabel,
      status: r.status,
      responseComment: r.responseComment ?? null,
      respondedByUserId: r.respondedByUserId ?? null,
      responderName: r.responderName ?? null,
      responderEmail: r.responderEmail ?? null,
      respondedAt: r.respondedAt ? r.respondedAt.toISOString() : null,
      photos: await resolvePhotos(photosByItem.get(r.id) ?? []),
      events: await Promise.all(
        (eventsByItem.get(r.id) ?? []).map(async (event) => ({
          id: event.id,
          eventType: event.eventType,
          actorName: event.actorName ?? event.actorEmail ?? null,
          actorEmail: event.actorEmail,
          comment: event.comment,
          createdAt: event.createdAt,
          photos: await resolvePhotos(photosByEvent.get(event.id) ?? []),
        })),
      ),
    })),
  );
}

/**
 * Inspect a deal-scoped scorecard's artifact state. The route has already applied collaborator access and
 * commits its tenant transaction before it performs any potentially slow R2 reads or regeneration.
 */
export async function getDealScorecardPdfArtifactState(
  tenantDb: TenantDb,
  dealId: string,
  scorecardId: string,
): Promise<ScorecardPdfArtifactState & { needsRegeneration: boolean }> {
  // Both kinds are downloadable from the deal — leadership's "detail" IS its PDF (no project detail view).
  const [card] = await tenantDb
    .select({
      pdfR2Key: fieldScorecards.pdfR2Key,
      pdfRenderVersion: fieldScorecards.pdfRenderVersion,
      pdfContentGeneration: fieldScorecards.pdfContentGeneration,
      currentGeneration: fieldScorecards.updatedAt,
      linkedPhotoCount: sql<number>`COUNT(${files.id})::int`,
    })
    .from(fieldScorecards)
    .leftJoin(fieldScorecardPhotos, eq(fieldScorecardPhotos.scorecardId, fieldScorecards.id))
    .leftJoin(
      files,
      and(
        eq(files.id, fieldScorecardPhotos.fileId),
        eq(files.isActive, true),
        isNull(files.deletedAt),
      ),
    )
    .where(
      and(
        eq(fieldScorecards.id, scorecardId),
        eq(fieldScorecards.dealId, dealId),
        eq(fieldScorecards.isActive, true),
      ),
    )
    .groupBy(
      fieldScorecards.id,
      fieldScorecards.pdfR2Key,
      fieldScorecards.pdfRenderVersion,
      fieldScorecards.pdfContentGeneration,
      fieldScorecards.updatedAt,
    )
    .limit(1);
  if (!card) throw new AppError(404, "Scorecard not found");
  const state: ScorecardPdfArtifactState = {
    pdfR2Key: card.pdfR2Key,
    pdfRenderVersion: card.pdfRenderVersion,
    linkedPhotoCount: Number(card.linkedPhotoCount),
    pdfContentGeneration: card.pdfContentGeneration,
    currentGeneration: card.currentGeneration,
  };
  return { ...state, needsRegeneration: needsScorecardPdfRegeneration(state) };
}

/** Presign a known-current deal scorecard PDF after any required regeneration has completed. */
export async function presignDealScorecardPdf(scorecardId: string, pdfR2Key: string): Promise<{ url: string }> {
  const url = await generateDownloadUrl(pdfR2Key, SCORECARD_PDF_DOWNLOAD_EXPIRY_SECONDS, `field-scorecard-${scorecardId}.pdf`);
  return { url };
}

// ── internals ───────────────────────────────────────────────────────────────

interface ScorecardRow {
  id: string;
  dealId: string;
  weekOf: unknown;
  totalScore: number;
  formVersion: number | null;
  kind: string | null;
  averageScore: string | number | null;
  rating: string;
  superintendentName: string | null;
  pmName: string | null;
  projectNumber: string | null;
  criticalDeficiencies: string[] | null;
  submittedByName: string | null;
  submittedAt: unknown;
  pdfR2Key: string | null;
  pdfGeneratedAt: unknown;
  status?: string | null;
  updatedAt?: unknown;
}

/** The rating-band label for the card's kind/version — leadership + V2 reuse the 1-10 bands. */
function ratingLabelFor(kind: ScorecardKind, formVersion: ScorecardFormVersion, rating: ScorecardRating): string {
  if (kind === "leadership") return scorecardLeadershipRatingLabel(rating);
  return formVersion === 2 ? scorecardV2RatingLabel(rating) : scorecardRatingLabel(rating);
}

function toSummary(row: ScorecardRow): FieldScorecardSummary {
  const rating = row.rating as ScorecardRating;
  const formVersion: ScorecardFormVersion = row.formVersion === 2 ? 2 : 1;
  const kind: ScorecardKind = row.kind === "leadership" ? "leadership" : "project";
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
    // The stored PDF is rendered best-effort/async, so the key can still be null here. Signal availability
    // so the CRM tab gates the Download-PDF action (disabled "PDF generating…" until the artifact lands).
    hasPdf: Boolean(row.pdfR2Key ?? row.pdfGeneratedAt),
    // Lifecycle status: `submitted` | `corrective_action_open` | `corrective_action_closed`. Drives the deal
    // tab's open/closed badge + the QC dashboard status column. Older rows default to `submitted`.
    status: row.status ?? "submitted",
    // The content generation, which the shared type already documents as the optimistic-concurrency token.
    // An approver sends it back with their verdict: the attempt guard binds to the corrective-action
    // RESPONSE, and a card stays editable while it awaits approval, so scores/notes/signatures/original
    // evidence can change under a reviewer without touching any event this thread contains.
    updatedAt: row.updatedAt == null ? undefined : toIso(row.updatedAt),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
