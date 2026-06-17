import { randomUUID } from "node:crypto";
import { headObject, deleteObject } from "../../lib/r2-client.js";
import { AppError } from "../../middleware/error-handler.js";

// Allowed signature-logo image types → file extension. The logo is stored in R2 and referenced by an
// <img> URL (never base64-embedded), so it must be a real hosted image of a known type.
export const SIGNATURE_LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
export const SIGNATURE_LOGO_MAX_BYTES = 1_000_000; // 1 MB

const KEY_PREFIX = "signature-logos";

/** Content-addressed key under the user's own folder. */
export function signatureLogoKey(userId: string, ext: string): string {
  return `${KEY_PREFIX}/${userId}/${randomUUID()}.${ext}`;
}

/**
 * A user may only act on (confirm/serve) their OWN logo key — guards the confirm step against
 * headObject/delete of an arbitrary or someone else's R2 key. The key must be exactly
 * `signature-logos/<userId>/<file>` with no traversal and no extra path segments.
 */
export function assertOwnedSignatureLogoKey(r2Key: string, userId: string): void {
  const prefix = `${KEY_PREFIX}/${userId}/`;
  const rest = typeof r2Key === "string" && r2Key.startsWith(prefix) ? r2Key.slice(prefix.length) : null;
  if (rest === null || rest.length === 0 || rest.includes("/") || rest.includes("..")) {
    throw new AppError(400, "Invalid logo reference.");
  }
}

/**
 * SERVER-SIDE size enforcement — the real guard. A presigned PUT can't bound the uploaded object's
 * size and there's no client we can trust, so after upload we read the object's actual size and
 * DELETE it if it exceeds the cap, before it can ever be served (the caller only gets a usable URL
 * once this passes). Throws 413 (after deleting the oversized object); 400 if the object isn't there.
 */
export async function enforceSignatureLogoSize(r2Key: string): Promise<void> {
  const head = await headObject(r2Key);
  if (!head) throw new AppError(400, "Logo upload not found.");
  if ((head.contentLength ?? 0) > SIGNATURE_LOGO_MAX_BYTES) {
    await deleteObject(r2Key);
    throw new AppError(413, "Logo must be under 1 MB.");
  }
}
