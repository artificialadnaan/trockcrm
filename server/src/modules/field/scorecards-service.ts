import { and, desc, eq, getTableColumns, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  deals,
  fieldScorecardEditUploads,
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
  files,
  jobQueue,
} from "@trock-crm/shared/schema";
import { generateDownloadUrl, headObjectStrict, putObject } from "../../lib/r2-client.js";
import { buildScorecardPdfData, renderFieldScorecardPdf, MAX_EVIDENCE_PHOTOS } from "./scorecard-pdf.js";
import {
  CURRENT_SCORECARD_PDF_RENDER_VERSION,
  coalesceScorecardPdfFinalization,
  isScorecardPdfObjectMetadataValid,
  needsScorecardPdfRegeneration,
  scorecardEvidenceFingerprint,
  type ScorecardPdfArtifactState,
} from "./scorecard-pdf-artifact.js";
import { prioritizeAndCapEvidencePhotos, resolveScorecardEvidenceImage } from "./scorecard-evidence-image.js";
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
import {
  markScorecardEditEvidenceLinked,
  EDITABLE_SCORECARD_STATUSES,
} from "./scorecard-evidence-upload.js";
import { reconcileScorecardCorrectiveActions } from "./corrective-actions-service.js";
import { isAssignedCorrectiveActionResponder } from "./corrective-action-recipients.js";
import {
  resolveScorecardResponderPick,
  type ScorecardResponderPick,
} from "./field-responders-service.js";

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
  /**
   * The field_responders roster person the field user PICKED for each role in the T-Rock Cam dropdown (null
   * when they typed a free-text name instead). Revalidated here against the ACTIVE roster + matching role
   * before storage; an unusable id degrades to null, never a rejected submit. Drives corrective-action +
   * completed-scorecard recipient resolution at SEND time, ahead of the deal's Team-tab super/PM.
   */
  superintendentResponderId?: string | null;
  pmResponderId?: string | null;
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

export interface UpdateFieldScorecardInput {
  userId: string;
  userRole: FieldAccessContext["userRole"];
  scorecardId: string;
  /** Owning office (id + slug) — used to enqueue the corrective-action notification if an edit opens it. */
  office: { id: string; slug: string };
  expectedUpdatedAt: string;
  superintendentName?: string | null;
  pmName?: string | null;
  /**
   * The picked roster person per role on THIS edit. The edit is a full replacement of the pair (name + link),
   * exactly like the names above: a client that omits these clears the stored link. That is the safe
   * direction — a link must never outlive the name it was picked for (an older app build re-typing the
   * superintendent would otherwise leave the previous person still receiving the corrective action), and a
   * cleared link simply falls back to the deal's Team-tab super/PM.
   */
  superintendentResponderId?: string | null;
  pmResponderId?: string | null;
  items: { sectionKey: string; points: number; note?: string | null }[];
  criticalDeficiencies: string[];
  criticalDeficiencyNotes?: Record<string, string>;
  actionItems: string[];
  photos: Array<
    | { scorecardPhotoId: string; clientUploadId?: never; sectionKey: string; deficiencyKey?: string | null }
    | { scorecardPhotoId?: never; clientUploadId: string; sectionKey: string; deficiencyKey?: string | null }
  >;
  superintendentSignature?: string | null;
  pmSignature?: string | null;
  summary?: string | null;
}

/** The revalidated picked-responder links for one scorecard: the rows to notify + the ids to store. */
interface ResolvedScorecardResponderLinks {
  superintendent: ScorecardResponderPick | null;
  pm: ScorecardResponderPick | null;
  superintendentResponderId: string | null;
  pmResponderId: string | null;
}

type ValidatedItem = {
  sectionKey: ScorecardSectionKey | ScorecardV2SectionKey | ScorecardLeadershipSectionKey;
  points: number;
  note: string | null;
};

type ResolvedUpdatePhoto = {
  linkId: string | null;
  fileId: string;
  sectionKey: string;
  deficiencyKey: string | null;
};

type CurrentScorecardPhoto = {
  id: string;
  fileId: string;
  sectionKey: string;
  deficiencyKey: string | null;
  isActive: boolean;
  deletedAt: Date | null;
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
  projectName?: string | null;
  projectNumber: string | null;
  criticalDeficiencies: string[] | null;
  status?: string;
  submittedByName: string | null;
  submittedBy?: string;
  submittedAt: unknown;
  updatedAt?: unknown;
  superintendentSignature?: string | null;
  pmSignature?: string | null;
  pdfR2Key?: string | null;
  pdfGeneratedAt?: unknown;
}

// job_type string — MUST match the worker's registerJobHandler(FIELD_SCORECARD_EMAIL_JOB, ...). The server
// can't import from the worker package, so the string is duplicated (as with the other enqueue sites).
const FIELD_SCORECARD_EMAIL_JOB = "field_scorecard_email";
// The below-band corrective-action notification job (job_type "scorecard_corrective_action_email") is
// enqueued by reconcileScorecardCorrectiveActions (corrective-actions-service.ts), shared by the create +
// edit paths, so its constant lives there.
const SCORECARD_PDF_DOWNLOAD_EXPIRY_SECONDS = 60 * 60;
// Give the synchronous render + R2 upload (sub-second) a head start over the worker's poll, so the email
// job normally finds the PDF already stored. If render/upload failed, the worker degrades to a
// no-attachment notice — the notification is never lost.
const SCORECARD_EMAIL_RUN_AFTER_SECONDS = 120;
const PDF_EVIDENCE_DOWNLOAD_CONCURRENCY = 4;

/**
 * Immutable, content-addressed R2 key for one scorecard PDF render. The renderer revision protects rolling
 * deploys, while the PDF digest protects concurrent same-revision renders: a stale render may finish and
 * leave an unreferenced object, but it can never overwrite the object a newer validated render published.
 * RAW deal_number (photo-report convention), else the deal id.
 */
