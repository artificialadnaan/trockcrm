// Corrective-action per-item response: hold a comment + captured evidence photos for ONE flagged item, then
// submit. The submit mirrors scorecard submit.ts's durable-upload orchestration (enqueueUploads →
// drainUploadQueue → getQueuedUploads → classifyDraftPhotoUploads for pending/failed classification), then
// collects each confirmed photo's server fileId and POSTs { comment, photoFileIds } to Plan 2's endpoint.
//
// WHY fileIds (not clientUploadIds like the scorecard POST): the corrective-action response endpoint links
// evidence by real file id and strictly validates each belongs to the deal — it does NOT resolve
// clientUploadIds. The durable queue drain already presigned + PUT + confirmed every photo, and now SURFACES
// each confirmed server file id (keyed by clientUploadId) in its summary — so we read the ids straight from
// the drain, with NO second upload. Only if a photo isn't in this drain's map (e.g. it was already confirmed
// by an earlier offline drain and has since left the queue) do we fall back to an idempotent uploadCapture
// (server dedupes on clientUploadId → the EXISTING file + its id, never a duplicate); those fallbacks run
// CONCURRENTLY. Output ids stay in the original photo order.

import { submitCorrectiveActionResponse, type Fetcher } from "../api/endpoints";
import type { CorrectiveActionItem } from "../api/types";
import type { CaptureUploadInput } from "../capture/upload";
import { runConcurrentUploads, uploadCapture } from "../capture/upload";
import {
  MAX_UPLOAD_ATTEMPTS,
  UPLOAD_CONCURRENCY,
  drainUploadQueue,
  enqueueUploads,
  getQueuedUploads,
} from "../capture/upload-queue";
import { classifyDraftPhotoUploads } from "./submit";

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
 * Build the field-photo upload input for a corrective-action RESPONSE photo — targets the deal (so it lands
 * in the gallery + gets a real file id) and tags it as corrective-action evidence. Mirrors
 * scorecardPhotoUploadInput but with the corrective_action tag (NOT a section key).
 */
export function correctiveResponsePhotoUploadInput(
  photo: CorrectiveResponsePhoto,
  dealId: string,
): CaptureUploadInput {
  return {
    uri: photo.uri,
    width: photo.width,
    height: photo.height,
    target: { dealId },
    category: null,
    caption: photo.caption.trim() ? photo.caption.trim() : null,
    tags: ["scorecard", "corrective_action"],
    metadata: {
      takenAt: photo.takenAt,
      latitude: photo.latitude,
      longitude: photo.longitude,
      addressSource: photo.addressSource,
    },
    clientUploadId: photo.clientUploadId,
  };
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
 * Upload this item's response photos through the durable queue, then submit the response. If any of the
 * photos are still queued after the drain (offline / mid-retry) we return photos_pending (keeps retrying) or
 * photos_failed (retries exhausted), exactly like submitScorecard — the caller keeps the captured photos and
 * retries. Once all are confirmed, we resolve each photo's server fileId and POST { comment, photoFileIds }.
 */
export async function submitCorrectiveActionItem(
  fetcher: Fetcher,
  ownerKey: string,
  input: SubmitCorrectiveActionItemInput,
): Promise<SubmitCorrectiveActionItemResult> {
  const photoFileIds: string[] = [];
  if (input.photos.length > 0) {
    const uploadInputs = input.photos.map((p) => correctiveResponsePhotoUploadInput(p, input.dealId));
    await enqueueUploads(ownerKey, uploadInputs);
    const drain = await drainUploadQueue(ownerKey, fetcher);
    const stillQueued = await getQueuedUploads(ownerKey);
    const { pending, failed } = classifyDraftPhotoUploads(
      input.photos.map((p) => p.clientUploadId),
      stillQueued.map((q) => ({ clientUploadId: q.clientUploadId, attempts: q.attempts })),
      MAX_UPLOAD_ATTEMPTS,
    );
    if (failed.length > 0) return { status: "photos_failed", failed: failed.length };
    if (pending.length > 0) return { status: "photos_pending", remaining: pending.length };

    // Every photo is confirmed in the deal gallery. Prefer the file id the drain just confirmed (no second
    // upload). A photo missing from the drain map was confirmed by an EARLIER drain (already gone from the
    // queue), so re-confirm those — CONCURRENTLY — with an idempotent uploadCapture (server dedupes on
    // clientUploadId → the existing file, no duplicate). Indices align 1:1 with input.photos so the resulting
    // fileIds keep the original photo order.
    const resolved: string[] = new Array(input.photos.length);
    const fallbackIndices: number[] = [];
    input.photos.forEach((p, i) => {
      const fileId = drain.confirmedFileIds[p.clientUploadId];
      if (fileId) resolved[i] = fileId;
      else fallbackIndices.push(i);
    });
    if (fallbackIndices.length > 0) {
      const settled = await runConcurrentUploads(
        fallbackIndices,
        UPLOAD_CONCURRENCY,
        (i) => uploadCapture(fetcher, uploadInputs[i]),
      );
      settled.forEach((r, k) => {
        const i = fallbackIndices[k];
        if (r.status === "fulfilled") resolved[i] = r.value.id;
        else throw r.reason instanceof Error ? r.reason : new Error(String(r.reason));
      });
    }
    photoFileIds.push(...resolved);
  }

  const { items } = await submitCorrectiveActionResponse(fetcher, input.scorecardId, input.itemId, {
    comment: input.comment,
    photoFileIds,
  });
  return { status: "resolved", items };
}
