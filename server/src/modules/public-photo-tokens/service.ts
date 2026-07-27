import crypto from "crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { db, pool, releasePooledClient, isBrokenConnectionError } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { getDealPhotoIdsInScope, getDealPhotoTimeline } from "../files/service.js";
import { logPhotoEvent } from "../files/audit-log-service.js";
import { latestActiveVersionCondition, type DealPhotoTimelineFilters } from "../files/photo-timeline-filters.js";
import { getObjectBuffer, getObjectStream, ObjectTooLargeError } from "../../lib/r2-client.js";
import { generateThumbnailBuffer } from "../../lib/image-thumbnail.js";
import { isStrippableJpeg } from "./image-metadata.js";
import { isTranscodableToJpeg, transcodeToStrippedJpeg } from "./image-transcode.js";

type TenantDb = NodePgDatabase<typeof schema>;

const PUBLIC_TOKEN_BYTES = 32;
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
// Upper bound on a non-JPEG original we'll buffer + transcode on the public proxy. The field upload has
// no size cap, so without this a large (or maliciously large) shared PNG/WebP would be read fully into
// memory and decoded — a memory/CPU DoS vector on this unauthenticated endpoint. JPEGs are unaffected
// (they stream). 40 MB is generous for any real photo; anything larger 422s (placeholder).
const MAX_TRANSCODE_BYTES = 40 * 1024 * 1024;

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
// outside the token's scope 404s even if guessed. Whole-deal tokens (NULL photo_ids) match everything
// in the deal, so the EXISTS is satisfied by the `t.photo_ids IS NULL` arm.
//
// Compares against the token row's STORED photo_ids instead of re-sending the id list. The previous
// shape marshalled ONE BIND PARAMETER PER ID into `ARRAY[$1::uuid, $2::uuid, …]` and injected it here —
// and this predicate runs on EVERY per-photo asset/download request. At the 200 cap that was 200
// requests x 200 params; at the 3000 cap it would be 3000 requests each re-sending a 3000-element uuid
// array (~9M parameters to view one gallery, and within one order of magnitude of Postgres's
// 65535-parameters-per-statement ceiling). One uuid now goes over the wire and Postgres compares the
// array in place.
//
// The token's revoked/expired guard is repeated here on purpose: the caller validated the token in a
// separate statement, so re-checking closes the window where a link revoked in between still serves
// bytes from an in-flight gallery.
function tokenPhotoScopeSql(tokenId: string) {
  return sql` AND EXISTS (
    SELECT 1 FROM public.public_photo_tokens t
    WHERE t.id = ${tokenId}::uuid
      AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > now())
      -- cardinality guard: normalizePhotoIds maps an EMPTY array to "whole deal" on the JS side, but
      -- IS NULL is FALSE for an empty array, so without this an empty-array row would LIST a deal's
      -- photos in the viewer and then 404 every single tile. Not reachable via generatePublicToken
      -- today; cheap to make unreachable by construction.
      AND (t.photo_ids IS NULL OR cardinality(t.photo_ids) = 0 OR files.id = ANY(t.photo_ids))
  )`;
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

// Serve-time eligibility for per-photo lookups, mirroring getDealPhotoTimeline: only ACTIVE,
// LATEST-version photos. A photo valid at mint time can be superseded later, and the viewer re-hides it
// via the SAME latest-version predicate; without this a direct/cached subset-share URL keeps serving a
// superseded (or since-deactivated) photo the public viewer no longer lists.
//
// Routes through the canonical latestActiveVersionCondition (files/photo-timeline-filters.ts) — the single
// source of truth shared by the timeline/viewer/mint AND this public-share asset/download, so they can
// never disagree on "latest". (uploadNewVersion stores every version with parent_file_id = ROOT id, a flat
// family; the helper groups by COALESCE(parent_file_id, id) and excludes a row when any ACTIVE family
// member has a higher version — the old `NOT EXISTS child` check only excluded the root.)
// Exported for the runtime test (PGlite) that proves a superseded non-root version is excluded.
export function latestActivePhotoSql() {
  return sql` AND is_active = true AND ${latestActiveVersionCondition()}`;
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

// Validates that every requested photo id is one the deal's photo timeline would show — by running the
// ids through the SAME buildDealPhotoTimelineConditions scope the field UI and public viewer use. That
// scope covers deal+lead lineage (converted-lead photos via sourceLeadId), photo category, active +
// latest-version (superseded versions excluded), and not-deleted. Reusing it means a sharable selection
// exactly matches what the field app shows — no divergent membership rule. Throws 400 if any id isn't
// returned (foreign deal, superseded version, non-photo, deleted). No-op for an empty list.
// Callers must pass canonical (lowercase) uuids so ids match Postgres's lowercase form.
//
// Reads ids only (getDealPhotoIdsInScope) rather than the full timeline: the predicate is identical, but
// this is the ONE step whose cost scales with the share cap rather than a page size, and the full
// timeline would fetch 3000 x 49-column rows plus ~6000 presigned URLs just to read `.id` off them.
export async function assertPhotosBelongToDeal(
  tenantDb: TenantDb,
  dealId: string,
  photoIds: string[]
): Promise<void> {
  if (photoIds.length === 0) return;
  const foundIds = new Set(await getDealPhotoIdsInScope(tenantDb, dealId, photoIds));
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
  let releaseErr: unknown;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('search_path', $1, true)", [`office_${tenant.slug},public`]);
    const tenantDb = drizzle(client, { schema }) as TenantDb;
    const value = await handler(tenantDb, tenant);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    if (isBrokenConnectionError(err)) {
      // Dead socket — skip ROLLBACK (it can't succeed and would wait another query_timeout); destroy.
      releaseErr = err;
    } else {
      let rollbackErr: unknown;
      await client.query("ROLLBACK").catch((e) => { rollbackErr = e; });
      releaseErr = rollbackErr ?? err;
    }
    throw err;
  } finally {
    releasePooledClient(client, releaseErr);
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
//
// `imageUrl` (grid) and `fullImageUrl` (lightbox) are the same proxy endpoint with a different
// `variant`, so the split adds no exposure: identical gates, identical stripping, same hidden object
// key. It exists so the grid stops paying full resolution for a 200px tile — see resolvePublicThumbnail.
function publicPhotoShape(photo: any, imageUrl: string | null, fullImageUrl: string | null) {
  return {
    id: photo.id,
    imageUrl,
    fullImageUrl,
  };
}

/**
 * Builds the token-scoped public asset URL that streams a photo through the API instead of handing
 * out a presigned R2 URL. Presigned R2 URLs embed the object key (`.../deals/{dealNumber}/...`),
 * which would leak the deal number this public surface deliberately omits. The proxy hides the key
 * and strips EXIF on the way out.
 */
function publicPhotoAssetUrl(
  assetBaseUrl: string,
  rawToken: string,
  photoId: string,
  options: { download?: boolean; variant?: "thumb" } = {},
): string {
  const base = assetBaseUrl.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(rawToken)}/photos/${encodeURIComponent(photoId)}/image`;
  const params = new URLSearchParams();
  if (options.download) params.set("download", "1");
  if (options.variant) params.set("variant", options.variant);
  const query = params.toString();
  return query ? `${url}?${query}` : url;
}

// Whether an R2-backed photo can be served through the public proxy. JPEGs stream (size-independent);
// non-JPEG rasters are buffered + transcoded, so they're capped at MAX_TRANSCODE_BYTES. An oversized
// transcodable photo is therefore NOT servable — so the viewer/download advertise nothing (placeholder),
// matching the asset endpoint's 422, instead of a broken <img>. Unknown/NaN size is treated as
// within-cap (the asset endpoint's HEAD-gate is the authoritative backstop). HEIC/HEIF (no libheif) and
// non-rasters are never servable.
function isPublicProxyServable(
  mimeType: string | null | undefined,
  fileExtension: string | null | undefined,
  fileSizeBytes: number | string | null | undefined,
): boolean {
  if (isStrippableJpeg(mimeType, fileExtension)) return true;
  if (isTranscodableToJpeg(mimeType, fileExtension)) {
    const size = fileSizeBytes == null ? null : Number(fileSizeBytes);
    return size == null || Number.isNaN(size) || size <= MAX_TRANSCODE_BYTES;
  }
  return false;
}

function publicPhotoImageUrl(
  photo: any,
  assetBaseUrl: string | undefined,
  rawToken: string,
  variant?: "thumb",
): string | null {
  if (!isPublicPhotoImagePreviewable(photo)) return null;
  // R2-backed photos are served through the API proxy (object key hidden, metadata stripped). JPEGs are
  // EXIF-stripped on the fly; PNG/WebP/GIF/AVIF/TIFF originals are re-encoded server-side to a
  // metadata-free JPEG by the proxy (getPublicPhotoAsset) — the raw original is NEVER served. Non-servable
  // cases (HEIC/HEIF, or a transcodable original over the size cap) return null => placeholder, no failed
  // request. External (CompanyCam CDN) URLs don't carry the deal number and are served directly.
  if (photo.r2Key) {
    if (!isPublicProxyServable(photo.mimeType, photo.fileExtension, photo.fileSizeBytes)) return null;
    return assetBaseUrl ? publicPhotoAssetUrl(assetBaseUrl, rawToken, photo.id, { variant }) : null;
  }
  // External-only (CompanyCam) imports already publish two sizes; use the CDN's own thumbnail for the
  // grid so this branch gets the same "small bytes in the grid" treatment as the proxied one.
  return variant === "thumb"
    ? photo.externalThumbnailUrl ?? photo.externalUrl ?? null
    : photo.externalUrl ?? photo.externalThumbnailUrl ?? null;
}

/**
 * How many photos one public-viewer page returns. The viewer USED TO take `getDealPhotoTimeline(…, 1,
 * 500)` with no pagination at all in its response, which meant a link scoped to more than 500 photos
 * rendered exactly 500 of them — no error, no truncation notice, no way for the recipient to know. That
 * was already misleading production whole-deal links (19 projects hold more than 500 photos, the largest
 * 2,911), and raising the share cap to 3000 would have made it the norm. Paging is therefore a
 * PREREQUISITE of the cap raise, not a nicety.
 *
 * 60 fills a 5-column grid twelve rows deep — about two screens — so the first paint is fast and the
 * rest streams in as the recipient scrolls. The max is what bounds the per-request cost now that the
 * selection itself no longer does: at most 200 timeline rows and ~400 presigns per request, regardless
 * of whether the token covers 200 photos or 3000.
 */
const PUBLIC_VIEWER_DEFAULT_PER_PAGE = 60;
const PUBLIC_VIEWER_MAX_PER_PAGE = 200;

export async function getPublicPhotoViewer(
  rawToken: string,
  options: { assetBaseUrl?: string; filters?: DealPhotoTimelineFilters; page?: number; limit?: number } = {}
) {
  const filters = options.filters ?? {};
  // Clamp before use: `?page=abc` / `?limit=-1` would otherwise reach SQL as a NaN/negative OFFSET.
  const page = Number.isFinite(options.page) && (options.page as number) >= 1 ? Math.floor(options.page as number) : 1;
  const limit = Number.isFinite(options.limit) && (options.limit as number) >= 1
    ? Math.min(Math.floor(options.limit as number), PUBLIC_VIEWER_MAX_PER_PAGE)
    : PUBLIC_VIEWER_DEFAULT_PER_PAGE;
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

    // Still routed through getDealPhotoTimeline rather than a hand-written narrow query. The narrow
    // query is tempting (49 columns and 2 presigns per row are discarded by publicPhotoShape), but
    // paging already bounds that waste to the page size, whereas re-implementing the scope is exactly
    // where `latestActiveVersionCondition` or `deleted_at IS NULL` gets dropped — and on THIS surface a
    // dropped predicate means a revoked or superseded photo reappearing on a public link.
    const timeline = await getDealPhotoTimeline(tenantDb, token.dealId, page, limit, {
      ...filters,
      includeDeleted: false,
      // Subset token (non-null photo_ids) -> the viewer lists ONLY those photos; whole-deal token -> all.
      photoIds: token.photoIds ?? undefined,
    });
    const photos = timeline.photos.map((photo) =>
      publicPhotoShape(
        photo,
        publicPhotoImageUrl(photo, options.assetBaseUrl, rawToken, "thumb"),
        publicPhotoImageUrl(photo, options.assetBaseUrl, rawToken),
      )
    );

    return {
      // Public exposure lock: property name + address only — no deal id, no token id,
      // no deal number (the deal number is also hidden by the image proxy).
      deal: {
        name: deal.name,
        propertyAddress: deal.property_address ?? null,
      },
      photos,
      // `total` is the share's real size. The recipient-facing page uses it to keep loading, and it is
      // what makes an under-delivered gallery detectable instead of silent.
      pagination: timeline.pagination,
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
      SELECT id, deal_id, category, file_extension, external_url, r2_key, mime_type, file_size_bytes
      FROM files
      WHERE id = ${photoId}::uuid
        AND ${dealPhotoOwnershipSql(token.dealId)}
        AND category = 'photo'
        AND deleted_at IS NULL${tokenPhotoScopeSql(token.tokenId)}${latestActivePhotoSql()}
      LIMIT 1
    `);
    const photo = ((photoResult as any).rows ?? photoResult)[0];
    if (!photo) throw new AppError(404, "Photo not found");

    const filename = publicDownloadFilename(photo.file_extension);
    // Mirror the image proxy exactly so the download path can't expose anything the viewer hides:
    //   - R2 JPEG               -> proxy ?download=1 (key hidden, EXIF stripped)
    //   - R2 PNG/WebP/... (<cap) -> proxy ?download=1 (re-encoded to a metadata-free JPEG; raw never served)
    //   - R2 HEIC/HEIF or oversized transcodable -> 404 (not servable; do NOT fall back to external_url,
    //                       which would leak the unstripped original)
    //   - external only         -> the CompanyCam CDN URL (no R2 copy; no deal number in the key)
    let result: { url: string; filename: string };
    if (photo.r2_key) {
      if (!context.assetBaseUrl || !isPublicProxyServable(photo.mime_type, photo.file_extension, photo.file_size_bytes)) {
        throw new AppError(404, "Photo not found");
      }
      if (isStrippableJpeg(photo.mime_type, photo.file_extension)) {
        result = { url: publicPhotoAssetUrl(context.assetBaseUrl, rawToken, String(photo.id), { download: true }), filename };
      } else {
        // Transcodable non-JPEG within the size cap -> served as a transcoded JPEG, so the download is photo.jpg.
        result = { url: publicPhotoAssetUrl(context.assetBaseUrl, rawToken, String(photo.id), { download: true }), filename: "photo.jpg" };
      }
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
  | { kind: "jpeg-stream"; stream: AsyncIterable<Uint8Array>; contentType: string; filename: string }
  | { kind: "jpeg-buffer"; buffer: Buffer; contentType: string; filename: string };

/**
 * Admission control for ON-DEMAND grid thumbnails (see resolvePublicThumbnail). Each render buffers an
 * original into memory and decodes it in sharp, so an unbounded burst is both a memory and a CPU hazard
 * on this PUBLIC, unauthenticated endpoint — 40 MB (MAX_TRANSCODE_BYTES) x N live buffers is how you OOM
 * the API from a shared link.
 *
 * QUEUE, don't shed. A plain burst cap (the lib/pdf-thumbnail.ts pattern) is right there because a
 * skipped PDF render costs only a type badge. Here shedding is self-defeating: a 60-tile page fires
 * dozens of concurrent requests, so a bare cap of 4 would hand a thumbnail to 4 tiles and stream
 * full-resolution originals to the rest — on exactly the legacy galleries (81% of production photos have
 * no stored thumbnail) this feature exists to speed up, and the "shed" path is INVISIBLE, so the
 * regression would never surface. Waiting a few hundred ms for a ~40 KB render beats downloading 0.58 MB
 * immediately. The FIFO grant mirrors withHeicDecodePermit in lib/image-thumbnail.ts.
 *
 * The waiter list is bounded because the queue is itself a resource: past that depth we DO fall back to
 * the full-res path, so a pathological burst degrades to "correct but heavier" instead of parking
 * unbounded requests.
 */
const MAX_CONCURRENT_PUBLIC_THUMBNAILS = 4;
const MAX_QUEUED_PUBLIC_THUMBNAILS = 48;
let activePublicThumbnails = 0;
const publicThumbnailWaiters: Array<() => void> = [];

/** Resolves true once a permit is held, or false when the queue is too deep to wait. */
async function acquirePublicThumbnailPermit(): Promise<boolean> {
  if (activePublicThumbnails < MAX_CONCURRENT_PUBLIC_THUMBNAILS) {
    activePublicThumbnails += 1;
    return true;
  }
  if (publicThumbnailWaiters.length >= MAX_QUEUED_PUBLIC_THUMBNAILS) return false;
  // The releaser hands the permit over already incremented, so no second increment here.
  await new Promise<void>((resolve) => publicThumbnailWaiters.push(resolve));
  return true;
}

function releasePublicThumbnailPermit(): void {
  const next = publicThumbnailWaiters.shift();
  // Transfer the permit directly to the next waiter rather than decrementing and letting it re-check:
  // the count stays occupied across the handoff, so a request arriving in that window cannot slip ahead
  // and push concurrency above the cap.
  if (next) next();
  else activePublicThumbnails -= 1;
}

// A STORED thumbnail is our own 600px/q70 output — tens of KB. Buffering it needs no permit, but it
// still gets a ceiling far below MAX_TRANSCODE_BYTES so a mis-pointed key can't pull a full-size
// original into memory on an uncapped path.
const MAX_STORED_THUMBNAIL_BYTES = 4 * 1024 * 1024;

/**
 * Grid-sized JPEG for a photo, or null to fall back to the full-res path.
 *
 * WHY THIS EXISTS: the proxy only ever resolved `r2_key`, so the recipient's GRID was being served
 * full-resolution ORIGINALS — averaging 0.58 MB each in production. At the old 200 cap that was ~116 MB
 * per gallery; at 3000 it is ~1.7 GB streamed through one Node process for a single share. Thumbnails
 * are ~40 KB, a ~14x reduction, and this is the single largest cost in the whole feature.
 *
 * Two sources, in order:
 *   1. `thumbnail_r2_key` — the sharp thumbnail generated at confirmUpload (#808). Free, but only 19%
 *      of production photos have one: the column postdates most of the library and the backfill it
 *      anticipates has never run (migrations/0169). Serving only this would leave every legacy project
 *      — i.e. exactly the big ones this feature is for — on full-res originals.
 *   2. rendered on demand from the original, burst-capped. Deliberately NOT persisted back to R2: that
 *      would be a write driven by an unauthenticated request, and a one-off backfill script is the
 *      right way to make this permanent (this repo runs those as inert dry-run/--commit scripts).
 *
 * Exposure-safe either way: both paths are sharp re-encodes, which drop EXIF/GPS by construction, so a
 * thumbnail never needs (or gets) the pipeStrippedJpeg pass the raw-original stream requires.
 */
async function resolvePublicThumbnail(photo: {
  r2_key?: string | null;
  thumbnail_r2_key?: string | null;
  mime_type?: string | null;
  file_extension?: string | null;
}): Promise<PublicPhotoAsset | null> {
  if (photo.thumbnail_r2_key) {
    try {
      // ~40 KB — buffering it costs nothing and lets it reuse the "already clean, send as-is" branch
      // instead of running a JPEG stripper over bytes sharp already emitted metadata-free.
      const { buffer } = await getObjectBuffer(photo.thumbnail_r2_key, { maxBytes: MAX_STORED_THUMBNAIL_BYTES });
      return { kind: "jpeg-buffer", buffer, contentType: "image/jpeg", filename: "photo.jpg" };
    } catch (err) {
      // A thumbnail_r2_key can outlive its object (thumbnail generation is best-effort and the R2
      // write is not transactional with the row). Falling through to render one on demand — and
      // ultimately to the full-res original — keeps a stale key from 500-ing a customer's tile.
      console.warn(`[public-photo-token] stored thumbnail unavailable for ${photo.thumbnail_r2_key}:`, err);
    }
  }
  if (!photo.r2_key) return null;
  if (!(await acquirePublicThumbnailPermit())) return null;

  try {
    const { buffer } = await getObjectBuffer(photo.r2_key, { maxBytes: MAX_TRANSCODE_BYTES });
    return {
      kind: "jpeg-buffer",
      buffer: await generateThumbnailBuffer(buffer),
      contentType: "image/jpeg",
      filename: "photo.jpg",
    };
  } catch (err) {
    // Best-effort by design: an oversized original, a decode failure, or an R2 hiccup falls back to the
    // full-res path (which applies its own size/format gates) rather than punching a hole in the grid.
    if (!(err instanceof ObjectTooLargeError)) {
      console.warn(`[public-photo-token] on-demand thumbnail failed for ${photo.r2_key}:`, err);
    }
    return null;
  } finally {
    releasePublicThumbnailPermit();
  }
}

/**
 * Resolves a single photo for the public viewer proxy. R2-backed JPEGs return a raw byte stream the
 * route strips + streams (key never exposed, EXIF removed); R2-backed NON-JPEG rasters
 * (PNG/WebP/GIF/AVIF/TIFF) are re-encoded server-side to a metadata-free JPEG buffer — the raw
 * original is NEVER streamed. External (CompanyCam) photos return a redirect target. Formats we can't
 * decode (HEIC/HEIF — no libheif in sharp's prebuilt) are 404'd, never served raw. Token validated
 * read-only (no access_count increment); the photo row is read in the tenant transaction, which is
 * released before the R2 fetch so a pooled connection is never held across network I/O.
 *
 * `variant: "thumb"` serves the grid-sized JPEG (see resolvePublicThumbnail); the lightbox keeps
 * requesting the default full-res variant. The token/ownership/latest-version gates are identical for
 * both — the variant only chooses which bytes to send, never which photos are reachable.
 */
export async function getPublicPhotoAsset(
  rawToken: string,
  photoId: string,
  options: { variant?: "full" | "thumb" } = {},
): Promise<PublicPhotoAsset> {
  const token = await resolvePublicPhotoToken(rawToken);
  const photo = await withPublicPhotoTenant(token.tenantId, async (tenantDb) => {
    const photoResult = await tenantDb.execute(sql`
      SELECT id, r2_key, thumbnail_r2_key, mime_type, file_extension, external_url
      FROM files
      WHERE id = ${photoId}::uuid
        AND ${dealPhotoOwnershipSql(token.dealId)}
        AND category = 'photo'
        AND deleted_at IS NULL${tokenPhotoScopeSql(token.tokenId)}${latestActivePhotoSql()}
      LIMIT 1
    `);
    return ((photoResult as any).rows ?? photoResult)[0];
  });

  if (!photo) throw new AppError(404, "Photo not found");
  if (photo.r2_key) {
    // Gate the thumbnail on the SAME servability rule as the full-res path, before any bytes are
    // fetched: a HEIC original must stay a placeholder, not become a thumbnail the viewer can't reach.
    if (options.variant === "thumb" && isPublicProxyServable(photo.mime_type, photo.file_extension, null)) {
      const thumbnail = await resolvePublicThumbnail(photo);
      if (thumbnail) return thumbnail;
    }
    if (isStrippableJpeg(photo.mime_type, photo.file_extension)) {
      const object = await getObjectStream(photo.r2_key);
      return {
        kind: "jpeg-stream",
        stream: object.stream,
        contentType: "image/jpeg",
        filename: publicDownloadFilename(photo.file_extension),
      };
    }
    if (isTranscodableToJpeg(photo.mime_type, photo.file_extension)) {
      // Re-encode the non-JPEG original to a metadata-free JPEG; NEVER stream the raw original (its
      // EXIF/GPS can't be stripped by the JPEG-only stripper). getObjectBuffer enforces the size cap
      // itself — it rejects on GET Content-Length and aborts the stream before over-accumulating — so an
      // oversized object is NEVER fully buffered, even if HEAD/size metadata is unavailable (the DoS
      // guard holds without a separate HEAD). A real R2/network outage propagates (->500), not masked.
      let buffer: Buffer;
      try {
        ({ buffer } = await getObjectBuffer(photo.r2_key, { maxBytes: MAX_TRANSCODE_BYTES }));
      } catch (err) {
        if (err instanceof ObjectTooLargeError) throw new AppError(422, "Unprocessable image");
        throw err;
      }
      // Only a decode failure (corrupt/unexpected bytes, or a pixel-bomb over limitInputPixels) is
      // mapped — to 422, mirroring the JPEG stripper — so we still never leak raw bytes.
      let jpeg: Buffer;
      try {
        jpeg = await transcodeToStrippedJpeg(buffer);
      } catch {
        throw new AppError(422, "Unprocessable image");
      }
      return { kind: "jpeg-buffer", buffer: jpeg, contentType: "image/jpeg", filename: "photo.jpg" };
    }
    throw new AppError(404, "Photo not found"); // un-decodable (HEIC/HEIF) — never served raw
  }
  if (photo.external_url) return { kind: "external", url: photo.external_url };
  throw new AppError(404, "Photo not found");
}