export function scorecardPdfR2Key(
  officeSlug: string,
  dealNumber: string | null | undefined,
  dealId: string,
  scorecardId: string,
  renderVersion: number,
  pdfDigest: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(pdfDigest)) throw new Error("scorecard PDF digest must be a SHA-256 hex value");
  const segment = dealNumber?.trim() || dealId;
  return `office_${officeSlug}/deals/${segment}/documents/scorecards/${scorecardId}.${pdfDigest}.v${renderVersion}.pdf`;
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
  if (priorCard) return { scorecard: toSummary(priorCard, priorCard.projectName, input.userId), created: false };

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
  // Revalidate the picked roster links before they are stored: each must still be an ACTIVE field_responders
  // row of the MATCHING role, so a client can neither point the superintendent slot at a PM nor resurrect a
  // deactivated person. An unusable id resolves to null (see resolveValidResponderId) — the card still saves
  // and its recipients fall back to the deal team.
  const responderLinks = await resolveScorecardResponderLinks(tenantDb, input);
  // Week Of = the completion date, which the field app stamps LOCAL at SUBMIT time (submitScorecard →
  // todayLocalIso). Trust it rather than recomputing here: the server runs in UTC, so `new Date().toISOString()`
  // stamped the NEXT day for any evening submit west of UTC (8 PM CDT filed under tomorrow) AND can't see the
  // device's local day at all. Both kinds present Week Of as "set automatically when completed".
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
      superintendentResponderId: responderLinks.superintendentResponderId,
      pmResponderId: responderLinks.pmResponderId,
      formVersion,
      kind,
      summary,
      averageScore: averageScore == null ? null : String(averageScore),
      // Leadership cards collect no signatures. Null them defensively (like deficiencies/action items above)
      // so a stray client-sent value is never persisted — which also means no detail/PDF read can expose one.
      superintendentSignature: kind === "leadership" ? null : normalizeSignature(input.superintendentSignature),
      pmSignature: kind === "leadership" ? null : normalizeSignature(input.pmSignature),
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
    if (raced) return { scorecard: toSummary(raced, raced.projectName, input.userId), created: false };
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

  // Corrective-action follow-up: when the card trips the corrective-action band with at least one flagged
  // item, open the stage, seed one tracked item per flagged issue (each action item + each critical
  // deficiency), and enqueue the notification. Runs in this same transaction (the caller wraps
  // createFieldScorecard in runInOfficeTransaction), so the status walk + seeded items + job commit
  // atomically with the card. A below-band card with no action items and no deficiencies has nothing to
  // walk, so it stays `submitted` (see spec §4.2: items drive the stage). This is the SAME reconcile the
  // edit path runs, so the two can never drift; the freshly-inserted card is `submitted`.
  await reconcileScorecardCorrectiveActions(tenantDb, {
    scorecardId: card.id,
    dealId: input.dealId,
    office: input.office,
    rating,
    actionItems,
    deficiencies,
    currentStatus: "submitted",
  });
  // The reconcile above may have walked the freshly-inserted card into `corrective_action_open` (a below-band
  // submit with a flagged item), but `card` still carries its pre-reconcile `submitted` status. Re-read the row
  // so the returned summary reflects the reconciled status — the edit path does the same (reconciledCard).
  const [reconciledCard] = await tenantDb
    .select()
    .from(fieldScorecards)
    .where(eq(fieldScorecards.id, card.id))
    .limit(1);

  // Durable outbox: enqueue the email job IN THIS TRANSACTION so it commits atomically with the scorecard.
  // The PDF is rendered + stored post-response (best-effort); if that fails or the process dies first, the
  // job still exists and the worker sends a no-attachment fallback — the notification is never dropped.
  // Route the scorecard email to the deal's assigned superintendent + project_manager (resolved from the
  // active deal_team_members rows → linked user/contact email). Nulls when a role is unassigned or has no
  // email — the worker just skips that CC. Read inside the submit txn so the recipients commit atomically
  // with the card + job (durable outbox).
  // ...with the SAME per-role precedence the corrective-action path applies: a superintendent/PM the field user
  // PICKED from the roster on this card is who the completed-scorecard email goes to, and the deal team is the
  // fallback for a role with no usable pick. The picked rows were already resolved (and re-checked ACTIVE +
  // role-matched) above, so this costs no extra read. Unlike the corrective-action email — which re-resolves in
  // the worker at send time — this recipient set is SNAPSHOTTED into the payload here and never re-resolved, so
  // it is the pick as it stood at submit, matching how the deal-team addresses have always been frozen.
  const teamEmails = await resolveScorecardTeamEmails(tenantDb, input.dealId);
  const superintendentEmail = responderLinks.superintendent?.email ?? teamEmails.superintendentEmail;
  const projectManagerEmail = responderLinks.pm?.email ?? teamEmails.projectManagerEmail;
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
      superintendentEmail,
      projectManagerEmail,
      // The immutable artifact key is content-addressed and therefore unknown until after commit/render.
      // The worker reads field_scorecards.pdf_r2_key as the authority; keep this legacy payload field null
      // rather than advertising a deterministic key that no render will upload.
      pdfR2Key: null,
      officeId: input.office.id,
    },
    officeId: input.office.id,
    status: "pending",
    runAfter: new Date(Date.now() + SCORECARD_EMAIL_RUN_AFTER_SECONDS * 1000),
    maxAttempts: 6,
  });

  return { scorecard: toSummary(reconciledCard ?? card, project.name, input.userId), created: true };
}

/**
 * Replace the editable content of an already-submitted current-form scorecard. Ownership is the immutable
 * submitted_by UUID: no role (including admin/director) overrides it. The stored deal, completion week,
 * form kind/version, submitter, and submission time remain authoritative and cannot be changed by the body.
 *
 * The route runs this inside the scorecard's owning-office transaction. The row lock plus updatedAt token
 * prevents two devices from silently overwriting one another; a response-loss retry whose desired content
 * already equals the current row succeeds without advancing updatedAt again.
 */
