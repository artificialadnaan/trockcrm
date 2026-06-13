import crypto from "crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { db, pool } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { getDealPhotoTimeline } from "../files/service.js";
import { logPhotoEvent } from "../files/audit-log-service.js";
import type { DealPhotoTimelineFilters } from "../files/photo-timeline-filters.js";
import { getObjectStream } from "../../lib/r2-client.js";
import { isStrippableJpeg } from "./image-metadata.js";

type TenantDb = NodePgDatabase<typeof schema>;

const PUBLIC_TOKEN_BYTES = 32;
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".webp"]);

export type PublicTokenStatus = "active" | "expired" | "revoked";

function normalizeExplicitExtension(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function extensionFromPathLikeValue(value: string | null | undefined): string | null {
  if (!value) return null;
  let candidate = value.trim();
  if (!candidate) return null;

  try {
    if (/^https?:\/\//i.test(candidate)) candidate = new URL(candidate).pathname;
  } catch {
    return null;
  }

  candidate = candidate.split(/[?#]/, 1)[0] ?? "";
  const basename = candidate.slice(candidate.lastIndexOf("/") + 1).trim().toLowerCase();
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === basename.length - 1) return null;
  return basename.slice(dotIndex);
}

function firstKnownExtension(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const extension = extensionFromPathLikeValue(value);
    if (extension) return extension;
  }
  return null;
}

function isPublicPhotoImagePreviewable(photo: {
  mimeType?: string | null;
  fileExtension?: string | null;
  displayName?: string | null;
  r2Key?: string | null;
  externalUrl?: string | null;
  externalThumbnailUrl?: string | null;
}) {
  const mimeType = photo.mimeType?.trim().toLowerCase();
  if (mimeType) return mimeType.startsWith("image/");

  const explicitExtension = normalizeExplicitExtension(photo.fileExtension);
  if (explicitExtension) return IMAGE_EXTENSIONS.has(explicitExtension);

  // Keep this order in sync with client/src/lib/photo-url-resolution.ts:
  // storage/source URLs are authoritative, displayName is a user-controlled label.
  const inferredExtension = firstKnownExtension(photo.r2Key, photo.externalThumbnailUrl, photo.externalUrl, photo.displayName);
  if (inferredExtension) return IMAGE_EXTENSIONS.has(inferredExtension);

  return true;
}

export function generateRawPublicToken(): string {
  return crypto.randomBytes(PUBLIC_TOKEN_BYTES).toString("base64url");
}

export function hashPublicPhotoToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function tokenStatus(row: { revoked_at?: Date | string | null; expires_at?: Date | string | null }, now = new Date()): PublicTokenStatus {
  if (row.revoked_at) return "revoked";
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  return "active";
}

// Build a parameterized `uuid[]` SQL value (each element cast explicitly) so subset photo-id
// lists never depend on driver array serialization. NULL/empty -> SQL NULL = a whole-deal token.
function photoIdsArrayParam(photoIds: string[] | null | undefined) {
  if (!photoIds || photoIds.length === 0) return sql`NULL::uuid[]`;
  return sql`ARRAY[${sql.join(photoIds.map((id) => sql`${id}::uuid`), sql`, `)}]`;
}

// PG returns a uuid[] column as a string[] (or null). Normalize empty arrays to null so callers
// only ever see "null = whole deal" vs "non-empty subset".
function normalizePhotoIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.map((id) => String(id));
}

// Limits a per-photo lookup (`files.id`) to a subset token's photo_ids — so a requested photo id
// outside the token's scope 404s even if guessed. No-op for whole-deal tokens (null photo_ids).
function tokenPhotoScopeSql(photoIds: string[] | null) {
  return photoIds === null ? sql`` : sql` AND id = ANY(${photoIdsArrayParam(photoIds)})`;
}

// A token's deal may be a converted lead, whose photos live under files.lead_id = deals.source_lead_id.
// The field timeline + public viewer include that lineage (buildDealPhotoScopeCondition), so the
// per-photo asset/download lookups must use the SAME deal+source-lead scope — otherwise a lead-lineage
// photo that the viewer lists (and that was minted into the token) 404s on its image/download. The
// correlated subquery returns NULL for non-converted deals, so `lead_id = NULL` is never true and the
// scope collapses to deal_id only.
function dealPhotoOwnershipSql(dealId: string) {
  return sql`(deal_id = ${dealId}::uuid OR lead_id = (SELECT source_lead_id FROM deals WHERE id = ${dealId}::uuid))`;
}

export async function generatePublicToken(input: {
  dealId: string;
  createdByUserId: string;
  tenantId: string;
  expiresAt?: Date | null;
  // Scope the token to a specific set of photo ids. Omit / null / empty = whole-deal token.
  photoIds?: string[] | null;
}): Promise<{ rawToken: string; token: { id: string; dealId: string; tenantId: string; expiresAt: string | null } }> {
  const rawToken = generateRawPublicToken();
  const tokenHash = hashPublicPhotoToken(rawToken);
  const result = await db.execute(sql`
    INSERT INTO public.public_photo_tokens (token, deal_id, tenant_id, created_by_user_id, expires_at, photo_ids)
    VALUES (${tokenHash}, ${input.dealId}::uuid, ${input.tenantId}::uuid, ${input.createdByUserId}::uuid, ${input.expiresAt ?? null}, ${photoIdsArrayParam(input.photoIds)})
    RETURNING id, deal_id, tenant_id, expires_at
  `);
  const row = ((result as any).rows ?? result)[0];
  return {
    rawToken,
    token: {
      id: row.id,
      dealId: row.deal_id,
      tenantId: row.tenant_id,
      expiresAt: normalizeDate(row.expires_at),
    },
  };
}

// Validates that every requested photo id is one the deal's photo timeline would show — by running
// the ids through the SAME getDealPhotoTimeline scope the field UI and public viewer use. That scope
// covers deal+lead lineage (converted-lead photos via sourceLeadId), photo category, active +
// latest-version (superseded versions excluded), and not-deleted. Reusing it means a sharable
// selection exactly matches what the field app shows — no divergent membership rule. Throws 400 if any
// id isn't returned (foreign deal, superseded version, non-photo, deleted). No-op for an empty list.
// Callers must pass canonical (lowercase) uuids so ids match Postgres's lowercase form.
export async function assertPhotosBelongToDeal(
  tenantDb: TenantDb,
  dealId: string,
  photoIds: string[]
): Promise<void> {
  if (photoIds.length === 0) return;
  const timeline = await getDealPhotoTimeline(tenantDb, dealId, 1, photoIds.length, {
    photoIds,
    includeDeleted: false,
  });
  const foundIds = new Set(timeline.photos.map((photo) => photo.id));
  const missing = photoIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new AppError(400, "One or more selected photos are not part of this project.");
  }
}

