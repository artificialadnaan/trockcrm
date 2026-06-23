export interface PhotoUrlSource {
  r2Key?: string | null;
  mimeType?: string | null;
  fileExtension?: string | null;
  displayName?: string | null;
  externalUrl?: string | null;
  externalThumbnailUrl?: string | null;
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
  // For grid/thumbnail previews, prefer a small external thumbnail (e.g. CompanyCam's 250px CDN thumb)
  // over presigning + downloading the full-size R2 original — it's vastly lighter (~15KB vs ~500KB) and
  // needs no per-photo round-trip. The full-resolution R2 image is still served for the lightbox/open
  // path (getImmediatePhotoOpenUrl), which is unchanged.
  if (photo.externalThumbnailUrl) return photo.externalThumbnailUrl;
  if (hasR2PhotoSource(photo)) return signedUrl ?? null;
  return photo.externalUrl ?? signedUrl ?? null;
}

export function getImmediatePhotoOpenUrl(
  photo: PhotoUrlSource,
  signedUrl: string | null | undefined = null
): string | null {
  if (!isPhotoImagePreviewable(photo)) return null;
  if (hasR2PhotoSource(photo)) return signedUrl ?? null;
  return photo.externalUrl ?? photo.externalThumbnailUrl ?? signedUrl ?? null;
}

export function shouldFetchSignedPhotoUrl(
  photo: PhotoUrlSource,
  signedUrl: string | null | undefined = null
): boolean {
  if (signedUrl) return false;
  if (!isPhotoImagePreviewable(photo)) return false;
  // A small external thumbnail is served directly for previews (see getImmediatePhotoPreviewUrl), so
  // there's no need to presign the full-size R2 original.
  if (photo.externalThumbnailUrl) return false;
  return hasR2PhotoSource(photo) || !photo.externalUrl;
}