export async function updateFieldScorecard(
  tenantDb: TenantDb,
  input: UpdateFieldScorecardInput,
): Promise<{ scorecard: FieldScorecardSummary }> {
  // BEFORE the card row lock, deliberately: this takes the same FOR KEY SHARE on the picked roster rows that
  // the FK write below would take anyway, so this transaction locks roster-then-card — the same order the
  // assign-from-roster team path uses. Acquiring it at the UPDATE instead would be card-then-roster, and the
  // two opposed orders deadlock. See resolveScorecardResponderPick's lockForFk note.
  const responderLinks = await resolveScorecardResponderLinks(tenantDb, input, { lockForFk: true });

  const [card] = await tenantDb
    .select()
    .from(fieldScorecards)
    .where(and(eq(fieldScorecards.id, input.scorecardId), eq(fieldScorecards.isActive, true)))
    .limit(1)
    .for("update");
  if (!card) throw new AppError(404, "Scorecard not found");
  if (card.submittedBy !== input.userId) {
    throw new AppError(403, "Only the person who submitted this scorecard can edit it.", "SCORECARD_EDIT_FORBIDDEN");
  }
  // Editable statuses are the whole current-form lifecycle: `submitted` plus the two corrective-action
  // states. An edit can raise a card out of the band (open → submitted) or add/remove flags while it is open
  // or re-open a closed card — reconcileScorecardCorrectiveActions (below) walks the status + tracked items
  // to match the freshly recomputed rating. The pre-edit status drives the enqueue-on-transition decision.
  const preEditStatus = card.status;
  if (
    (preEditStatus !== "submitted" &&
      preEditStatus !== "corrective_action_open" &&
      preEditStatus !== "corrective_action_closed") ||
    card.formVersion !== 2
  ) {
    throw new AppError(422, "Only submitted current-form scorecards can be edited.", "SCORECARD_EDIT_UNSUPPORTED");
  }

  const expectedDate = new Date(input.expectedUpdatedAt);
  if (!Number.isFinite(expectedDate.getTime())) {
    throw new AppError(400, "expectedUpdatedAt must be a valid timestamp.");
  }
  const expectedUpdatedAt = expectedDate.toISOString();
  const currentUpdatedAt = toIso(card.updatedAt);
  const staleExpectedUpdatedAt = expectedUpdatedAt !== currentUpdatedAt;
  const project = await assertActiveFieldProject(
    tenantDb,
    { userId: input.userId, userRole: input.userRole },
    card.dealId,
  );
  const superintendentName = input.superintendentName?.trim() || null;
  const pmName = input.pmName?.trim() || null;

  const kind: ScorecardKind = card.kind === "leadership" ? "leadership" : "project";
  const formVersion: ScorecardFormVersion = 2;
  const items = validateItems(input.items, formVersion, kind);
  if (
    kind === "leadership" &&
    (input.criticalDeficiencies.length > 0 || Object.keys(input.criticalDeficiencyNotes ?? {}).length > 0)
  ) {
    throw new AppError(400, "Leadership scorecards do not support critical deficiencies.");
  }
  const deficiencies = kind === "leadership" ? [] : validateDeficiencies(input.criticalDeficiencies, formVersion);
  const deficiencyNotes = kind === "leadership"
    ? {}
    : validateDeficiencyNotes(input.criticalDeficiencyNotes ?? {}, deficiencies, formVersion);
  const averageScore = kind === "leadership"
    ? computeScorecardLeadershipAverage(items as { sectionKey: ScorecardLeadershipSectionKey; points: number }[])
    : computeScorecardV2Average(items as { sectionKey: ScorecardV2SectionKey; points: number }[]);
  const total = Math.round(averageScore * 10);
  const rating = kind === "leadership"
    ? resolveScorecardLeadershipRating(averageScore)
    : resolveScorecardV2Rating(averageScore);
  const actionItems = kind === "leadership"
    ? []
    : input.actionItems.map((value) => value.trim()).filter((value) => value.length > 0);
  const summary = kind === "leadership"
    ? input.summary?.trim()
      ? input.summary.trim().slice(0, 8000)
      : null
    : null;
  const superintendentSignature = kind === "leadership" ? null : normalizeSignature(input.superintendentSignature);
  const pmSignature = kind === "leadership" ? null : normalizeSignature(input.pmSignature);
  if (kind === "project" && (!superintendentSignature || !pmSignature)) {
    throw new AppError(422, "Fresh superintendent and project manager signatures are required to save an edited scorecard.");
  }

  const currentItems = await tenantDb
    .select()
    .from(fieldScorecardItems)
    .where(eq(fieldScorecardItems.scorecardId, card.id));
  const currentPhotos = await tenantDb
    .select({
      id: fieldScorecardPhotos.id,
      fileId: fieldScorecardPhotos.fileId,
      // Original evidence always has a section_key; response photos (section_key null,
      // corrective_action_id set) are excluded below, so COALESCE keeps this `string`.
      sectionKey: sql<string>`COALESCE(${fieldScorecardPhotos.sectionKey}, '')`,
      deficiencyKey: fieldScorecardPhotos.deficiencyKey,
      isActive: files.isActive,
      deletedAt: files.deletedAt,
    })
    .from(fieldScorecardPhotos)
    .innerJoin(files, eq(files.id, fieldScorecardPhotos.fileId))
    .where(
      and(
        eq(fieldScorecardPhotos.scorecardId, card.id),
        // The edit-replacement contract covers only the submitter's ORIGINAL evidence. Corrective-action
        // response photos are a separate surface and must never be clobbered by a scorecard edit.
        isNull(fieldScorecardPhotos.correctiveActionId),
      ),
    );
  const visibleCurrentPhotos = currentPhotos.filter((photo) => photo.isActive && photo.deletedAt === null);
  const editablePhotos = await resolveUpdatePhotoLinks(
    tenantDb,
    input,
    { dealId: card.dealId, kind, formVersion },
    deficiencies,
    visibleCurrentPhotos,
    staleExpectedUpdatedAt,
  );
  // The edit contract is a full replacement of evidence the submitter can currently see. Soft-deleted or
  // inactive gallery files remain intentionally absent from detail/PDF responses, so they cannot appear in
  // that replacement payload. Preserve those hidden links server-side so restoring the gallery file also
  // restores its scorecard association. Critical-deficiency evidence is dependent on its parent deficiency,
  // however, and is removed when the edit explicitly removes that deficiency.
  const hiddenPhotosToPreserve: ResolvedUpdatePhoto[] = currentPhotos
    .filter((photo) => !photo.isActive || photo.deletedAt !== null)
    .filter(
      (photo) =>
        photo.sectionKey !== "critical_deficiency" ||
        (photo.deficiencyKey !== null && deficiencies.includes(photo.deficiencyKey)),
    )
    .map((photo) => ({
      linkId: photo.id,
      fileId: photo.fileId,
      sectionKey: photo.sectionKey,
      deficiencyKey: photo.deficiencyKey,
    }));
  const photos = [...editablePhotos, ...hiddenPhotosToPreserve];
  // The request parser caps visible payload rows at 100, but unavailable gallery evidence is preserved
  // server-side and can push the FINAL replacement beyond that limit. Never grow the card silently past
  // its contract or drop hidden evidence; surface a recoverable conflict before replacing any content.
  if (photos.length > 100) {
    throw new AppError(
      409,
      "This scorecard would contain more than 100 evidence photos, including unavailable evidence retained from the current report. Restore or remove gallery evidence, then try again.",
      "SCORECARD_EDIT_PHOTO_LIMIT",
    );
  }

  const contentUnchanged = scorecardEditableContentEquals({
    card,
    currentItems,
    currentPhotos,
    desired: {
      superintendentName,
      pmName,
      // The picked links are editable content in their own right: a re-save that keeps the display name but
      // swaps WHO was picked (or drops the pick for a typed name) changes who gets the corrective action, so
      // it must not be mistaken for an idempotent no-op retry and skipped.
      superintendentResponderId: responderLinks.superintendentResponderId,
      pmResponderId: responderLinks.pmResponderId,
      items,
      criticalDeficiencies: deficiencies,
      criticalDeficiencyNotes: deficiencyNotes,
      actionItems,
      photos,
      superintendentSignature,
      pmSignature,
      summary,
      totalScore: total,
      averageScore,
      rating,
    },
  });
  if (staleExpectedUpdatedAt && !contentUnchanged) {
    throw scorecardEditConflict();
  }
  if (contentUnchanged) {
    await markScorecardEditEvidenceLinked(tenantDb, {
      scorecardId: card.id,
      userId: input.userId,
      fileIds: photos.flatMap((photo) => (photo.linkId ? [photo.fileId] : [])),
    });
    return { scorecard: toSummary(card, project.name, input.userId) };
  }

  // Item identity is internal (the API addresses sections by their canonical keys), so a two-statement
  // replacement is simpler and safer than a partial merge while still remaining atomic in this transaction.
  await tenantDb.delete(fieldScorecardItems).where(eq(fieldScorecardItems.scorecardId, card.id));
  await tenantDb.insert(fieldScorecardItems).values(
    items.map((item) => ({
      scorecardId: card.id,
      sectionKey: item.sectionKey,
      points: item.points,
      note: item.note,
    })),
  );

  // Preserve retained scorecard-photo link ids (the mobile edit form uses them on the next save), while
  // removing omitted links and inserting newly uploaded evidence. Gallery files themselves are never deleted.
  // The edit-replacement contract covers ONLY the submitter's original evidence. Corrective-action response
  // photos (corrective_action_id set) are a separate surface — they never enter currentPhotos/retainedLinkIds
  // (the read above excludes them), so a bare scorecard_id DELETE would clobber every response-photo link on a
  // content edit made after a responder attaches evidence. Scope BOTH branches to corrective_action_id IS NULL
  // so response photos survive.
  const retainedLinkIds = photos.flatMap((photo) => (photo.linkId ? [photo.linkId] : []));
  if (retainedLinkIds.length === 0) {
    await tenantDb
      .delete(fieldScorecardPhotos)
      .where(
        and(
          eq(fieldScorecardPhotos.scorecardId, card.id),
          isNull(fieldScorecardPhotos.correctiveActionId),
        ),
      );
  } else {
    await tenantDb
      .delete(fieldScorecardPhotos)
      .where(
        and(
          eq(fieldScorecardPhotos.scorecardId, card.id),
          isNull(fieldScorecardPhotos.correctiveActionId),
          notInArray(fieldScorecardPhotos.id, retainedLinkIds),
        ),
      );
  }
  const currentPhotoById = new Map(currentPhotos.map((photo) => [photo.id, photo]));
  for (const photo of photos) {
    if (!photo.linkId) continue;
    const current = currentPhotoById.get(photo.linkId);
    if (
      current &&
      (current.sectionKey !== photo.sectionKey || (current.deficiencyKey ?? null) !== photo.deficiencyKey)
    ) {
      await tenantDb
        .update(fieldScorecardPhotos)
        .set({ sectionKey: photo.sectionKey, deficiencyKey: photo.deficiencyKey })
        .where(and(eq(fieldScorecardPhotos.id, photo.linkId), eq(fieldScorecardPhotos.scorecardId, card.id)));
    }
  }
  const addedPhotos = photos.filter((photo) => !photo.linkId);
  if (addedPhotos.length > 0) {
    await tenantDb.insert(fieldScorecardPhotos).values(
      addedPhotos.map((photo) => ({
        scorecardId: card.id,
        fileId: photo.fileId,
        sectionKey: photo.sectionKey,
        deficiencyKey: photo.deficiencyKey,
      })),
    );
  }
  // Consumed markers are intentionally permanent: once evidence was linked successfully, discarding a
  // later edit must never hide the gallery photo even if that later edit removes the scorecard link.
  await markScorecardEditEvidenceLinked(tenantDb, {
    scorecardId: card.id,
    userId: input.userId,
    fileIds: photos.map((photo) => photo.fileId),
  });

  // Guarantee a changed token even when an edit happens in the same millisecond as the original insert.
  const nextUpdatedAt = new Date(Math.max(Date.now(), new Date(card.updatedAt).getTime() + 1));
  const [updatedCard] = await tenantDb
    .update(fieldScorecards)
    .set({
      superintendentName,
      pmName,
      superintendentResponderId: responderLinks.superintendentResponderId,
      pmResponderId: responderLinks.pmResponderId,
      summary,
      averageScore: String(averageScore),
      superintendentSignature,
      pmSignature,
      totalScore: total,
      rating,
      criticalDeficiencies: deficiencies,
      criticalDeficiencyNotes: deficiencyNotes,
      actionItems,
      // The prior PDF is an immutable snapshot. Clearing its pointer makes every download surface regenerate
      // from the edited content; the route also starts a best-effort render after this transaction commits.
      pdfR2Key: null,
      pdfR2Bucket: null,
      pdfGeneratedAt: null,
      updatedAt: nextUpdatedAt,
    })
    .where(and(eq(fieldScorecards.id, card.id), eq(fieldScorecards.submittedBy, input.userId)))
    .returning();
  if (!updatedCard) {
    throw new AppError(409, "The scorecard could not be updated. Please reload and try again.", "SCORECARD_EDIT_CONFLICT");
  }

  // Do not create a second field-scorecard-completed notification. If the original durable email is still
  // waiting to run, keep its score text aligned with the newly edited PDF. A job already processing/completed
  // keeps its original submission notification semantics.
  await tenantDb.execute(sql`
    UPDATE public.job_queue
    SET payload = payload || jsonb_build_object(
      'totalScore', ${total}::integer,
      'averageScore', ${averageScore}::numeric,
      'ratingLabel', ${ratingLabelFor(kind, formVersion, rating)}::text
    )
    WHERE job_type = ${FIELD_SCORECARD_EMAIL_JOB}
      AND status IN ('pending', 'dead')
      AND payload->>'scorecardId' = ${card.id}
  `);

  // If this edit changed WHO was picked and the completed-scorecard email hasn't gone out yet, re-address it.
  // That email snapshots its recipients at submit (nothing re-resolves them at send time), so correcting a
  // mis-picked superintendent seconds after filing would otherwise still email the wrong person. Scoped to a
  // pick change so an ordinary edit keeps the existing freeze semantics exactly; the same `status IN
  // ('pending','dead')` predicate the score patch above uses means a job already claimed or sent is untouched.
  const responderPickChanged =
    (card.superintendentResponderId ?? null) !== responderLinks.superintendentResponderId ||
    (card.pmResponderId ?? null) !== responderLinks.pmResponderId;
  if (responderPickChanged) {
    const teamEmails = await resolveScorecardTeamEmails(tenantDb, card.dealId);
    const superintendentEmail = responderLinks.superintendent?.email ?? teamEmails.superintendentEmail;
    const projectManagerEmail = responderLinks.pm?.email ?? teamEmails.projectManagerEmail;
    await tenantDb.execute(sql`
      UPDATE public.job_queue
      SET payload = payload || jsonb_build_object(
        'superintendentEmail', ${superintendentEmail}::text,
        'projectManagerEmail', ${projectManagerEmail}::text
      )
      WHERE job_type = ${FIELD_SCORECARD_EMAIL_JOB}
        AND status IN ('pending', 'dead')
        AND payload->>'scorecardId' = ${card.id}
    `);
  }

  // Reconcile the corrective-action lifecycle against the recomputed rating + flagged items in THIS same
  // edit transaction — the SAME shared helper the create path runs, so the two never drift. It may open the
  // stage (edit dropped into the band), revert to `submitted` (edit lifted it back out), add/remove tracked
  // items, auto-close (all flags resolved), or re-open a closed card (a fresh flag) — resetting the email
  // stamp + re-enqueuing the notification only on a transition INTO open. preEditStatus is the status before
  // this edit; the reconcile may write a NEWER status than updatedCard carries, so re-read it for the summary.
  await reconcileScorecardCorrectiveActions(tenantDb, {
    scorecardId: card.id,
    dealId: card.dealId,
    office: input.office,
    rating,
    actionItems,
    deficiencies,
    currentStatus: preEditStatus,
    // Computed above from `card` (the pre-edit row read FOR UPDATE) vs what the card points at now. A changed
    // pick on an already-notified open card restarts the notification cycle so the newly picked responder is
    // actually reached, and the previous one's now-dead link is replaced rather than silently stranded.
    responderPickChanged,
  });
  const [reconciledCard] = await tenantDb
    .select()
    .from(fieldScorecards)
    .where(eq(fieldScorecards.id, card.id))
    .limit(1);

  return { scorecard: toSummary(reconciledCard ?? updatedCard, project.name, input.userId) };
}