export async function verifyAndConsumeToken(rawToken: string): Promise<{
  tokenId: string;
  dealId: string;
  tenantId: string;
  createdByUserId: string;
  photoIds: string[] | null;
}> {
  const tokenHash = hashPublicPhotoToken(rawToken);
  const result = await db.execute(sql`
    UPDATE public.public_photo_tokens
    SET access_count = access_count + 1,
        last_accessed_at = now()
    WHERE token = ${tokenHash}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    RETURNING id, deal_id, tenant_id, created_by_user_id, photo_ids
  `);
  const row = ((result as any).rows ?? result)[0];
  if (!row) throw new AppError(404, "Photo link not found");
  return {
    tokenId: row.id,
    dealId: row.deal_id,
    tenantId: row.tenant_id,
    createdByUserId: row.created_by_user_id,
    photoIds: normalizePhotoIds(row.photo_ids),
  };
}

// Read-only token validation (no access_count increment) — used for per-photo asset requests, where
// a gallery loads many images and counting each as an "access" would be noise.
export async function resolvePublicPhotoToken(rawToken: string): Promise<{
  tokenId: string;
  dealId: string;
  tenantId: string;
  photoIds: string[] | null;
}> {
  const tokenHash = hashPublicPhotoToken(rawToken);
  const result = await db.execute(sql`
    SELECT id, deal_id, tenant_id, photo_ids
    FROM public.public_photo_tokens
    WHERE token = ${tokenHash}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `);
  const row = ((result as any).rows ?? result)[0];
  if (!row) throw new AppError(404, "Photo link not found");
  return { tokenId: row.id, dealId: row.deal_id, tenantId: row.tenant_id, photoIds: normalizePhotoIds(row.photo_ids) };
}

