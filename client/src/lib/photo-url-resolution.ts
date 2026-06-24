export interface PhotoUrlSource {
  r2Key?: string | null;
  mimeType?: string | null;
  fileExtension?: string | null;
  displayName?: string | null;
  externalUrl?: string | null;
  externalThumbnailUrl?: string | null;
  /**
   * Server-resolved display URLs (from the photo list). When present they're used directly, so the
   * client NEVER fetches a signed URL per photo — that N+1 is what trips the rate limiter on a big deal.
   * `thumbnailUrl` = grid; `fullUrl` = high-res for the zoomable viewer.
   */
  thumbnailUrl?: string | null;
  fullUrl?: string | null;
}

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".webp"]);

export function hasR2PhotoSource(photo: PhotoUrlSource): boolean {
  return Boolean(photo.r2Key);
}

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

export function isPhotoImagePreviewable(photo: PhotoUrlSource): boolean {
  const mimeType = photo.mimeType?.trim().toLowerCase();
  if (mimeType) return mimeType.startsWith("image/");

  const explicitExtension = normalizeExplicitExtension(photo.fileExtension);
  if (explicitExtension) return IMAGE_EXTENSIONS.has(explicitExtension);

  const inferredExtension = firstKnownExtension(photo.r2Key, photo.externalThumbnailUrl, photo.externalUrl, photo.displayName);
  if (inferredExtension) return IMAGE_EXTENSIONS.has(inferredExtension);

  return true;
}

export function getImmediatePhotoPreviewUrl(
  photo: PhotoUrlSource,
  signedUrl: string | null | undefined = null
): string | null {
  if (!isPhotoImagePreviewable(photo)) return null;
  // A freshly-fetched signed URL wins — it's only set after the batched one failed/expired (refresh path).
  if (signedUrl) return signedUrl;
  // Otherwise the server-resolved thumbnail — no per-photo round-trip.
  if (photo.thumbnailUrl) return photo.thumbnailUrl;
  if (hasR2PhotoSource(photo)) return null;
  return photo.externalThumbnailUrl ?? photo.externalUrl ?? null;
}

export function getImmediatePhotoOpenUrl(
  photo: PhotoUrlSource,
  signedUrl: string | null | undefined = null
): string | null {
  if (!isPhotoImagePreviewable(photo)) return null;
  if (signedUrl) return signedUrl;
  // Server-resolved full-res (high-res for the zoomable viewer) — no per-photo round-trip.
  if (photo.fullUrl) return photo.fullUrl;
  if (hasR2PhotoSource(photo)) return null;
  return photo.externalUrl ?? photo.externalThumbnailUrl ?? null;
}

export function shouldFetchSignedPhotoUrl(
  photo: PhotoUrlSource,
  signedUrl: string | null | undefined = null
): boolean {
  if (signedUrl) return false;
  // The server now resolves URLs in-batch in the photo list — if it gave us either, never round-trip.
  if (photo.thumbnailUrl || photo.fullUrl) return false;
  if (!isPhotoImagePreviewable(photo)) return false;
  return hasR2PhotoSource(photo) || (!photo.externalThumbnailUrl && !photo.externalUrl);
}
