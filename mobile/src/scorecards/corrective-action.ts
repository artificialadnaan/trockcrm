// Corrective-action per-item response: hold a comment + captured evidence photos for ONE flagged item, then
// submit. Each response photo is uploaded through the SCORECARD-SCOPED corrective-action upload endpoints
// (presign → PUT to R2 → confirm), NOT the generic field-photo upload queue.
//
// WHY the scorecard-scoped endpoints (not the generic `{ target: { dealId } }` queue): the generic
// /field/photos upload route resolves the UPLOADER'S ACTIVE office. For an assigned responder working an
// OFF-office project while cross-office field WRITES are disabled (the default), that lands the file in the
// responder's own tenant — but the response POST (POST /field/scorecards/:id/corrective-actions/:itemId)
// resolves the SCORECARD'S office, so the fileId is absent there and the response is rejected as "not part of
// the project" (and the file is orphaned in the wrong tenant). The scorecard-scoped
// /field/scorecards/:id/corrective-actions/upload{/url} pair resolves the SCORECARD'S office on both steps,
// so the returned fileId always exists in the tenant the response POST reads — cross-office or not. This is
// the SAME contract the web responder uses (client/src/hooks/use-corrective-actions.ts).
//
// WHY fileIds (not clientUploadIds like the scorecard POST): the response endpoint links evidence by real
// file id and strictly validates each belongs to the deal — it does NOT resolve clientUploadIds. Confirm
// returns the fresh { fileId }; we collect those in the ORIGINAL photo order and POST { comment, photoFileIds }.
//
// TRADE-OFF vs the durable upload queue: these uploads are eager (per-submit), not offline-resilient — a
// mid-upload network drop fails the submit (photos_failed / thrown) and the responder retries, exactly as the
// web responder behaves. Routing through the scorecard's office (correctness) takes priority over the queue's
// offline resilience for corrective-action responses; ordinary field-capture photos keep the durable queue.

import * as FileSystem from "expo-file-system/legacy";
import {
  confirmCorrectiveActionUpload,
  requestCorrectiveActionUploadUrl,
  submitCorrectiveActionResponse,
  type Fetcher,
} from "../api/endpoints";
import type { CorrectiveActionItem } from "../api/types";
import { compressForUpload } from "../capture/compress";
import { runConcurrentUploads } from "../capture/concurrency";
import { UPLOAD_CONCURRENCY } from "../capture/upload-queue-core";

/** A captured response-evidence photo, before it's uploaded. `key` == `clientUploadId` (stable + unique). */
export type CorrectiveResponsePhoto = {
  key: string;
  uri: string;
  clientUploadId: string;
  caption: string;
  width?: number;
  height?: number;
  takenAt?: string;
  latitude?: number;
  longitude?: number;
  addressSource?: "exif" | "live_gps";
};

/** The per-item response draft: a free-text comment + its captured evidence photos. */
export type CorrectiveResponseState = {
  comment: string;
  photos: CorrectiveResponsePhoto[];
};

export function emptyCorrectiveResponse(): CorrectiveResponseState {
  return { comment: "", photos: [] };
}

export type CorrectiveResponseAction =
  | { type: "addPhoto"; photo: CorrectiveResponsePhoto }
  | { type: "removePhoto"; key: string }
  | { type: "setPhotoCaption"; key: string; caption: string }
  | { type: "appendPhotoCaption"; key: string; text: string }
  | { type: "setComment"; comment: string }
  | { type: "reset" };

export function correctiveResponseReducer(
  state: CorrectiveResponseState,
  action: CorrectiveResponseAction,
): CorrectiveResponseState {
  switch (action.type) {
    case "addPhoto":
      return { ...state, photos: [...state.photos, action.photo] };
    case "removePhoto":
      return { ...state, photos: state.photos.filter((p) => p.key !== action.key) };
    case "setPhotoCaption":
      return {
        ...state,
        photos: state.photos.map((p) => (p.key === action.key ? { ...p, caption: action.caption } : p)),
      };
    case "appendPhotoCaption":
      return {
        ...state,
        photos: state.photos.map((p) =>
          p.key === action.key
            ? { ...p, caption: p.caption.trim() ? `${p.caption.trim()} ${action.text.trim()}` : action.text.trim() }
            : p,
        ),
      };
    case "setComment":
      return { ...state, comment: action.comment };
    case "reset":
      return emptyCorrectiveResponse();
    default:
      return state;
  }
}

