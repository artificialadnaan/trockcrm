import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { requestUploadUrl, confirmUpload, deleteFile } from "../files/service.js";

type TenantDb = NodePgDatabase<typeof schema>;

// Friendly original_filename for a corrective-action upload: `corrective-action-<timestamp>.<ext>`. This is a
// DISPLAY name only — it is NOT used to prove ownership, because the generic upload API accepts a
// caller-supplied originalFilename (so the prefix is forgeable). Discard eligibility is proven by the durable
// scorecard_corrective_action_uploads ledger row written on confirm (see discardCorrectiveActionUpload).
const CORRECTIVE_ACTION_FILENAME_PREFIX = "corrective-action-";

// files.uploaded_by is NOT NULL WITH a real FK to public.users(id) in prod (migration 0001) — the drizzle
// schema omits `.references()`, but the constraint is live. So an email-only (token) responder, who has NO
// CRM user id, CANNOT be recorded as the uploader with a nil uuid (it would FK-violate → the token upload
// fails). Instead we attribute a token upload to the scorecard's submitter (`field_scorecards.submitted_by`
// — a real, active user on the deal's office who owns this scorecard). resolveScorecardUploader() looks that
// up so the caller passes a session user id (when present) or falls back to the submitter.

const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function extensionForContentType(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return "jpg";
  }
}

export interface CorrectiveActionUploadUrlInput {
  scorecardId: string;
  officeSlug: string;
  /**
   * The session user id when the caller is a CRM user, or null for an email-only (token) responder. A null
   * resolves to the scorecard's submitter as the files.uploaded_by (never a nil uuid — that FK-violates).
   */
  sessionUserId: string | null;
  contentType: string;
  sizeBytes: number;
}

/**
 * Step 1 (presign) of the token-scoped corrective-action photo upload. Resolves the scorecard's deal and
 * mints a presigned R2 upload URL targeting that deal (category "photo"), so the file lands on the deal and
 * is later accepted by submitCorrectiveActionResponse's deal-membership check. The caller has ALREADY
 * authorized access to this scorecard (session or recipient-bound token) — this does no auth of its own.
 *
 * Reuses the generic files-service requestUploadUrl (NOT the session-scoped field wrapper), so it does not
 * require the caller to be the scorecard's evidence editor — the corrective-action token/assignment IS the
 * authorization. R2-unconfigured environments (tests) fall back to a mock upload URL.
 */
export async function requestCorrectiveActionUploadUrl(
  db: TenantDb,
  input: CorrectiveActionUploadUrlInput,
): Promise<{ uploadUrl: string; objectKey: string; uploadToken: string; expiresIn: number }> {
  if (!IMAGE_CONTENT_TYPES.has(input.contentType)) {
    throw new AppError(400, "contentType must be a supported image type.");
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new AppError(400, "sizeBytes must be a positive number.");
  }
  if (input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new AppError(400, "Photo exceeds the maximum upload size.");
  }
  // Gate presign on an OPEN corrective action. A still-assigned recipient's long-lived (30-day) token would
  // otherwise keep minting upload URLs after the corrective action closed → permanent gallery/storage orphans
  // (an upload can never be attached to a resolved item). Reject once there is no open item to respond to.
  await assertOpenCorrectiveAction(db, input.scorecardId);
  const { dealId, uploaderId } = await resolveScorecardUploader(
    db,
    input.scorecardId,
    input.sessionUserId,
  );
  const ext = extensionForContentType(input.contentType);

  const result = await requestUploadUrl(db, input.officeSlug, uploaderId, {
    originalFilename: `${CORRECTIVE_ACTION_FILENAME_PREFIX}${Date.now()}.${ext}`,
    mimeType: input.contentType,
    fileSizeBytes: Number(input.sizeBytes),
    category: "photo",
    dealId,
    allowUnassigned: false,
  });

  return {
    uploadUrl: result.uploadUrl,
    objectKey: result.r2Key,
    uploadToken: result.uploadToken,
    expiresIn: result.expiresIn,
  };
}

export interface ConfirmCorrectiveActionUploadInput {
  scorecardId: string;
  /**
   * The session user id when the caller is a CRM user, or null for an email-only (token) responder — resolved
   * to the scorecard's submitter as files.uploaded_by (never a nil uuid). MUST match the presign step's
   * resolved uploader so confirmUpload's idempotent-confirm dedup (keyed on uploadedBy) is consistent.
   */
  sessionUserId: string | null;
  uploadToken: string;
  objectKey: string;
  /**
   * Optional per-photo caption. The corrective-action read sources photo captions from files.description, so
   * we persist it on the file at creation (in the scorecard's office) — otherwise a caption typed in the
   * mobile PhotoCaptionEditor is silently lost after submit.
   */
  caption?: string | null;
}

