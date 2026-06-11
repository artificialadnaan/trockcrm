import type { PhotoMetadata } from "./metadata";

/**
 * A photo collected in the capture session (from the burst camera or a library
 * import). `caption` is the OPTIONAL per-photo description, set only later in the
 * review tray — capture itself is never blocked by it.
 */
export type SessionPhoto = {
  key: string;
  uri: string;
  width?: number;
  height?: number;
  metadata: PhotoMetadata;
  caption: string;
};

/**
 * Resolve the description a photo uploads with. The per-photo caption wins; the
 * batch caption is the fallback applied to any photo the user didn't caption
 * individually ("individual overrides batch"). Empty on both → null (no caption).
 */
export function effectiveCaption(photoCaption: string, batchCaption: string): string | null {
  const own = photoCaption.trim();
  if (own) return own;
  const batch = batchCaption.trim();
  return batch || null;
}