export async function listFieldScorecardsForProject(
  tenantDb: TenantDb,
  access: FieldAccessContext,
  dealId: string,
): Promise<{ scorecards: FieldScorecardSummary[] }> {
  // 404s if the deal isn't a browsable field project — same gate the project reads apply.
  const project = await assertActiveFieldProject(tenantDb, access, dealId);
  const rows = await tenantDb
    .select()
    .from(fieldScorecards)
    .where(and(eq(fieldScorecards.dealId, dealId), eq(fieldScorecards.isActive, true)))
    .orderBy(desc(fieldScorecards.submittedAt));
  // Corrective-action responder capability is a DEAL-level fact (the assigned super/PM on this deal, or an
  // admin/director role) — identical for every card here — so resolve it ONCE. The mobile "Document the
  // corrective action" CTA gates on this so it isn't shown to a browse-only field user who'd hit a 403 from
  // the responder endpoint. Same authorization predicate the responder endpoint enforces (spec §7.1).
  const canRespondToCorrectiveAction = await isAssignedCorrectiveActionResponder(tenantDb, dealId, {
    id: access.userId,
    role: access.userRole,
  });
  return {
    scorecards: rows.map((row) =>
      toSummary(row, project.name, access.userId, canRespondToCorrectiveAction),
    ),
  };
}

