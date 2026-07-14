// Scorecard submit orchestration: push the draft's evidence photos through the EXISTING durable upload
// queue (so they land in the deal gallery, tagged), then POST the scorecard referencing them by
// clientUploadId. Idempotent server-side on clientSubmissionId, so a retry never duplicates. The draft
// itself is the durability unit — on a photos-pending / failed POST the caller keeps the draft and retries
// (the upload queue keeps retrying the photos in the background).

import { createScorecard, updateScorecard, type Fetcher } from "../api/endpoints";
import type { FieldScorecardSummary } from "../api/types";
import type { CaptureUploadInput } from "../capture/upload";
import { MAX_UPLOAD_ATTEMPTS, drainUploadQueue, enqueueUploads, getQueuedUploads } from "../capture/upload-queue";
import {
  scorecardDraftToSubmission,
  scorecardDraftNewPhotos,
  todayLocalIso,
  type ScorecardDraft,
  type NewScorecardDraftPhoto,
} from "./draft";
import { scorecardDraftToUpdate } from "./edit";

/** Build the field-photo upload input for a scorecard evidence photo — targets the deal and auto-tags. */
export function scorecardPhotoUploadInput(photo: NewScorecardDraftPhoto, dealId: string): CaptureUploadInput {
  return {
    uri: photo.uri,
    width: photo.width,
    height: photo.height,
    target: { dealId },
    category: null,
    caption: photo.caption.trim() ? photo.caption.trim() : null,
    tags: ["scorecard", photo.sectionKey],
    metadata: { takenAt: photo.takenAt, latitude: photo.latitude, longitude: photo.longitude, addressSource: photo.addressSource },
    clientUploadId: photo.clientUploadId,
  };
}

/** Which of the draft's photo clientUploadIds are still sitting in the upload queue (not yet confirmed). */
export function pendingScorecardPhotoIds(draftClientUploadIds: string[], stillQueuedClientUploadIds: string[]): string[] {
  const queued = new Set(stillQueuedClientUploadIds);
  return draftClientUploadIds.filter((id) => queued.has(id));
}

/**
 * Split the draft's still-queued photos into pending (will keep retrying, attempts < max) vs terminally
 * failed (retries exhausted — the queue won't retry, so the submit can never reference them and the user
 * must remove + re-add). Photos not in the queue are confirmed/uploaded.
 */
export function classifyDraftPhotoUploads(
  draftClientUploadIds: string[],
  queued: { clientUploadId: string; attempts: number }[],
  maxAttempts: number,
): { pending: string[]; failed: string[] } {
  const attemptsById = new Map(queued.map((q) => [q.clientUploadId, q.attempts]));
  const pending: string[] = [];
  const failed: string[] = [];
  for (const id of draftClientUploadIds) {
    const attempts = attemptsById.get(id);
    if (attempts === undefined) continue; // uploaded/confirmed (no longer queued)
    if (attempts >= maxAttempts) failed.push(id);
    else pending.push(id);
  }
  return { pending, failed };
}

export type SubmitScorecardResult =
  | { status: "submitted"; scorecard: FieldScorecardSummary }
  | { status: "photos_pending"; remaining: number }
  | { status: "photos_failed"; failed: number };

export type SubmitScorecardOptions = {
  /**
   * New submissions and evidence uploads are scoped to the durable draft/queue office. Keep that
   * office-pinned fetcher separate from `scorecardFetcher`: an edit PUT resolves its owning office by
   * scorecard id server-side, and an old pinned x-office-id can be rejected by field auth after the
   * submitter is re-homed.
   */
  draftOfficeFetcher?: Fetcher;
};

/**
 * Submit a draft. Uploads its photos through the durable queue first; if any of THIS draft's photos are
 * still queued afterward (offline / mid-retry), returns `photos_pending` and the caller keeps the draft so
 * the queue can finish + the user can retry. Once all photos are confirmed, POSTs the scorecard.
 */
export async function submitScorecard(
  scorecardFetcher: Fetcher,
  ownerKey: string,
  draft: ScorecardDraft,
  options: SubmitScorecardOptions = {},
): Promise<SubmitScorecardResult> {
  const draftOfficeFetcher = options.draftOfficeFetcher ?? scorecardFetcher;
  // Retained server evidence on an edit is referenced by scorecard-photo id. Only newly captured/imported
  // evidence owns a clientUploadId and may enter the durable upload queue.
  const newPhotos = scorecardDraftNewPhotos(draft);
  if (newPhotos.length > 0) {
    await enqueueUploads(ownerKey, newPhotos.map((p) => scorecardPhotoUploadInput(p, draft.dealId)));
    await drainUploadQueue(ownerKey, draftOfficeFetcher);
    const stillQueued = await getQueuedUploads(ownerKey);
    const { pending, failed } = classifyDraftPhotoUploads(
      newPhotos.map((p) => p.clientUploadId),
      stillQueued.map((q) => ({ clientUploadId: q.clientUploadId, attempts: q.attempts })),
      MAX_UPLOAD_ATTEMPTS,
    );
    if (failed.length > 0) return { status: "photos_failed", failed: failed.length };
    if (pending.length > 0) return { status: "photos_pending", remaining: pending.length };
  }
  if (draft.editingScorecardId) {
    const { scorecard } = await updateScorecard(scorecardFetcher, draft.editingScorecardId, scorecardDraftToUpdate(draft));
    return { status: "submitted", scorecard };
  }
  // Stamp Week Of = the completion date, LOCAL, at submit time. Both kinds present it as "set automatically
  // when completed" (neither exposes an editable field), so a draft started one day and submitted the next
  // must file under the submit day — not the draft-creation day it was seeded with — and LOCAL avoids the
  // west-of-UTC off-by-one the old server-side UTC stamp caused. The server trusts this value.
  const submission = { ...scorecardDraftToSubmission(draft), weekOf: todayLocalIso() };
  const { scorecard } = await createScorecard(draftOfficeFetcher, submission);
  return { status: "submitted", scorecard };
}
