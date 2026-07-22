import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { requestUploadUrl, confirmUpload } from "../files/service.js";

type TenantDb = NodePgDatabase<typeof schema>;

// A stable, FK-less sentinel used as files.uploaded_by for an email-only (token) responder who has no CRM
// user id. files.uploaded_by is NOT NULL with no FK reference, so a nil uuid is safe and lets us key the
// idempotent-confirm dedup (uploadedBy) consistently for token uploads.
export const CORRECTIVE_ACTION_SYSTEM_UPLOADER = "00000000-0000-0000-0000-000000000000";

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
  /** The uploader identity — a CRM user id (session) or the system sentinel (email-only token responder). */
  uploaderId: string;
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
  const dealId = await resolveScorecardDealId(db, input.scorecardId);
  const ext = extensionForContentType(input.contentType);

  const result = await requestUploadUrl(db, input.officeSlug, input.uploaderId, {
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
  uploaderId: string;
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
  // Resolve the deal so a foreign token can't file the row against another project (belt-and-suspenders;
  // the caller already bound the token to this scorecard).
  await resolveScorecardDealId(db, input.scorecardId);
  const { file } = await confirmUpload(db, input.uploaderId, {
    uploadToken: input.uploadToken,
  });
  return { fileId: file.id };
}

async function resolveScorecardDealId(db: TenantDb, scorecardId: string): Promise<string> {
  const res = await db.execute(
    sql`SELECT deal_id FROM field_scorecards WHERE id = ${scorecardId} LIMIT 1`,
  );
  const dealId = (res.rows[0] as { deal_id?: string } | undefined)?.deal_id;
  if (!dealId) throw new AppError(404, "Scorecard not found.");
  return dealId;
}
