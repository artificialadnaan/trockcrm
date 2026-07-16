import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { properties } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

/** Hard cap on an uploaded property cover photo (matches the files upload-direct 50mb ceiling, tighter). */
export const PROPERTY_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/gif": "gif",
};

/**
 * Cover photos are served inline from their stored key, so we only accept formats the browser can render
 * directly — plus HEIC/HEIF, which the upload route transcodes to JPEG before storing. Everything else
 * (SVG's active-content risk, TIFF and other non-renderable rasters) is rejected rather than stored as a
 * cover that would open as a broken <img>.
 */
const ACCEPTED_PROPERTY_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

export function isAcceptablePropertyImageMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  return ACCEPTED_PROPERTY_IMAGE_MIMES.has(base);
}

const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
};

/**
 * The effective image type for an upload. Browsers often can't determine `file.type` for camera images
 * (HEIC especially) and send `application/octet-stream`; in that case fall back to the original filename's
 * extension so a valid photo isn't rejected before the decoder/transcoder can run. Returns the normalized
 * mime, or null when neither the Content-Type nor the extension identifies an accepted image.
 */
export function resolveEffectivePropertyImageMime(
  contentType: string | null | undefined,
  originalFilename: string | null | undefined,
): string | null {
  const base = contentType?.split(";")[0]?.trim().toLowerCase();
  if (base && ACCEPTED_PROPERTY_IMAGE_MIMES.has(base)) return base;

  const name = originalFilename ?? "";
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) {
    const ext = name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (EXTENSION_TO_MIME[ext]) return EXTENSION_TO_MIME[ext];
  }
  return null;
}

/**
 * HEIC/HEIF originals can't render in most browsers, so the route transcodes them to JPEG before storing.
 * (Detected here so the route doesn't ship a raw .heic that would show as a broken <img>.)
 */
export function isHeicImageMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  return base === "image/heic" || base === "image/heif";
}

/**
 * Strip the internal R2 keys from any full property row before it is serialized to a client. Raw keys are
 * storage object names and must never leave the server (only presigned URLs do), so every endpoint that
 * returns a whole `properties` row (`.returning()` / `select()`) redacts them.
 */
export function redactPropertyImageKeys<T extends Partial<PropertyImageKeys>>(
  row: T,
): Omit<T, "imageR2Key" | "imageThumbnailR2Key"> {
  const { imageR2Key: _imageR2Key, imageThumbnailR2Key: _imageThumbnailR2Key, ...rest } = row;
  return rest;
}

/** Lowercase, dot-less, sanitized file extension for the stored object — from the mime first, else name. */
export function resolvePropertyImageExtension(
  originalFilename: string | null | undefined,
  mimeType: string | null | undefined,
): string {
  const base = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (base && MIME_EXTENSIONS[base]) return MIME_EXTENSIONS[base];

  const name = originalFilename ?? "";
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) {
    const ext = name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ext.length > 0 && ext.length <= 5) return ext;
  }
  return "jpg";
}

/**
 * Deterministic-but-unique R2 key for a property's cover photo. The `uniqueSuffix` (a timestamp, injected
 * for testability) makes each replacement a NEW object so a cached CDN/browser copy of the old photo can't
 * shadow the new one, and old-object cleanup targets an exact key.
 */
export function buildPropertyImageR2Key(propertyId: string, extension: string, uniqueSuffix: string | number): string {
  const ext = extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
  return `properties/${propertyId}/cover-${uniqueSuffix}.${ext}`;
}

export interface PropertyImageKeys {
  imageR2Key: string | null;
  imageThumbnailR2Key: string | null;
}

export interface PropertyImageUrls {
  imageUrl: string | null;
  imageThumbnailUrl: string | null;
}

/**
 * Map stored R2 keys to client-facing URLs using an injected presign function (so this is unit-testable
 * without R2). The thumbnail URL falls back to the full-size key when no thumbnail was generated (e.g. the
 * sharp step was skipped), so the avatar still renders — just heavier. Null keys yield null URLs.
 */
export async function buildPropertyImageUrls(
  keys: PropertyImageKeys,
  presign: (r2Key: string) => Promise<string | null>,
): Promise<PropertyImageUrls> {
  const imageUrl = keys.imageR2Key ? await presign(keys.imageR2Key) : null;
  const thumbnailKey = keys.imageThumbnailR2Key ?? keys.imageR2Key;
  const imageThumbnailUrl = thumbnailKey
    ? keys.imageThumbnailR2Key
      ? await presign(keys.imageThumbnailR2Key)
      : imageUrl
    : null;
  return { imageUrl, imageThumbnailUrl };
}

/**
 * Cheap probe so an upload can 404 BEFORE writing to R2. Requires the property to be ACTIVE — a
 * soft-deleted property is read-only (its detail page hides the control), so its cover can't be mutated
 * even via a direct API call / stale deep link.
 */
export async function activePropertyExists(tenantDb: TenantDb, propertyId: string): Promise<boolean> {
  const [row] = await tenantDb
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.isActive, true)))
    .limit(1);
  return Boolean(row);
}

export interface PropertyImageUpdateResult {
  property: typeof properties.$inferSelect;
  /** Keys the property held BEFORE this write, for best-effort R2 cleanup. */
  previousKeys: PropertyImageKeys;
}

/** Point a property at newly-uploaded image keys; returns the updated row + the keys it previously held. */
export async function setPropertyImageKeys(
  tenantDb: TenantDb,
  propertyId: string,
  keys: PropertyImageKeys,
): Promise<PropertyImageUpdateResult | null> {
  // Lock the row (FOR UPDATE) so a concurrent replacement or soft-delete serializes here. Without the lock,
  // `previousKeys` could be read stale — a superseding upload's object would then never be cleaned up — and a
  // soft-delete slipping in after the caller's existence check would be silently overwritten.
  const [existing] = await tenantDb
    .select({
      imageR2Key: properties.imageR2Key,
      imageThumbnailR2Key: properties.imageThumbnailR2Key,
      isActive: properties.isActive,
    })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .for("update")
    .limit(1);
  // Missing OR soft-deleted (read-only) → refuse; the caller deletes any just-uploaded R2 object.
  if (!existing || !existing.isActive) return null;

  const [property] = await tenantDb
    .update(properties)
    .set({
      imageR2Key: keys.imageR2Key,
      imageThumbnailR2Key: keys.imageThumbnailR2Key,
      updatedAt: new Date(),
    })
    .where(eq(properties.id, propertyId))
    .returning();
  if (!property) return null;

  return {
    property,
    previousKeys: { imageR2Key: existing.imageR2Key, imageThumbnailR2Key: existing.imageThumbnailR2Key },
  };
}

/** Clear a property's cover photo; returns the updated row + the keys to delete from R2 (best-effort). */
export async function clearPropertyImageKeys(
  tenantDb: TenantDb,
  propertyId: string,
): Promise<PropertyImageUpdateResult | null> {
  return setPropertyImageKeys(tenantDb, propertyId, { imageR2Key: null, imageThumbnailR2Key: null });
}
