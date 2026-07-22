import * as MediaLibrary from "expo-media-library";
import { getSaveToCameraRoll } from "../settings/camera-roll-setting";

/**
 * Save the ORIGINAL full-res photo to the device camera roll as a backup — gated by the "save to camera roll"
 * setting and write-only (add-only) permission. BEST-EFFORT: never throws to the caller, so a failed backup
 * (permission denied, disk full, etc.) can never break capture or the CRM upload. Called fire-and-forget from
 * the capture hook with the untouched camera original, so the backup keeps full resolution + EXIF/GPS while
 * the CRM still receives the compressed copy.
 */
export async function saveOriginalToCameraRoll(uri: string): Promise<void> {
  try {
    if (!(await getSaveToCameraRoll())) return;
    // Write-only / add-only: we only ADD photos and never read the library, so request the least-privilege
    // permission. Already-granted/denied returns without re-prompting.
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) return;
    await MediaLibrary.saveToLibraryAsync(uri);
  } catch (err) {
    // Redacted diagnostic ONLY — never log the uri / EXIF / image metadata. Capture + the CRM upload proceed
    // regardless (best-effort backup).
    console.warn(`[camera-roll] backup save failed: ${err instanceof Error ? err.name : "unknown"}`);
  }
}
