// Scorecard submit orchestration: push the draft's evidence photos through the EXISTING durable upload
// queue (so they land in the deal gallery, tagged), then POST the scorecard referencing them by
// clientUploadId. Idempotent server-side on clientSubmissionId, so a retry never duplicates. The draft
// itself is the durability unit — on a photos-pending / failed POST the caller keeps the draft and retries
// (the upload queue keeps retrying the photos in the background).

import { createScorecard, type Fetcher } from "../api/endpoints";
import type { FieldScorecardSummary } from "../api/types";
import type { CaptureUploadInput } from "../capture/upload";
import { drainUploadQueue, enqueueUploads, getQueuedUploads } from "../capture/upload-queue";
import {
  scorecardDraftToSubmission,
  type ScorecardDraft,
  type ScorecardDraftPhoto,
} from "./draft";

/** Build the field-photo upload input for a scorecard evidence photo — targets the deal and auto-tags. */
export function scorecardPhotoUploadInput(photo: ScorecardDraftPhoto, dealId: string): CaptureUploadInput {
  return {
    uri: photo.uri,
    target: { dealId },
    category: null,
    caption: photo.caption.trim() ? photo.caption.trim() : null,
    tags: ["scorecard", photo.sectionKey],
    metadata: { takenAt: photo.takenAt, latitude: photo.latitude, longitude: photo.longitude },
    clientUploadId: photo.clientUploadId,
  };
}

/** Which of the draft's photo clientUploadIds are still sitting in the upload queue (not yet confirmed). */
export function pendingScorecardPhotoIds(draftClientUploadIds: string[], stillQueuedClientUploadIds: string[]): string[] {
  const queued = new Set(stillQueuedClientUploadIds);
  return draftClientUploadIds.filter((id) => queued.has(id));
}

export type SubmitScorecardResult =
  | { status: "submitted"; scorecard: FieldScorecardSummary }
  | { status: "photos_pending"; remaining: number };

/**
 * Submit a draft. Uploads its photos through the durable queue first; if any of THIS draft's photos are
 * still queued afterward (offline / mid-retry), returns `photos_pending` and the caller keeps the draft so
 * the queue can finish + the user can retry. Once all photos are confirmed, POSTs the scorecard.
 */
export async function submitScorecard(
  fetcher: Fetcher,
  ownerKey: string,
  draft: ScorecardDraft,
): Promise<SubmitScorecardResult> {
  if (draft.photos.length > 0) {
    await enqueueUploads(ownerKey, draft.photos.map((p) => scorecardPhotoUploadInput(p, draft.dealId)));
    await drainUploadQueue(ownerKey, fetcher);
    const stillQueued = await getQueuedUploads(ownerKey);
    const mine = pendingScorecardPhotoIds(
      draft.photos.map((p) => p.clientUploadId),
      stillQueued.map((q) => q.clientUploadId),
    );
    if (mine.length > 0) return { status: "photos_pending", remaining: mine.length };
  }
  const { scorecard } = await createScorecard(fetcher, scorecardDraftToSubmission(draft));
  return { status: "submitted", scorecard };
}
