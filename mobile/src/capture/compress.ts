import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";

/**
 * Normalizes captures/gallery imports to JPEG (HEIC/HEIF → JPEG) so the uploaded
 * Content-Type is always image/jpeg, matching confirm-upload, and caps the longest
 * edge so we don't ship raw 48MP sensor frames over field cellular.
 *
 * The cap is the native 12MP long edge (4032) with near-lossless quality (0.92): a
 * detail-dense shot like a printed design board stays readable when zoomed in the
 * CRM viewer. (The web upload path stores the original uncompressed — this is the
 * field/bandwidth-constrained sibling, not a byte-for-byte mirror of it.) The grid
 * loads a small server-generated thumbnail, so this resolution only costs on the
 * full-size open view, not the timeline.
 */
export type CompressedImage = { uri: string; sizeBytes: number; contentType: "image/jpeg" };

const MAX_DIMENSION = 4032;
const QUALITY = 0.92;

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

export type EnqueueSource = {
  /** The file to persist into the durable queue: the compressed JPEG, or the original on fallback. */
  sourceUri: string;
  /** Byte size of the compressed JPEG (undefined on fallback — the drain re-derives it). */
  sizeBytes?: number;
  /** True when sourceUri is the already-compressed JPEG, so the drain must NOT compress again. */
  compressed: boolean;
};

/**
 * Compress a capture to the CRM 4032/0.92 JPEG at ENQUEUE time (not at drain), returning the file to persist
 * in the durable queue. This moves the per-photo compression off the upload path — the drain becomes a pure
 * network PUT — and shrinks the on-disk queue to the compressed bytes.
 *
 * BEST-EFFORT: if compression fails, fall back to the ORIGINAL uri with `compressed: false`, so the drain
 * compresses it exactly as before. No capture is ever dropped because compression failed.
 */
export async function compressForEnqueue(
  uri: string,
  width?: number,
  height?: number,
): Promise<EnqueueSource> {
  try {
    const c = await compressForUpload(uri, width, height);
    // Only take the pre-compressed fast path with a USABLE size. compressForUpload leaves sizeBytes=0 when the
    // best-effort getInfoAsync misses; freezing a 0 into the durable item would make the drain PUT sizeBytes:0,
    // which the server rejects (<= 0) on every retry → terminal. Instead keep the compressed bytes but mark
    // compressed:false so the drain re-derives the real size (re-compressing the already-small JPEG is cheap),
    // preserving the self-heal main had.
    if (c.sizeBytes > 0) return { sourceUri: c.uri, sizeBytes: c.sizeBytes, compressed: true };
    return { sourceUri: c.uri, compressed: false };
  } catch {
    return { sourceUri: uri, compressed: false };
  }
}