/**
 * Upload ONE corrective-action RESPONSE photo through the SCORECARD-SCOPED endpoints and return its server
 * fileId. presign (office = the scorecard's) → compress to the CRM JPEG → PUT to R2 → confirm (office = the
 * scorecard's) → { fileId }. The file therefore lands in the SCORECARD'S tenant, so the returned id is
 * accepted by the response POST even when the responder's active office differs (off-office project /
 * cross-office writes disabled). Mirrors the web responder's uploadCorrectiveActionPhoto.
 *
 * NOTE: the response endpoint links evidence by fileId and does not carry per-photo tags/GPS/caption on the
 * file itself (unlike the generic gallery upload) — the corrective-action response owns the caption/context.
 */
async function uploadCorrectiveResponsePhoto(
  fetcher: Fetcher,
  scorecardId: string,
  photo: CorrectiveResponsePhoto,
): Promise<string> {
  const compressed = await compressForUpload(photo.uri, photo.width, photo.height);
  const presign = await requestCorrectiveActionUploadUrl(fetcher, scorecardId, {
    contentType: compressed.contentType,
    sizeBytes: compressed.sizeBytes,
  });
  const put = await FileSystem.uploadAsync(presign.uploadUrl, compressed.uri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { "Content-Type": compressed.contentType },
  });
  if (put.status < 200 || put.status >= 300) {
    throw new Error(`Upload to storage failed (R2 returned ${put.status}).`);
  }
  const { fileId } = await confirmCorrectiveActionUpload(fetcher, scorecardId, {
    uploadToken: presign.uploadToken,
    objectKey: presign.objectKey,
  });
  return fileId;
}

export type SubmitCorrectiveActionItemInput = {
  scorecardId: string;
  itemId: string;
  dealId: string;
  photos: CorrectiveResponsePhoto[];
  comment: string;
};

export type SubmitCorrectiveActionItemResult =
  | { status: "resolved"; items: CorrectiveActionItem[] }
  | { status: "photos_pending"; remaining: number }
  | { status: "photos_failed"; failed: number };

/**
 * Upload this item's response photos through the SCORECARD-SCOPED corrective-action upload endpoints (which
 * resolve the SCORECARD'S owning office, NOT the responder's active office), then submit the response with the
 * resulting fileIds. Uploads run CONCURRENTLY (bounded by UPLOAD_CONCURRENCY); their fileIds keep the original
 * photo order. If ANY photo fails to upload we return photos_failed (the caller keeps the captured photos and
 * retries) and DO NOT POST — so a partial upload never submits a response missing evidence.
 *
 * Unlike the durable-queue field-capture path, this is eager (per-submit) and not offline-resilient: routing
 * through the scorecard's office is required for the fileIds to exist in the tenant the response POST reads.
 * (There is no photos_pending here — nothing sits in a background queue; a stuck upload surfaces as failure.)
 */
export async function submitCorrectiveActionItem(
  fetcher: Fetcher,
  input: SubmitCorrectiveActionItemInput,
): Promise<SubmitCorrectiveActionItemResult> {
  const photoFileIds: string[] = [];
  if (input.photos.length > 0) {
    const resolved: string[] = new Array(input.photos.length);
    const settled = await runConcurrentUploads(
      input.photos.map((_, i) => i),
      UPLOAD_CONCURRENCY,
      (i) => uploadCorrectiveResponsePhoto(fetcher, input.scorecardId, input.photos[i]),
    );
    let failedCount = 0;
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") resolved[i] = r.value;
      else failedCount += 1;
    });
    if (failedCount > 0) return { status: "photos_failed", failed: failedCount };
    photoFileIds.push(...resolved);
  }

  const { items } = await submitCorrectiveActionResponse(fetcher, input.scorecardId, input.itemId, {
    comment: input.comment,
    photoFileIds,
  });
  return { status: "resolved", items };
}
