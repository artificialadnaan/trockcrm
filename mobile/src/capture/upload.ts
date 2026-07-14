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
   * Queue-only routing hint. Submitted-scorecard edits can outlive the submitter's access to the scorecard's
   * former office, so those targeted uploads must omit a stale x-office-id and let the server resolve the
   * owning office from `target`. Ordinary/new-draft captures stay office-pinned. This field is persisted in
   * the local queue but is never sent in either upload request body.
   */
  routeByTarget?: boolean;
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
  const compressed = await compressForUpload(input.uri, input.width, input.height);
  const target = onlyDefinedTarget(input.target);

  const upload = await createUploadUrl(f, {
    ...target,
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
    objectKey: upload.objectKey,
    uploadToken: upload.uploadToken,
    clientUploadId: input.clientUploadId,
    latitude: input.metadata.latitude,
    longitude: input.metadata.longitude,
    addressSource: input.metadata.addressSource,
    takenAt: input.metadata.takenAt,
  });

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