export async function listRecentFieldScorecards(
  tenantDb: TenantDb,
  opts?: { limit?: number; viewerUserId?: string },
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
      d.name AS "projectName",
      sc.project_number AS "projectNumber",
      sc.critical_deficiencies AS "criticalDeficiencies",
      sc.status AS "status",
      sc.submitted_by_name AS "submittedByName",
      sc.submitted_by AS "submittedBy",
      sc.week_of::text AS "weekOf",
      sc.submitted_at AS "submittedAt",
      sc.updated_at AS "updatedAt",
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
  return { scorecards: rows.map((row) => toSummary(row, undefined, opts?.viewerUserId)) };
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
  const project = await assertActiveFieldProject(tenantDb, access, card.dealId);

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
      clientUploadId: files.clientUploadId,
      caption: files.description,
    })
    .from(fieldScorecardPhotos)
    .innerJoin(
      files,
      and(
        eq(files.id, fieldScorecardPhotos.fileId),
        eq(files.isActive, true),
        isNull(files.deletedAt),
      ),
    )
    // Only ORIGINAL section evidence — a corrective-action RESPONSE photo has corrective_action_id set +
    // section_key null. Mobile's evidence grouping discards null-section rows, so without this filter we'd
    // presign dozens/hundreds of response photos as wasted work and return DTO-invalid evidence. Response
    // photos load only through their own corrective-action thread (getCorrectiveActionItems). Mirrors the
    // corrective_action_id IS NULL filter the PDF + deal-detail evidence queries already use.
    .where(
      and(
        eq(fieldScorecardPhotos.scorecardId, id),
        isNull(fieldScorecardPhotos.correctiveActionId),
      ),
    );

  // Resolve presigned URLs concurrently (order preserved by Promise.all) so detail latency doesn't scale
  // with the photo count.
  const photos = await Promise.all(
    photoRows.map(async (p) => ({
      id: p.id,
      sectionKey: p.sectionKey as FieldScorecardDetail["photos"][number]["sectionKey"],
      deficiencyKey: p.deficiencyKey ?? null,
      fileId: p.fileId,
      clientUploadId: p.clientUploadId || null,
      url: opts?.resolvePhotoUrl ? await opts.resolvePhotoUrl(p.fileId) : null,
      caption: p.caption ?? null,
    })),
  );

  return {
    ...toSummary(card, project.name, access.userId),
    items,
    criticalDeficiencies: card.criticalDeficiencies ?? [],
    criticalDeficiencyNotes: card.criticalDeficiencyNotes ?? {},
    actionItems: card.actionItems ?? [],
    photos,
    superintendentSignature: card.superintendentSignature ?? null,
    pmSignature: card.pmSignature ?? null,
    // Let the mobile edit form rehydrate the picked roster links; an edit that omits them clears the pick.
    superintendentResponderId: card.superintendentResponderId ?? null,
    pmResponderId: card.pmResponderId ?? null,
    summary: card.summary ?? null,
  };
}

/**
 * Render + store the scorecard PDF (best-effort), then record its key. The email job was ALREADY enqueued
 * durably in the submit txn (createFieldScorecard), so this is purely artifact production: called
 * POST-COMMIT so R2 I/O never holds a txn open, and a throw here is harmless (the caller swallows it; the
 * worker sends a no-attachment fallback if the PDF isn't there). The content-addressed key is persisted on
 * the scorecard row after validation; the worker reads that row as its authority. Manages its own connections.
 */
export async function finalizeFieldScorecardArtifacts(
  office: { id: string; slug: string },
  userId: string,
  scorecardId: string,
): Promise<string | null> {
  // Include the editable-content generation in the process-local single-flight key. An edit that commits
  // while an older render is running must start a fresh render instead of coalescing onto the stale promise.
  const contentGeneration = await runInOffice(office, async (db) => {
    const [card] = await db
      .select({ updatedAt: fieldScorecards.updatedAt })
      .from(fieldScorecards)
      .where(and(eq(fieldScorecards.id, scorecardId), eq(fieldScorecards.isActive, true)))
      .limit(1);
    return card ? toIso(card.updatedAt) : null;
  });
  if (!contentGeneration) return null;
  return coalesceScorecardPdfFinalization(
    `${office.slug}:${scorecardId}:${CURRENT_SCORECARD_PDF_RENDER_VERSION}:${contentGeneration}`,
    () => renderAndStoreFieldScorecardArtifacts(office, userId, scorecardId),
  );
}

/**
 * One uncoalesced publication attempt. Runtime callers use finalizeFieldScorecardArtifacts; this export
 * exists so the cross-instance regression can run two independent attempts in one test process.
 */
