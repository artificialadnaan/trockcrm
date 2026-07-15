import { eq } from "drizzle-orm";
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
 * A cover photo may be any raster `image/*` EXCEPT SVG — an SVG can carry active content, and we render the
 * result inline in an <img>. Mirrors the inline-render allowlist used elsewhere for uploaded images.
 */
export function isAcceptablePropertyImageMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  if (base === "image/svg+xml") return false;
  return base.startsWith("image/");
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

/** Cheap existence probe so an upload can 404 BEFORE writing an object to R2 for a non-existent property. */
export async function propertyExists(tenantDb: TenantDb, propertyId: string): Promise<boolean> {
  const [row] = await tenantDb
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.id, propertyId))
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
  const [existing] = await tenantDb
    .select({ imageR2Key: properties.imageR2Key, imageThumbnailR2Key: properties.imageThumbnailR2Key })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .limit(1);
  if (!existing) return null;

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
