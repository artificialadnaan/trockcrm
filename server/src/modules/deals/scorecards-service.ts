import { and, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { fieldScorecards, fieldScorecardItems, fieldScorecardPhotos, files } from "@trock-crm/shared/schema";
import {
  FIELD_SCORECARD_SECTION_KEYS,
  scorecardLeadershipRatingLabel,
  scorecardRatingLabel,
  scorecardV2RatingLabel,
  type FieldScorecardDetail,
  type FieldScorecardSummary,
  type ScorecardFormVersion,
  type ScorecardKind,
  type ScorecardRating,
  type ScorecardSectionKey,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { generateDownloadUrl } from "../../lib/r2-client.js";

// Tenant-scoped (web CRM) reads of the Field Scorecards a rep submitted from T-Rock Cam. The DEAL ROUTE
// already gates access (assertDealCollaboratorAccess) before these run, so — unlike the field module's
// services — these do NOT re-apply the field-contractor / browsable-project gate. Every query is scoped by
// BOTH scorecard id AND dealId so a scorecard can't be read through the wrong deal's endpoint.

type TenantDb = NodePgDatabase<typeof schema>;
const SCORECARD_PDF_DOWNLOAD_EXPIRY_SECONDS = 60 * 60;

// The deal-tab LIST + PDF-download surface BOTH kinds — leadership cards share the field_scorecards table
// (kind = 'leadership') and need a CRM surface (the completed-email fallback tells recipients to open the
// deal). Each summary row carries its `kind` so the web tab branches: project rows expand into the detail
// view (project shape); leadership rows offer the PDF (their "detail" is the PDF). The DETAIL read stays
// project-only via this predicate — it maps items through FIELD_SCORECARD_SECTION_KEYS (a project shape),
// so a leadership card must 404 there rather than render as a mangled project card. COALESCE treats any
// legacy NULL/absent kind as a project card (the pre-leadership default).
const projectKindOnly = sql`COALESCE(${fieldScorecards.kind}, 'project') = 'project'`;

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
        projectKindOnly,
      ),
    )
    .limit(1);
  if (!card) throw new AppError(404, "Scorecard not found");

  const itemRows = await tenantDb
    .select()
    .from(fieldScorecardItems)
    .where(eq(fieldScorecardItems.scorecardId, scorecardId));
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
    .where(eq(fieldScorecardPhotos.scorecardId, scorecardId));

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

/** Presigned URL for a scorecard's stored PDF. 404s while the PDF is still generating (no key yet). */
export async function getDealScorecardPdfDownload(
  tenantDb: TenantDb,
  dealId: string,
  scorecardId: string,
): Promise<{ url: string }> {
  // Both kinds are downloadable from the deal — leadership's "detail" IS its PDF (no project detail view).
  const [card] = await tenantDb
    .select({ pdfR2Key: fieldScorecards.pdfR2Key })
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
  if (!card.pdfR2Key) throw new AppError(404, "The scorecard PDF is still generating — please try again shortly.");
  const url = await generateDownloadUrl(card.pdfR2Key, SCORECARD_PDF_DOWNLOAD_EXPIRY_SECONDS, `field-scorecard-${scorecardId}.pdf`);
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
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