/**
 * Step 2 (confirm) of the token-scoped upload. Consumes the pending upload token, verifies the R2 object
 * (when R2 is configured), and creates the files row on the scorecard's deal — returning the fresh { fileId }
 * the response POST's photoFileIds expects. The returned id is a brand-new file (never existing scorecard
 * evidence), which submitCorrectiveActionResponse requires.
 */
export async function confirmCorrectiveActionUpload(
  db: TenantDb,
  input: ConfirmCorrectiveActionUploadInput,
): Promise<{ fileId: string }> {
  // Gate confirm on an OPEN corrective action too (not just presign): a token holder could have obtained a
  // presigned URL while open, then confirmed after closure. Reject a confirm once the corrective action is
  // closed so a closed scorecard can never gain a new orphaned response file.
  await assertOpenCorrectiveAction(db, input.scorecardId);
  // Resolve the ROUTE scorecard's authoritative deal AND the uploader — a session user id, or the
  // scorecard's submitter for a token responder (never a nil uuid, which would FK-violate
  // files.uploaded_by → public.users).
  const { dealId, uploaderId } = await resolveScorecardUploader(
    db,
    input.scorecardId,
    input.sessionUserId,
  );
  // Bind the confirm to THIS route's scorecard/deal so an upload token minted for a DIFFERENT deal/scorecard
  // (same office) is REJECTED here rather than persisting the pending token's foreign dealId. confirmUpload
  // asserts a supplied scorecardEditDealId equals the live pending token's dealId (400 SCORECARD_EDIT_UPLOAD
  // _SCOPE on mismatch): the pending upload token carries the deal it was presigned against, so a token minted
  // for scorecard B (deal B) confirmed through scorecard A's route (deal A ≠ deal B) fails — no file is
  // created on B. Without this, A's open/authz checks pass yet confirmUpload would persist B's dealId,
  // creating a file on B (attributed via A's uploader) after B closed / A-scoped access was revoked.
  const { file } = await confirmUpload(db, uploaderId, {
    uploadToken: input.uploadToken,
    scorecardEditDealId: dealId,
  });
  // Record DURABLE, unforgeable corrective-action ownership: one ledger row per file created via this flow.
  // discardCorrectiveActionUpload gates on an EXISTS here (file_id + scorecard_id) instead of the FORGEABLE
  // original_filename prefix — the generic requestUploadUrl/updateFile API can set a caller-supplied filename
  // but never writes this table, so a look-alike file can't be discarded. ON CONFLICT DO NOTHING keeps confirm
  // idempotent (confirmUpload can idempotently re-confirm the same file → the same ledger row).
  await db.execute(sql`
    INSERT INTO scorecard_corrective_action_uploads (file_id, scorecard_id)
    VALUES (${file.id}, ${input.scorecardId})
    ON CONFLICT (file_id) DO NOTHING
  `);
  // confirmUpload builds the file from the pending-upload row (no description slot), so persist the caption
  // onto files.description here — the corrective-action read sources photo captions from that column.
  const caption = input.caption?.trim();
  if (caption) {
    await db.execute(sql`UPDATE files SET description = ${caption} WHERE id = ${file.id}`);
  }
  return { fileId: file.id };
}

export interface DiscardCorrectiveActionUploadInput {
  scorecardId: string;
  fileId: string;
  /** The session user id (for the deletedBy audit stamp), or null for an email-only token responder. */
  sessionUserId: string | null;
}

/**
 * Discard a corrective-action response photo that was uploaded (confirmUpload created a files row on the
 * deal) but has NOT yet been submitted as evidence — the responder removed it, or abandoned/refreshed the
 * page. Without this, every removed-before-submit or abandoned upload leaves a permanent, unattached file in
 * the project gallery/storage.
 *
 * Eligibility (all must hold, else no delete):
 *   - the file belongs to THIS scorecard's deal (files.deal_id = scorecard.deal_id) and is still active;
 *   - it was created via the corrective-action upload flow, proven by a DURABLE ownership ledger row
 *     (scorecard_corrective_action_uploads: file_id + scorecard_id) written by confirmCorrectiveActionUpload —
 *     NOT the original_filename prefix, which the generic upload API lets a caller forge. A regular project
 *     photo/document / a look-alike-named file has no ledger row, so this can only ever reclaim its own uploads;
 *   - it is NOT attached to any corrective action / not existing evidence: no field_scorecard_photos row
 *     references it (a submitted response photo has corrective_action_id set; scorecard evidence has a
 *     section_key row) — an attached file is a 409, never deleted.
 *
 * A file that doesn't exist / isn't on this deal / has no ownership ledger row for this scorecard is a 404
 * (no-op). An already-attached file is a 409 (no-op). Otherwise the file is soft-deleted through the shared
 * files-service deleteFile path (is_active=false + deleted_at), the same delete used everywhere else.
 */