export async function revokeToken(tokenId: string, userId: string, tenantId?: string): Promise<void> {
  const result = await db.execute(sql`
    UPDATE public.public_photo_tokens
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE id = ${tokenId}::uuid
      ${tenantId ? sql`AND tenant_id = ${tenantId}::uuid` : sql``}
    RETURNING id
  `);
  const row = ((result as any).rows ?? result)[0];
  if (!row) throw new AppError(404, "Photo token not found");
  console.info(`[public-photo-token] Token ${tokenId} revoked by ${userId}`);
}

export async function listTokensForDeal(dealId: string, tenantId?: string) {
  const result = await db.execute(sql`
    SELECT
      ppt.id,
      ppt.deal_id,
      ppt.tenant_id,
      ppt.created_by_user_id,
      u.display_name AS created_by_name,
      ppt.created_at,
      ppt.expires_at,
      ppt.revoked_at,
      ppt.last_accessed_at,
      ppt.access_count
    FROM public.public_photo_tokens ppt
    LEFT JOIN public.users u ON u.id = ppt.created_by_user_id
    WHERE ppt.deal_id = ${dealId}::uuid
      ${tenantId ? sql`AND ppt.tenant_id = ${tenantId}::uuid` : sql``}
    ORDER BY ppt.created_at DESC
  `);
  const rows = (result as any).rows ?? result;
  return rows.map((row: any) => ({
    id: row.id,
    dealId: row.deal_id,
    tenantId: row.tenant_id,
    createdBy: {
      id: row.created_by_user_id,
      name: row.created_by_name ?? "Unknown",
    },
    createdAt: normalizeDate(row.created_at)!,
    expiresAt: normalizeDate(row.expires_at),
    revokedAt: normalizeDate(row.revoked_at),
    lastAccessedAt: normalizeDate(row.last_accessed_at),
    accessCount: Number(row.access_count ?? 0),
    status: tokenStatus(row),
  }));
}

async function resolveTenant(tenantId: string): Promise<{ officeId: string; slug: string }> {
  const result = await pool.query(
    "SELECT id, slug FROM public.offices WHERE id = $1 AND is_active = true LIMIT 1",
    [tenantId]
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, "Photo link not found");
  if (!/^[a-z][a-z0-9_]*$/.test(row.slug)) throw new AppError(500, "Invalid office schema");
  return { officeId: row.id, slug: row.slug };
}

