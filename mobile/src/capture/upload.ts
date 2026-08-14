import * as FileSystem from "expo-file-system/legacy";
import { confirmUpload, createUploadUrl, replacePhotoTags, type Fetcher } from "../api/endpoints";
import type { FieldPhoto } from "../api/types";
import { compressForUpload } from "./compress";
import type { PhotoMetadata } from "./metadata";

export type CaptureTargetRef = { dealId?: string; leadId?: string; opportunityId?: string };

export type CaptureUploadInput = {
  uri: string;
  width?: number;
  height?: number;
  /** Empty object = pending capture (uploaded with no target, assigned later). */
  target: CaptureTargetRef;
  category: string | null;
  caption: string | null;
  tags: string[];
  metadata: PhotoMetadata;
  /**
   * Stable per-photo idempotency key. Sent on confirm-upload so a resumed/background re-run of an upload
   * that already succeeded returns the existing photo instead of creating a duplicate. Required — the
   * upload queue always assigns one.
   */
  clientUploadId: string;
  /**
   * Present only for new evidence added while editing an already-submitted scorecard. The backend uses
   * this immutable record id to resolve the owning office and re-check exact submitter ownership.
   */
  scorecardId?: string;
  /**
   * Queue-only routing hint. Submitted-scorecard edits can outlive the submitter's access to the scorecard's
   * former office, so those targeted uploads must omit a stale x-office-id and let the server resolve the
   * owning office from `scorecardId`. Ordinary/new-draft captures stay office-pinned. This field is persisted
   * in the local queue but is never sent in either upload request body.
   */
  routeByTarget?: boolean;
  /**
   * Set true when the queued `uri` is ALREADY the compressed CRM JPEG (compression moved to enqueue time so
   * the drain is a pure PUT). When true, `sizeBytes` carries the compressed size and uploadCapture skips
   * re-compressing. Absent/false = a legacy or fallback item whose `uri` is the original → the drain
   * compresses it, exactly as before (safe migration of in-flight queue items).
   */
  compressed?: boolean;
  /** Compressed byte size, set alongside `compressed: true` at enqueue (used for the upload-url request). */
  sizeBytes?: number;
};

function onlyDefinedTarget(t: CaptureTargetRef): CaptureTargetRef {
  // Omit empty ids entirely — sending "" would 400/500 (uuid parse) server-side.
  const out: CaptureTargetRef = {};
  if (t.dealId) out.dealId = t.dealId;
  if (t.leadId) out.leadId = t.leadId;
  if (t.opportunityId) out.opportunityId = t.opportunityId;
  return out;
}

/**
 * The full 3-step field upload, mirroring web capture-upload.uploadSessionPhoto:
 *   1. POST /field/photos/upload-url  (metadata: category/caption/tags + size)
 *   2. PUT the compressed bytes straight to R2 (Content-Type only, off-backend)
 *   3. POST /field/photos/confirm-upload (objectKey + uploadToken + GPS/takenAt)
 * Then a best-effort tag re-sync that must never fail the upload.
 */
/** Thrown when a queued upload is cancelled mid-flight (its confirm step is skipped) — see uploadCapture. */
export class UploadCancelledError extends Error {
  constructor(public readonly clientUploadId: string) {
    super(`Upload cancelled: ${clientUploadId}`);
    this.name = "UploadCancelledError";
  }
}

export async function uploadCapture(
  f: Fetcher,
  input: CaptureUploadInput,
  // `shouldConfirm` is consulted right before the confirm step (the ONLY step that links the photo to the
  // deal). If it returns false, the upload is treated as cancelled: confirm is skipped so a photo the user
  // removed mid-upload never surfaces in the gallery — the already-PUT R2 bytes just dangle unconfirmed.
  opts: { shouldConfirm?: () => boolean | Promise<boolean> } = {},
): Promise<FieldPhoto> {
  // Compression normally happens at ENQUEUE now, so a queued item's `uri` is already the compressed JPEG.
  // Never re-encode it (a 2nd 0.92 pass softens detail): trust the stored size, or re-STAT the durable file
  // if the enqueue-time size read missed; only fall back to a real compression pass if we still can't get a
  // size. A legacy/fallback item (compressed not set) is compressed here at drain, as before.
  let compressed: { uri: string; sizeBytes: number; contentType: "image/jpeg" };
  if (input.compressed) {
    let sizeBytes = typeof input.sizeBytes === "number" && input.sizeBytes > 0 ? input.sizeBytes : 0;
    if (sizeBytes <= 0) {
      try {
        const info = await FileSystem.getInfoAsync(input.uri);
        if (info.exists && typeof info.size === "number") sizeBytes = info.size;
      } catch {
        /* re-stat failed → fall through to a compression pass, which returns a usable size */
      }
    }
    compressed =
      sizeBytes > 0
        ? { uri: input.uri, sizeBytes, contentType: "image/jpeg" as const }
        : await compressForUpload(input.uri, input.width, input.height);
  } else {
    compressed = await compressForUpload(input.uri, input.width, input.height);
  }
  const target = onlyDefinedTarget(input.target);
  const scorecardScope = input.scorecardId ? { scorecardId: input.scorecardId } : {};

  const upload = await createUploadUrl(f, {
    ...target,
    ...scorecardScope,
    clientUploadId: input.clientUploadId,
    contentType: compressed.contentType,
    sizeBytes: compressed.sizeBytes,
    category: input.category,
    caption: input.caption,
    tags: input.tags,
  });

  const put = await FileSystem.uploadAsync(upload.uploadUrl, compressed.uri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { "Content-Type": compressed.contentType },
  });
  if (put.status < 200 || put.status >= 300) {
    throw new Error(`Upload to storage failed (R2 returned ${put.status}).`);
  }

  if (opts.shouldConfirm && !(await opts.shouldConfirm())) {
    throw new UploadCancelledError(input.clientUploadId);
  }

  const { photo } = await confirmUpload(f, {
    ...target,
    ...scorecardScope,
    objectKey: upload.objectKey,
    uploadToken: upload.uploadToken,
    clientUploadId: input.clientUploadId,
    latitude: input.metadata.latitude,
    longitude: input.metadata.longitude,
    addressSource: input.metadata.addressSource,
    takenAt: input.metadata.takenAt,
  });

  // Cleanup authorization lives in a server-owned registry, never in user-editable gallery tags. Keep the
  // normal best-effort tag re-sync for every photo, including submitted-scorecard edit evidence.
  if (input.tags.length > 0) {
    try {
      await replacePhotoTags(f, photo.id, input.tags);
    } catch {
      /* tag sync is non-blocking, exactly like the web flow */
    }
  }

  return photo;
}

// Bounded-concurrency worker pool lives in ./concurrency (pure, unit-tested);
// re-exported here so the capture flow imports all its upload helpers from one
// module.
export { runConcurrentUploads } from "./concurrency";
