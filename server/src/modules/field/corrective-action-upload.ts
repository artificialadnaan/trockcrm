import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { requestUploadUrl, confirmUpload } from "../files/service.js";

type TenantDb = NodePgDatabase<typeof schema>;

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
  const { dealId, uploaderId } = await resolveScorecardUploader(
    db,
    input.scorecardId,
    input.sessionUserId,
  );
  const ext = extensionForContentType(input.contentType);

  const result = await requestUploadUrl(db, input.officeSlug, uploaderId, {
    originalFilename: `corrective-action-${Date.now()}.${ext}`,
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
  // Resolve the deal (belt-and-suspenders; the caller already bound the token to this scorecard) AND the
  // uploader — a session user id, or the scorecard's submitter for a token responder (never a nil uuid,
  // which would FK-violate files.uploaded_by → public.users).
  const { uploaderId } = await resolveScorecardUploader(db, input.scorecardId, input.sessionUserId);
  const { file } = await confirmUpload(db, uploaderId, {
    uploadToken: input.uploadToken,
  });
  return { fileId: file.id };
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

async function resolveScorecard(
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
