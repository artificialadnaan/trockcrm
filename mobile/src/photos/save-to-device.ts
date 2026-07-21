import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";

/**
 * Download a REMOTE photo (the viewer serves a presigned URL) and save it to the device's photo library. This
 * is an EXPLICIT user action (a Save button), so — unlike the capture-time camera-roll backup — it is NOT gated
 * on the auto-save setting. Add-only (write) permission is requested (least privilege: we only ADD, never read
 * the library). Best-effort + self-cleaning: the transient download is always removed.
 */
export type SavePhotoResult = "saved" | "permission_denied" | "failed";

/** File extension (incl. the dot) from a URL, query/fragment stripped; defaults to .jpg. */
function extFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0];
  const dot = path.lastIndexOf(".");
  if (dot < 0) return ".jpg";
  const ext = path.slice(dot);
  // Guard against a dot in a path segment with no real extension (e.g. ".../v1.2/photo").
  return /^\.[a-zA-Z0-9]{1,5}$/.test(ext) ? ext : ".jpg";
}

export async function savePhotoToDevice(remoteUrl: string): Promise<SavePhotoResult> {
  if (!remoteUrl) return "failed";
  let tempUri: string | null = null;
  try {
    // Add-only permission — we only ADD the downloaded photo, never read the library. Already-granted returns
    // without a re-prompt.
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) return "permission_denied";

    const dest = `${FileSystem.cacheDirectory}trockcam-download-${Date.now()}${extFromUrl(remoteUrl)}`;
    const result = await FileSystem.downloadAsync(remoteUrl, dest);
    tempUri = result.uri;
    if (result.status < 200 || result.status >= 300) return "failed";

    await MediaLibrary.saveToLibraryAsync(result.uri);
    return "saved";
  } catch (err) {
    // Redacted diagnostic only — never log the URL (it's a presigned, credential-bearing link).
    console.warn(`[save-to-device] save failed: ${err instanceof Error ? err.name : "unknown"}`);
    return "failed";
  } finally {
    if (tempUri) await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => undefined);
  }
}
