export interface PhotoUrlSource {
  r2Key?: string | null;
  externalUrl?: string | null;
  externalThumbnailUrl?: string | null;
}

export function hasR2PhotoSource(photo: PhotoUrlSource): boolean {
  return Boolean(photo.r2Key);
}

export function getImmediatePhotoPreviewUrl(
  photo: PhotoUrlSource,
  signedUrl: string | null | undefined = null
): string | null {
  if (hasR2PhotoSource(photo)) return signedUrl ?? null;
  return photo.externalThumbnailUrl ?? photo.externalUrl ?? signedUrl ?? null;
}

export function getImmediatePhotoOpenUrl(
  photo: PhotoUrlSource,
  signedUrl: string | null | undefined = null
): string | null {
  if (hasR2PhotoSource(photo)) return signedUrl ?? null;
  return photo.externalUrl ?? photo.externalThumbnailUrl ?? signedUrl ?? null;
}

export function shouldFetchSignedPhotoUrl(
  photo: PhotoUrlSource,
  signedUrl: string | null | undefined = null
): boolean {
  if (signedUrl) return false;
  return hasR2PhotoSource(photo) || (!photo.externalThumbnailUrl && !photo.externalUrl);
}