export async function renderAndStoreFieldScorecardArtifacts(
  office: { id: string; slug: string },
  userId: string,
  scorecardId: string,
): Promise<string | null> {
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
        fileId: files.id,
        // section_key is nullable as of migration 0193 (corrective-action RESPONSE photos have it null), but
        // this query excludes those (corrective_action_id IS NULL) so only section-keyed ORIGINAL evidence
        // remains — COALESCE keeps the downstream evidence type as `string`.
        sectionKey: sql<string>`COALESCE(${fieldScorecardPhotos.sectionKey}, '')`,
        deficiencyKey: fieldScorecardPhotos.deficiencyKey,
        caption: files.description,
        r2Key: files.r2Key,
        thumbnailR2Key: files.thumbnailR2Key,
        mimeType: files.mimeType,
        isActive: files.isActive,
        deletedAt: files.deletedAt,
      })
      .from(fieldScorecardPhotos)
      .innerJoin(files, eq(files.id, fieldScorecardPhotos.fileId))
      .where(
        and(
          eq(fieldScorecardPhotos.scorecardId, scorecardId),
          // Exclude corrective-action response photos — the scorecard PDF embeds only the original evidence.
          isNull(fieldScorecardPhotos.correctiveActionId),
        ),
      )
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
  if (!loaded) return null;
  const { card, itemRows, photoRows, deal } = loaded;
  const evidenceFingerprint = scorecardEvidenceFingerprint(photoRows);
  const activePhotoRows = photoRows.filter((photo) => photo.isActive && photo.deletedAt == null);

  // Cap + prioritize BEFORE downloading bytes: a scorecard may carry up to 100 photos but the PDF embeds
  // at most MAX_EVIDENCE_PHOTOS, so fetching/transcoding the rest is wasted R2/CPU (and lengthens the
  // post-response render, making the email more likely to send without the PDF). Project cards prioritize
  // critical deficiencies; leadership cards prioritize category evidence before summary photos.
  const { keep: photosToLoad, omitted: omittedEvidenceCount } = prioritizeAndCapEvidencePhotos(
    activePhotoRows,
    MAX_EVIDENCE_PHOTOS,
    card.kind === "leadership" ? "leadership" : undefined,
  );

  // Resolve each kept evidence tile to a small JPEG (thumbnail-first, transcoded-original fallback — see
  // resolveScorecardEvidenceImage). Transient storage failures block the version stamp and remain
  // retryable. Irrecoverable legacy-source problems (missing/corrupt/unsupported originals) render an
  // explicit placeholder so one bad object cannot make the entire report permanently unexportable.
  const loadPhoto = async (photo: typeof photosToLoad[number]) => ({
    sectionKey: photo.sectionKey,
    deficiencyKey: photo.deficiencyKey ?? null,
    caption: photo.caption ?? null,
    resolution: await resolveScorecardEvidenceImage(photo),
  });
  const photos: Awaited<ReturnType<typeof loadPhoto>>[] = [];
  for (let index = 0; index < photosToLoad.length; index += PDF_EVIDENCE_DOWNLOAD_CONCURRENCY) {
    const batch = photosToLoad.slice(index, index + PDF_EVIDENCE_DOWNLOAD_CONCURRENCY);
    photos.push(...await Promise.all(batch.map(loadPhoto)));
  }
  const retryableFailure = photos.find((photo) => photo.resolution.failure?.retryable);
  if (retryableFailure) {
    throw new AppError(
      503,
      "Some scorecard evidence images are temporarily unavailable. Please retry the PDF download shortly.",
      "SCORECARD_EVIDENCE_UNAVAILABLE",
    );
  }
  const permanentFailures = photos
    .map((photo) => photo.resolution.failure?.reason)
    .filter((reason): reason is NonNullable<typeof reason> => reason != null);
  if (permanentFailures.length > 0) {
    console.warn("[FieldScorecardPDF] Rendering permanent evidence placeholders", {
      scorecardId,
      reasons: permanentFailures,
    });
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
    photos: photos.map((photo) => ({
      sectionKey: photo.sectionKey,
      deficiencyKey: photo.deficiencyKey,
      caption: photo.caption,
      image: photo.resolution.image,
    })),
    omittedEvidenceCount,
  });
  const bucket = process.env.R2_BUCKET_NAME || "trock-crm-files";

  // Render first, then derive an immutable key from the actual bytes. This is intentionally done before
  // the slow R2 PUT but after all evidence bytes are fixed. Two server instances rendering different
  // evidence generations can no longer write the same object key.
  const pdf = await renderFieldScorecardPdf(pdfData);
  const pdfDigest = createHash("sha256").update(pdf).digest("hex");
  const r2Key = scorecardPdfR2Key(
    office.slug,
    deal?.dealNumber,
    card.dealId,
    scorecardId,
    CURRENT_SCORECARD_PDF_RENDER_VERSION,
    pdfDigest,
  );

  // Store the immutable candidate. A throw propagates to the caller's .catch — harmless, the email job is
  // already enqueued (submit txn) and the worker sends the no-attachment fallback if the DB key stays empty.
  // The later fingerprint check decides whether this candidate becomes authoritative; a losing candidate
  // is only an orphan and cannot corrupt the winner's object.
  await putObject(r2Key, pdf, "application/pdf");
  const persistedKey = await runInOfficeTransaction(office, userId, async (db) => {
    // Check the scorecard generation without taking a row lock. The final guarded UPDATE below is the
    // publication CAS. Taking FOR SHARE here and later upgrading to UPDATE deadlocks two cross-instance
    // finalizers that publish the same generation; it also inverts the file-metadata path's file -> card
    // lock order. A plain read lets us fail fast while the CAS still closes a change after this statement.
    const [currentCardGeneration] = await db
      .select({ updatedAt: fieldScorecards.updatedAt })
      .from(fieldScorecards)
      .where(and(eq(fieldScorecards.id, scorecardId), eq(fieldScorecards.isActive, true)))
      .limit(1);
    if (!currentCardGeneration || toIso(currentCardGeneration.updatedAt) !== toIso(card.updatedAt)) {
      throw scorecardContentChangedError();
    }

    // Lock + recompare every linked FILE's active state, but deliberately do not lock the scorecard-photo
    // link rows. Scorecard edits serialize on the card row and advance updated_at, so the CAS below detects
    // link changes. Restricting this lock to files preserves the existing file -> card order used by caption
    // and visibility invalidation and avoids an edit's card -> link order forming another ABBA deadlock.
    const currentEvidenceRows = await db
      .select({
        fileId: files.id,
        isActive: files.isActive,
        deletedAt: files.deletedAt,
        caption: files.description,
      })
      .from(fieldScorecardPhotos)
      .innerJoin(files, eq(files.id, fieldScorecardPhotos.fileId))
      .where(
        and(
          eq(fieldScorecardPhotos.scorecardId, scorecardId),
          // MUST mirror the initial evidence read's filter: the PDF embeds ONLY original evidence, so a
          // corrective-action RESPONSE photo (corrective_action_id set) is excluded here too. Without this,
          // once any response photo exists the recheck fingerprint includes it while the initial fingerprint
          // did not, so they never match → a spurious SCORECARD_EVIDENCE_CHANGED on every regeneration.
          isNull(fieldScorecardPhotos.correctiveActionId),
        ),
      )
      .for("share", { of: files });
    if (scorecardEvidenceFingerprint(currentEvidenceRows) !== evidenceFingerprint) {
      throw new AppError(
        503,
        "Scorecard evidence changed while the PDF was rendering. Please retry the download.",
        "SCORECARD_EVIDENCE_CHANGED",
      );
    }

    const updated = await db
      .update(fieldScorecards)
      .set({
        pdfR2Key: r2Key,
        pdfR2Bucket: bucket,
        pdfGeneratedAt: new Date(),
        pdfRenderVersion: CURRENT_SCORECARD_PDF_RENDER_VERSION,
      })
      // Monotonic revision write: an older server finishing late during a rolling deploy must never point
      // the row back at its older version-specific object. <= permits repairing a missing v2 object.
      .where(
        and(
          eq(fieldScorecards.id, scorecardId),
          eq(fieldScorecards.isActive, true),
          // node-postgres timestamps are millisecond Date objects while Postgres may retain microseconds.
          // Compare at the API token's precision inside this atomic guarded UPDATE.
          sql`date_trunc('milliseconds', ${fieldScorecards.updatedAt}) = ${toIso(card.updatedAt)}::timestamptz`,
          lte(fieldScorecards.pdfRenderVersion, CURRENT_SCORECARD_PDF_RENDER_VERSION),
        ),
      )
      .returning({ pdfR2Key: fieldScorecards.pdfR2Key });
    if (updated[0]?.pdfR2Key) return updated[0].pdfR2Key;

    // Distinguish a content edit that won the race from a newer renderer revision. The former must never
    // return a stale/currently-unrelated key; the latter may safely return its authoritative artifact.
    const [current] = await db
      .select({ updatedAt: fieldScorecards.updatedAt, pdfR2Key: fieldScorecards.pdfR2Key })
      .from(fieldScorecards)
      .where(and(eq(fieldScorecards.id, scorecardId), eq(fieldScorecards.isActive, true)))
      .limit(1);
    if (!current || toIso(current.updatedAt) !== toIso(card.updatedAt)) {
      throw scorecardContentChangedError();
    }
    return current?.pdfR2Key ?? null;
  });
  return persistedKey;
}

/**
 * Inspect the stored PDF artifact while preserving the field surface's project-browsability gate. The
 * route deliberately performs regeneration only after this office-scoped read connection is released.
 */
