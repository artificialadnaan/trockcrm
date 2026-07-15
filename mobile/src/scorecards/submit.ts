// Scorecard submit orchestration: push the draft's evidence photos through the EXISTING durable upload
// queue (so they land in the deal gallery, tagged), then POST the scorecard referencing them by
// clientUploadId. Idempotent server-side on clientSubmissionId, so a retry never duplicates. The draft
// itself is the durability unit — on a photos-pending / failed POST the caller keeps the draft and retries
// (the upload queue keeps retrying the photos in the background).

import { createScorecard, discardScorecardEditEvidence, updateScorecard, type Fetcher } from "../api/endpoints";
import type { FieldScorecardSummary } from "../api/types";
import type { CaptureUploadInput } from "../capture/upload";
import {
  MAX_UPLOAD_ATTEMPTS,
  drainUploadQueue,
  enqueueUploads,
  getQueuedUploads,
  removeQueuedUploadsAndWait,
} from "../capture/upload-queue";
import {
  scorecardDraftToSubmission,
  scorecardDraftEvidenceCleanupIds,
  scorecardDraftNewPhotos,
  todayLocalIso,
  type ScorecardDraft,
  type NewScorecardDraftPhoto,
} from "./draft";
import { scorecardDraftToUpdate } from "./edit";

/** Build the field-photo upload input for a scorecard evidence photo — targets the deal and auto-tags. */
export function scorecardPhotoUploadInput(
  photo: NewScorecardDraftPhoto,
  dealId: string,
  editingScorecardId?: string,
): CaptureUploadInput {
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
    ...(editingScorecardId ? { scorecardId: editingScorecardId, routeByTarget: true } : {}),
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
   * Default queue/new-submission fetcher, scoped to the durable draft office. Submitted-edit evidence is
   * marked with its scorecard id and uses `scorecardFetcher` for the server's owner-authorized scorecard
   * office resolver; an old pinned x-office-id can be rejected after re-homing. New/offline drafts stay pinned.
   */
  draftOfficeFetcher?: Fetcher;
};

/** PUT committed, but abandoned-upload reconciliation has not completed; retain the draft and retry. */
export class ScorecardEditCleanupPendingError extends Error {
  constructor(public readonly scorecard: FieldScorecardSummary, options?: { cause?: unknown }) {
    super("Scorecard changes were saved, but evidence cleanup is still pending.", options);
    this.name = "ScorecardEditCleanupPendingError";
  }
}

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
  const editCleanupIds = draft.editingScorecardId ? scorecardDraftEvidenceCleanupIds(draft) : [];
  if (draft.editingScorecardId && editCleanupIds.length > 0) {
    // The append-only attempt ledger also contains photos still selected in the form. Cancel only the ids
    // the edit no longer references. A removed upload may already be inside a worker's confirm request, so
    // wait for that worker before the PUT and server reconciliation; otherwise its late confirm could land
    // after cleanup and leave hidden edit evidence orphaned in the gallery.
    const selectedNewPhotoIds = new Set(newPhotos.map((photo) => photo.clientUploadId));
    const removedAttemptedIds = editCleanupIds.filter((id) => !selectedNewPhotoIds.has(id));
    if (removedAttemptedIds.length > 0) {
      await removeQueuedUploadsAndWait(ownerKey, removedAttemptedIds);
    }
  }
  if (newPhotos.length > 0) {
    const editingScorecardId = draft.editingScorecardId;
    await enqueueUploads(
      ownerKey,
      newPhotos.map((p) => scorecardPhotoUploadInput(p, draft.dealId, editingScorecardId)),
    );
    await drainUploadQueue(
      ownerKey,
      draftOfficeFetcher,
      editingScorecardId ? { targetFetcher: scorecardFetcher } : undefined,
    );
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
    // The append-only ledger may contain an earlier upload the user removed before this successful PUT.
    // Reconcile every attempted id before reporting success: rows linked by the PUT are terminal-safe,
    // while confirmed-but-unselected rows are hidden and not left as orphaned gallery evidence. A cleanup
    // failure intentionally rejects this submit so the screen retains the draft; retry replays the
    // idempotent PUT and then retries cleanup before local finalization/navigation.
    if (editCleanupIds.length > 0) {
      try {
        await discardScorecardEditEvidence(scorecardFetcher, draft.editingScorecardId, editCleanupIds);
      } catch (error) {
        throw new ScorecardEditCleanupPendingError(scorecard, { cause: error });
      }
    }
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