export async function withPublicPhotoTenant<T>(
  tenantId: string,
  handler: (tenantDb: TenantDb, tenant: { officeId: string; slug: string }) => Promise<T>
): Promise<T> {
  const tenant = await resolveTenant(tenantId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('search_path', $1, true)", [`office_${tenant.slug},public`]);
    const tenantDb = drizzle(client, { schema }) as TenantDb;
    const value = await handler(tenantDb, tenant);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// PUBLIC EXPOSURE LOCK (the customer-facing share page). Policy: expose the photos
// and the property name/address ONLY. Everything else is dropped here:
//   - uploader identity (uploadedBy / uploaderName / uploaderAvatarUrl)
//   - category / subcategory and the Procore sync status (internal classification)
//   - file/technical metadata (mimeType, fileSizeBytes, fileExtension)
//   - timestamps (takenAt / createdAt) and the caption (description)
// Per-photo GPS + geocoded address were already omitted; the deal number is hidden by
// the image proxy. `id` is the random photo UUID needed to address the proxied image
// (it's already embedded in imageUrl) — not a business identifier.
function publicPhotoShape(photo: any, imageUrl: string | null) {
  return {
    id: photo.id,
    imageUrl,
  };
}

/**
 * Builds the token-scoped public asset URL that streams a photo through the API instead of handing
 * out a presigned R2 URL. Presigned R2 URLs embed the object key (`.../deals/{dealNumber}/...`),
 * which would leak the deal number this public surface deliberately omits. The proxy hides the key
 * and strips EXIF on the way out.
 */
function publicPhotoAssetUrl(assetBaseUrl: string, rawToken: string, photoId: string, download = false): string {
  const base = assetBaseUrl.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(rawToken)}/photos/${encodeURIComponent(photoId)}/image`;
  return download ? `${url}?download=1` : url;
}

function publicPhotoImageUrl(photo: any, assetBaseUrl: string | undefined, rawToken: string): string | null {
  if (!isPublicPhotoImagePreviewable(photo)) return null;
  // R2-backed photos are streamed through the API proxy (key hidden, EXIF stripped) — but ONLY for
  // JPEG, the one format we can strip. Non-JPEG R2 originals (HEIC/PNG/WebP/GIF) could carry
  // un-strippable GPS, so they are NOT exposed on the public surface. External (CompanyCam CDN) URLs
  // don't carry the deal number and are served directly.
  if (photo.r2Key) {
    if (!isStrippableJpeg(photo.mimeType, photo.fileExtension)) return null;
    return assetBaseUrl ? publicPhotoAssetUrl(assetBaseUrl, rawToken, photo.id) : null;
  }
  return photo.externalThumbnailUrl ?? photo.externalUrl ?? null;
}

export async function getPublicPhotoViewer(
  rawToken: string,
  options: { assetBaseUrl?: string; filters?: DealPhotoTimelineFilters } = {}
) {
  const filters = options.filters ?? {};
  const token = await verifyAndConsumeToken(rawToken);
  return withPublicPhotoTenant(token.tenantId, async (tenantDb) => {
    const dealResult = await tenantDb.execute(sql`
      SELECT
        id,
        name,
        NULLIF(CONCAT_WS(', ', NULLIF(property_address, ''), NULLIF(property_city, ''), NULLIF(property_state, ''), NULLIF(property_zip, '')), '') AS property_address
      FROM deals
      WHERE id = ${token.dealId}::uuid
      LIMIT 1
    `);
    const deal = ((dealResult as any).rows ?? dealResult)[0];
    if (!deal) throw new AppError(404, "Photo link not found");

    const timeline = await getDealPhotoTimeline(tenantDb, token.dealId, 1, 500, {
      ...filters,
      includeDeleted: false,
      // Subset token (non-null photo_ids) -> the viewer lists ONLY those photos; whole-deal token -> all.
      photoIds: token.photoIds ?? undefined,
    });
    const photos = timeline.photos.map((photo) =>
      publicPhotoShape(photo, publicPhotoImageUrl(photo, options.assetBaseUrl, rawToken))
    );

    return {
      // Public exposure lock: property name + address only — no deal id, no token id,
      // no deal number (the deal number is also hidden by the image proxy).
      deal: {
        name: deal.name,
        propertyAddress: deal.property_address ?? null,
      },
      photos,
    };
  });
}

// The photo's internal display_name can carry the deal number or job notes, so the public
// surface never uses it for the download / Content-Disposition filename. Keep only the
// (non-sensitive) extension so the browser saves a usable file; default to .jpg because the
// proxied public image is always a stripped JPEG.
function publicDownloadFilename(fileExtension: string | null | undefined): string {
  return `photo${normalizeExplicitExtension(fileExtension) ?? ".jpg"}`;
}

export async function getPublicPhotoDownload(rawToken: string, photoId: string, context: {
  ipAddress?: string | null;
  userAgent?: string | null;
  assetBaseUrl?: string;
}) {
  const token = await verifyAndConsumeToken(rawToken);
  return withPublicPhotoTenant(token.tenantId, async (tenantDb) => {
    const photoResult = await tenantDb.execute(sql`
      SELECT id, deal_id, category, file_extension, external_url, r2_key, mime_type
      FROM files
      WHERE id = ${photoId}::uuid
        AND ${dealPhotoOwnershipSql(token.dealId)}
        AND category = 'photo'
        AND deleted_at IS NULL${tokenPhotoScopeSql(token.photoIds)}
      LIMIT 1
    `);
    const photo = ((photoResult as any).rows ?? photoResult)[0];
    if (!photo) throw new AppError(404, "Photo not found");

    const filename = publicDownloadFilename(photo.file_extension);
    // Mirror the image proxy exactly so the download path can't expose anything the viewer hides:
    //   - R2 JPEG        -> proxy ?download=1 (key hidden, EXIF stripped)
    //   - R2 non-JPEG    -> 404 (un-strippable original is never served publicly — do NOT fall back
    //                      to its external_url, which would leak the unstripped metadata)
    //   - external only  -> the CompanyCam CDN URL (no R2 copy; no deal number in the key)
    let result: { url: string; filename: string };
    if (photo.r2_key) {
      if (!isStrippableJpeg(photo.mime_type, photo.file_extension) || !context.assetBaseUrl) {
        throw new AppError(404, "Photo not found");
      }
      result = { url: publicPhotoAssetUrl(context.assetBaseUrl, rawToken, String(photo.id), true), filename };
    } else if (photo.external_url) {
      result = { url: photo.external_url, filename };
    } else {
      throw new AppError(404, "Photo not found");
    }

    await logPhotoEvent(tenantDb, {
      photoId: photo.id,
      eventType: "downloaded",
      userId: token.createdByUserId,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      metadata: {
        viaPublicToken: true,
        tokenId: token.tokenId,
      },
    });

    return result;
  });
}

export type PublicPhotoAsset =
  | { kind: "external"; url: string }
  | { kind: "jpeg-stream"; stream: AsyncIterable<Uint8Array>; contentType: string; filename: string };

/**
 * Resolves a single photo for the public viewer proxy. R2-backed JPEGs return a raw byte stream the
 * route strips + streams (key never exposed, EXIF removed); external (CompanyCam) photos return a
 * redirect target. NON-JPEG R2 originals (HEIC/PNG/WebP/GIF) are 404'd — we can't strip their
 * metadata, so they are not served on the public surface. Token validated read-only (no access_count
 * increment); the photo row is read in the tenant transaction, which is released before opening the
 * R2 stream so a pooled connection is never held across network I/O.
 */
export async function getPublicPhotoAsset(rawToken: string, photoId: string): Promise<PublicPhotoAsset> {
  const token = await resolvePublicPhotoToken(rawToken);
  const photo = await withPublicPhotoTenant(token.tenantId, async (tenantDb) => {
    const photoResult = await tenantDb.execute(sql`
      SELECT id, r2_key, mime_type, file_extension, external_url
      FROM files
      WHERE id = ${photoId}::uuid
        AND ${dealPhotoOwnershipSql(token.dealId)}
        AND category = 'photo'
        AND deleted_at IS NULL${tokenPhotoScopeSql(token.photoIds)}
      LIMIT 1
    `);
    return ((photoResult as any).rows ?? photoResult)[0];
  });

  if (!photo) throw new AppError(404, "Photo not found");
  if (photo.r2_key) {
    if (!isStrippableJpeg(photo.mime_type, photo.file_extension)) {
      throw new AppError(404, "Photo not found"); // non-JPEG R2 original is not served publicly
    }
    const object = await getObjectStream(photo.r2_key);
    return {
      kind: "jpeg-stream",
      stream: object.stream,
      contentType: "image/jpeg",
      filename: publicDownloadFilename(photo.file_extension),
    };
  }
  if (photo.external_url) return { kind: "external", url: photo.external_url };
  throw new AppError(404, "Photo not found");
}