export async function getFieldScorecardPdfArtifactState(
  tenantDb: TenantDb,
  id: string,
  access: FieldAccessContext,
): Promise<ScorecardPdfArtifactState & { needsRegeneration: boolean }> {
  const [card] = await tenantDb
    .select({
      dealId: fieldScorecards.dealId,
      pdfR2Key: fieldScorecards.pdfR2Key,
      pdfRenderVersion: fieldScorecards.pdfRenderVersion,
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
    .where(and(eq(fieldScorecards.id, id), eq(fieldScorecards.isActive, true)))
    .groupBy(
      fieldScorecards.id,
      fieldScorecards.dealId,
      fieldScorecards.pdfR2Key,
      fieldScorecards.pdfRenderVersion,
    )
    .limit(1);
  if (!card) throw new AppError(404, "Scorecard not found");
  await assertActiveFieldProject(tenantDb, access, card.dealId);
  const state: ScorecardPdfArtifactState = {
    pdfR2Key: card.pdfR2Key,
    pdfRenderVersion: card.pdfRenderVersion,
    linkedPhotoCount: Number(card.linkedPhotoCount),
  };
  return { ...state, needsRegeneration: needsScorecardPdfRegeneration(state) };
}

/** Verify that a stored key still resolves to a non-empty PDF before issuing a presigned URL. */
export async function isStoredScorecardPdfAvailable(pdfR2Key: string | null): Promise<boolean> {
  const key = pdfR2Key?.trim();
  if (!key) return false;
  try {
    return isScorecardPdfObjectMetadataValid(await headObjectStrict(key));
  } catch (err) {
    console.error("[FieldScorecardPDF] R2 metadata check failed", { pdfR2Key: key, err });
    throw new AppError(
      503,
      "Scorecard PDF storage is temporarily unavailable. Please try again shortly.",
      "SCORECARD_PDF_STORAGE_UNAVAILABLE",
    );
  }
}

/** Presign a known-current scorecard PDF after any required regeneration has completed. */
export async function presignFieldScorecardPdf(
  id: string,
  pdfR2Key: string,
): Promise<{ url: string; expiresAt: string }> {
  const url = await generateDownloadUrl(pdfR2Key, SCORECARD_PDF_DOWNLOAD_EXPIRY_SECONDS, `field-scorecard-${id}.pdf`);
  return { url, expiresAt: new Date(Date.now() + SCORECARD_PDF_DOWNLOAD_EXPIRY_SECONDS * 1000).toISOString() };
}

// ── internals ───────────────────────────────────────────────────────────────

async function findByClientSubmissionId(
  tenantDb: TenantDb,
  clientSubmissionId: string,
): Promise<(ScorecardRow & { projectName: string }) | null> {
  const rows = await tenantDb
    .select({
      ...getTableColumns(fieldScorecards),
      projectName: deals.name,
    })
    .from(fieldScorecards)
    .innerJoin(deals, eq(deals.id, fieldScorecards.dealId))
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
    validatePhotoPlacement(p, formVersion, kind, deficiencies);
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

function validatePhotoPlacement(
  photo: { sectionKey: string; deficiencyKey?: string | null },
  formVersion: ScorecardFormVersion,
  kind: ScorecardKind,
  deficiencies: string[],
): void {
  if (kind === "leadership") {
    // Leadership evidence may attach to any of its four scored categories or the Project Summary. It has
    // no critical-deficiency bucket, so reject every other key rather than silently stranding evidence.
    if (
      photo.sectionKey !== FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY &&
      !isLeadershipSectionKey(photo.sectionKey)
    ) {
      throw new AppError(422, `Unknown scorecard section: ${photo.sectionKey}`);
    }
    if (photo.deficiencyKey) {
      throw new AppError(422, "Leadership scorecard evidence cannot reference a critical deficiency.");
    }
    return;
  }
  const validSection = formVersion === 2
    ? isScorecardV2SectionKey(photo.sectionKey)
    : isScorecardSectionKey(photo.sectionKey);
  const deficiencyEvidence =
    formVersion === 2 &&
    photo.sectionKey === "critical_deficiency" &&
    Boolean(photo.deficiencyKey) &&
    deficiencies.includes(photo.deficiencyKey!);
  if (!validSection && !deficiencyEvidence) {
    throw new AppError(422, `Unknown scorecard section: ${photo.sectionKey}`);
  }
  if (validSection && photo.deficiencyKey) {
    throw new AppError(422, `Section evidence cannot reference a critical deficiency: ${photo.sectionKey}`);
  }
}

async function resolveUpdatePhotoLinks(
  tenantDb: TenantDb,
  input: UpdateFieldScorecardInput,
  card: { dealId: string; kind: ScorecardKind; formVersion: ScorecardFormVersion },
  deficiencies: string[],
  currentPhotos: Array<Pick<CurrentScorecardPhoto, "id" | "fileId" | "sectionKey" | "deficiencyKey">>,
  staleExpectedUpdatedAt: boolean,
): Promise<ResolvedUpdatePhoto[]> {
  for (const photo of input.photos) {
    const hasLinkId = typeof photo.scorecardPhotoId === "string" && photo.scorecardPhotoId.trim().length > 0;
    const hasUploadId = typeof photo.clientUploadId === "string" && photo.clientUploadId.trim().length > 0;
    if ((hasLinkId ? 1 : 0) + (hasUploadId ? 1 : 0) !== 1) {
      throw new AppError(400, "Each evidence photo needs exactly one scorecardPhotoId or clientUploadId.");
    }
    validatePhotoPlacement(photo, card.formVersion, card.kind, deficiencies);
  }

  const currentById = new Map(currentPhotos.map((photo) => [photo.id, photo]));
  const currentByFileId = new Map(currentPhotos.map((photo) => [photo.fileId, photo]));
  const uploadIds = Array.from(
    new Set(
      input.photos.flatMap((photo) =>
        typeof photo.clientUploadId === "string" && photo.clientUploadId.trim()
          ? [photo.clientUploadId.trim()]
          : [],
      ),
    ),
  );
  const newFiles = uploadIds.length === 0
    ? []
    : await tenantDb
        .select({ id: files.id, dealId: files.dealId, clientUploadId: files.clientUploadId })
        .from(files)
        .innerJoin(
          fieldScorecardEditUploads,
          and(
            eq(fieldScorecardEditUploads.fileId, files.id),
            eq(fieldScorecardEditUploads.clientUploadId, files.clientUploadId),
          ),
        )
        .where(
          and(
            inArray(files.clientUploadId, uploadIds),
            eq(files.uploadedBy, input.userId),
            eq(files.isActive, true),
            isNull(files.deletedAt),
            // A PUT may consume only evidence authorized for this exact submitted card. Uploader + deal
            // alone is insufficient: the same person can own multiple cards for one project, and accepting
            // an ordinary/cross-card client id would let one card's cleanup race and hide another's evidence.
            eq(fieldScorecardEditUploads.scorecardId, input.scorecardId),
            eq(fieldScorecardEditUploads.dealId, card.dealId),
            eq(fieldScorecardEditUploads.uploadedBy, input.userId),
            inArray(fieldScorecardEditUploads.state, ["confirmed", "linked"]),
          ),
        );
  const newFileByUploadId = new Map(newFiles.map((file) => [file.clientUploadId, file]));

  const resolved: ResolvedUpdatePhoto[] = [];
  const seenFileIds = new Set<string>();
  for (const photo of input.photos) {
    let fileId: string;
    let linkId: string | null;
    if (typeof photo.scorecardPhotoId === "string" && photo.scorecardPhotoId.trim()) {
      const existing = currentById.get(photo.scorecardPhotoId.trim());
      if (!existing) {
        // A retained link that disappeared after this client loaded is a concurrency conflict, not a
        // permanently-invalid request. Preserve the 422 for a current token (bad/cross-card link id).
        if (staleExpectedUpdatedAt) throw scorecardEditConflict();
        throw new AppError(422, "Existing evidence photo does not belong to this scorecard.");
      }
      fileId = existing.fileId;
      linkId = existing.id;
    } else {
      const clientUploadId = typeof photo.clientUploadId === "string" ? photo.clientUploadId.trim() : "";
      const file = newFileByUploadId.get(clientUploadId);
      if (!file) {
        // With a stale token, availability may have changed after the edit form was opened (or after a
        // response-loss retry added the link). The client must reload instead of retrying the same 422.
        if (staleExpectedUpdatedAt) throw scorecardEditConflict();
        throw new AppError(422, `Evidence photo not found (or no longer available) for upload ${clientUploadId}.`);
      }
      if (file.dealId !== card.dealId) {
        throw new AppError(422, `Evidence photo ${clientUploadId} does not belong to this deal.`);
      }
      fileId = file.id;
      // A retry after a response loss still carries the new upload's client id. If that file is already
      // linked by the successful first request, retain its link id rather than attempting a duplicate insert.
      linkId = currentByFileId.get(file.id)?.id ?? null;
    }
    if (seenFileIds.has(fileId)) {
      throw new AppError(422, "The same evidence photo cannot be attached more than once.");
    }
    seenFileIds.add(fileId);
    resolved.push({
      linkId,
      fileId,
      sectionKey: photo.sectionKey,
      deficiencyKey: photo.deficiencyKey ?? null,
    });
  }
  return resolved;
}

/**
 * Revalidate the client-supplied picked-responder links for BOTH roles. Shared by create + update so the two
 * paths can never drift on what counts as a usable link: the id must name an ACTIVE roster row whose role
 * matches the slot. Anything else (absent, unknown, deactivated, wrong role, malformed) becomes null — the
 * card saves and its recipients fall back to the deal's Team-tab super/PM.
 */
async function resolveScorecardResponderLinks(
  tenantDb: TenantDb,
  input: { superintendentResponderId?: string | null; pmResponderId?: string | null },
  opts?: { lockForFk?: boolean },
): Promise<ResolvedScorecardResponderLinks> {
  // Sequential, not Promise.all: both callers run inside an open office transaction on a single pooled
  // connection, and interleaving statements on one transaction client is not a pattern this codebase relies on.
  const superintendent = await resolveScorecardResponderPick(
    tenantDb,
    input.superintendentResponderId,
    "superintendent",
    opts,
  );
  const pm = await resolveScorecardResponderPick(tenantDb, input.pmResponderId, "project_manager", opts);
  return {
    superintendent,
    pm,
    superintendentResponderId: superintendent?.id ?? null,
    pmResponderId: pm?.id ?? null,
  };
}

function scorecardEditableContentEquals(input: {
  card: ScorecardRow;
  currentItems: Array<{ sectionKey: string; points: number; note: string | null }>;
  currentPhotos: Array<{ id: string; fileId: string; sectionKey: string; deficiencyKey: string | null }>;
  desired: {
    superintendentName: string | null;
    pmName: string | null;
    superintendentResponderId: string | null;
    pmResponderId: string | null;
    items: ValidatedItem[];
    criticalDeficiencies: string[];
    criticalDeficiencyNotes: Record<string, string>;
    actionItems: string[];
    photos: ResolvedUpdatePhoto[];
    superintendentSignature: string | null;
    pmSignature: string | null;
    summary: string | null;
    totalScore: number;
    averageScore: number;
    rating: ScorecardRating;
  };
}): boolean {
  const sortedRecord = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
  const itemShape = (items: Array<{ sectionKey: string; points: number; note: string | null }>) =>
    items
      .map((item) => ({ sectionKey: item.sectionKey, points: item.points, note: item.note ?? null }))
      .sort((left, right) => left.sectionKey.localeCompare(right.sectionKey));
  const photoShape = (photos: Array<{ fileId: string; sectionKey: string; deficiencyKey: string | null }>) =>
    photos
      .map((photo) => ({
        fileId: photo.fileId,
        sectionKey: photo.sectionKey,
        deficiencyKey: photo.deficiencyKey ?? null,
      }))
      .sort((left, right) => left.fileId.localeCompare(right.fileId));

  const current = {
    superintendentName: input.card.superintendentName ?? null,
    pmName: input.card.pmName ?? null,
    superintendentResponderId: input.card.superintendentResponderId ?? null,
    pmResponderId: input.card.pmResponderId ?? null,
    items: itemShape(input.currentItems),
    criticalDeficiencies: [...(input.card.criticalDeficiencies ?? [])].sort(),
    criticalDeficiencyNotes: sortedRecord(input.card.criticalDeficiencyNotes ?? {}),
    actionItems: input.card.actionItems ?? [],
    photos: photoShape(input.currentPhotos),
    superintendentSignature: input.card.superintendentSignature ?? null,
    pmSignature: input.card.pmSignature ?? null,
    summary: input.card.summary ?? null,
    totalScore: input.card.totalScore,
    averageScore: input.card.averageScore == null ? null : Number(input.card.averageScore),
    rating: input.card.rating,
  };
  const desired = {
    superintendentName: input.desired.superintendentName,
    pmName: input.desired.pmName,
    superintendentResponderId: input.desired.superintendentResponderId,
    pmResponderId: input.desired.pmResponderId,
    items: itemShape(input.desired.items),
    criticalDeficiencies: [...input.desired.criticalDeficiencies].sort(),
    criticalDeficiencyNotes: sortedRecord(input.desired.criticalDeficiencyNotes),
    actionItems: input.desired.actionItems,
    photos: photoShape(input.desired.photos),
    superintendentSignature: input.desired.superintendentSignature,
    pmSignature: input.desired.pmSignature,
    summary: input.desired.summary,
    totalScore: input.desired.totalScore,
    averageScore: input.desired.averageScore,
    rating: input.desired.rating,
  };
  return JSON.stringify(current) === JSON.stringify(desired);
}

// The current-form editable lifecycle — MUST match the accepted statuses in updateFieldScorecard's guard
// (`submitted` + the two corrective-action states). canEdit gates the mobile edit action; if it were narrower
// than the edit guard, an open/closed V2 card could never reach the edit/reconciliation path. Defined once in
// scorecard-evidence-upload.ts (the evidence-presign guard reuses the same set) and re-imported here to keep a
// single source of truth for the editable lifecycle.

function toSummary(
  row: ScorecardSummarySource,
  projectName = row.projectName ?? null,
  viewerUserId?: string,
  canRespondToCorrectiveAction?: boolean,
): FieldScorecardSummary {
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
    projectName,
    projectNumber: row.projectNumber ?? null,
    criticalDeficiencyCount: (row.criticalDeficiencies ?? []).length,
    submittedByName: row.submittedByName ?? null,
    submittedAt: toIso(row.submittedAt),
    updatedAt: toIso(row.updatedAt ?? row.submittedAt),
    canEdit:
      Boolean(viewerUserId) &&
      row.submittedBy === viewerUserId &&
      formVersion === 2 &&
      EDITABLE_SCORECARD_STATUSES.has(row.status ?? "submitted"),
    // PDF is rendered/uploaded post-response (best-effort/async) — null right after submit until the
    // artifact lands. Surface availability so downstream (mobile + CRM) can gate the download action.
    hasPdf: Boolean(row.pdfR2Key ?? row.pdfGeneratedAt),
    // Lifecycle status (submitted / corrective_action_open / corrective_action_closed) so the field
    // Scorecards list can surface a "Corrective action required" affordance without a second fetch.
    status: row.status ?? "submitted",
    // Whether the REQUESTING user may document the corrective action (assigned super/PM or admin/director).
    // Gates the mobile CTA so it isn't shown to a browsing-only field user who'd get a 403. Omitted (undefined)
    // when the caller didn't compute it, so consumers fall back to their own conservative gate.
    ...(canRespondToCorrectiveAction === undefined ? {} : { canRespondToCorrectiveAction }),
  };
}

function normalizeSignature(value: string | null | undefined): string | null {
  const signature = value?.trim() ?? "";
  if (!signature) return null;
  if (signature.length > 500_000) throw new AppError(400, "Signature is too large.");
  return signature;
}

function scorecardEditConflict(): AppError {
  return new AppError(
    409,
    "This scorecard changed after you opened it. Reload it before saving your edits.",
    "SCORECARD_EDIT_CONFLICT",
  );
}

function scorecardContentChangedError(): AppError {
  return new AppError(
    503,
    "Scorecard content changed while the PDF was rendering. Please retry the download.",
    "SCORECARD_CONTENT_CHANGED",
  );
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