export async function discardCorrectiveActionUpload(
  db: TenantDb,
  input: DiscardCorrectiveActionUploadInput,
): Promise<{ discarded: true }> {
  // Serialize this discard against submitCorrectiveActionResponse, which links photos under the SAME
  // parent-scorecard FOR UPDATE lock. Without it, a concurrent submit could attach the file BETWEEN the
  // is-attached re-check and the soft-delete below → we'd soft-delete an already-attached file (dropping it
  // from the finalized response). Taking the lock up front (in the route's runInOfficeTransaction) makes the
  // re-check + delete atomic w.r.t. any submit that would attach the same file. The route runs us inside that
  // transaction, so we take the ambient lock here rather than opening a nested transaction.
  await db.execute(sql`SELECT id FROM field_scorecards WHERE id = ${input.scorecardId} LIMIT 1 FOR UPDATE`);

  const { dealId } = await resolveScorecard(db, input.scorecardId);

  // Load the candidate file scoped to this scorecard's deal + the corrective-action flow. Ownership is proven
  // by the DURABLE ledger row (scorecard_corrective_action_uploads: file_id + scorecard_id) written on confirm,
  // NOT the forgeable original_filename prefix. Anything outside that (foreign file, wrong deal, no ledger row
  // for THIS scorecard, already soft-deleted) is a 404 no-op.
  const fileRes = await db.execute(sql`
    SELECT f.id
    FROM files f
    JOIN scorecard_corrective_action_uploads u
      ON u.file_id = f.id AND u.scorecard_id = ${input.scorecardId}
    WHERE f.id = ${input.fileId}
      AND f.deal_id = ${dealId}
      AND f.is_active = true
      AND f.deleted_at IS NULL
    LIMIT 1
  `);
  if (fileRes.rows.length === 0) {
    throw new AppError(404, "That photo can't be discarded.");
  }

  // If ANY field_scorecard_photos row references this file, it is already attached — either a submitted
  // corrective-action response photo (corrective_action_id set) or original scorecard evidence. Deleting it
  // would drop it from a finalized response / the evidence grid, so reject with a 409 (no-op).
  const attachedRes = await db.execute(sql`
    SELECT 1 FROM field_scorecard_photos WHERE file_id = ${input.fileId} LIMIT 1
  `);
  if (attachedRes.rows.length > 0) {
    throw new AppError(409, "That photo is already attached to a response and can't be discarded.");
  }

  // Soft-delete via the shared files path (is_active=false + deleted_at + audit stamp). A token responder has
  // no CRM user id, so deletedBy is null in that case.
  await deleteFile(db, input.fileId, "field", input.sessionUserId ?? undefined);
  return { discarded: true };
}

/**
 * Resolve the uploader to stamp on a token-scoped upload: the session user when one is present, otherwise the
 * scorecard's submitter (`field_scorecards.submitted_by`) — a real user id that satisfies the live
 * files.uploaded_by → public.users FK. A nil uuid must NEVER be used (it would FK-violate in prod). Also
 * returns the deal id so callers presign/file the row against the right project in one round trip.
 */
async function resolveScorecardUploader(
  db: TenantDb,
  scorecardId: string,
  sessionUserId: string | null,
): Promise<{ dealId: string; uploaderId: string }> {
  const { dealId, submittedBy } = await resolveScorecard(db, scorecardId);
  const uploaderId = sessionUserId ?? submittedBy;
  return { dealId, uploaderId };
}

export async function resolveScorecard(
  db: TenantDb,
  scorecardId: string,
): Promise<{ dealId: string; submittedBy: string }> {
  const res = await db.execute(
    sql`SELECT deal_id, submitted_by FROM field_scorecards WHERE id = ${scorecardId} LIMIT 1`,
  );
  const row = res.rows[0] as { deal_id?: string; submitted_by?: string } | undefined;
  const dealId = row?.deal_id;
  const submittedBy = row?.submitted_by;
  if (!dealId || !submittedBy) throw new AppError(404, "Scorecard not found.");
  return { dealId, submittedBy };
}

/**
 * Assert the scorecard still has an OPEN corrective action — a status of `corrective_action_open` AND ≥1 open
 * item. Response uploads (presign + confirm) are only valid while there is an open item to attach them to; a
 * still-assigned recipient's long-lived token must not keep uploading response files after closure (they'd
 * orphan permanently). A closed/reverted corrective action (or a scorecard with no open items) is a 409. GET
 * reads of a closed response are unaffected — only the write paths gate on this.
 */
async function assertOpenCorrectiveAction(db: TenantDb, scorecardId: string): Promise<void> {
  const res = await db.execute(sql`
    SELECT 1
    FROM field_scorecards s
    WHERE s.id = ${scorecardId}
      AND s.status = 'corrective_action_open'
      AND EXISTS (
        SELECT 1 FROM scorecard_corrective_actions ca
        WHERE ca.scorecard_id = s.id AND ca.status = 'open'
      )
    LIMIT 1
  `);
  if (res.rows.length === 0) {
    throw new AppError(409, "This corrective action is closed; response uploads are no longer accepted.");
  }
}
