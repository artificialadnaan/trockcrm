import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";

/**
 * Mirror of the web compress pipeline (browser-image-compression: JPEG, longest
 * edge ≤ 2048, quality 0.85). Also normalizes HEIC/HEIF gallery imports to JPEG
 * so the uploaded Content-Type is always image/jpeg, matching confirm-upload.
 */
export type CompressedImage = { uri: string; sizeBytes: number; contentType: "image/jpeg" };

const MAX_DIMENSION = 2048;
const QUALITY = 0.85;

export async function compressForUpload(
  uri: string,
  width?: number,
  height?: number,
): Promise<CompressedImage> {
  const actions: ImageManipulator.Action[] = [];
  const longest = Math.max(width ?? 0, height ?? 0);
  if (longest > MAX_DIMENSION) {
    // Resize by the longer edge; the other dimension scales to preserve ratio.
    actions.push(
      (width ?? 0) >= (height ?? 0)
        ? { resize: { width: MAX_DIMENSION } }
        : { resize: { height: MAX_DIMENSION } },
    );
  }

  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: QUALITY,
    format: ImageManipulator.SaveFormat.JPEG,
  });

  let sizeBytes = 0;
  try {
    const info = await FileSystem.getInfoAsync(result.uri);
    if (info.exists && typeof info.size === "number") sizeBytes = info.size;
  } catch {
    /* size is best-effort; the server re-derives the real size from the object */
  }

  return { uri: result.uri, sizeBytes, contentType: "image/jpeg" };
}
