// Batch import of gallery photos onto a weekly-report draft.
//
// Lifted out of the wizard screen because the ORDER of its three phases is the whole of its correctness,
// and order is only assertable in a test that can hold a promise open — which the screen, with a native
// picker and a real uploader in front of it, is not.
//
// THE ORDER, and why it is what it is. A picked asset is a `ph://` (or `content://`) reference the OS is
// free to invalidate, so an asset that has not been COPIED into the draft's own directory does not exist
// as far as a resumed draft is concerned. The previous shape awaited a live-GPS fix (up to 8s indoors) for
// the whole batch and then copied+uploaded one asset at a time, so a user who picked twelve photos and
// then locked their phone kept only however many had made it through the serialised network round trips.
// Every asset the picker returned had been chosen; none of them were recorded anywhere until its turn
// came, and the retry path — which works off photos already on the draft — could not recover what had
// never been attached.
//
// So: persist the entire batch first, and only then do the slow things.

import {
  extractExifMetadata,
  hasPhotoCoords,
  mergeLiveGpsIntoExif,
  type PhotoMetadata,
} from "../capture/metadata";
import type { WeeklyReportDraftPhoto } from "./draft";

/** The part of an expo-image-picker asset this module needs. */
export interface WeeklyReportImportAsset {
  uri: string;
  width?: number;
  height?: number;
  exif?: Record<string, unknown> | null;
}

export interface WeeklyReportImportUpload {
  uri: string;
  width?: number;
  height?: number;
  metadata: PhotoMetadata;
  clientUploadId: string;
}

/**
 * Everything with a side effect, injected — the module owns the sequencing and nothing else.
 *
 * `getLiveGps` must resolve rather than reject; a location failure is not an import failure (the photo is
 * uploaded without coordinates, exactly as a coordless EXIF one is).
 */
export interface WeeklyReportImportDeps {
  newClientUploadId(): string;
  /** Durable per-draft copy. Its resolved uri is what is rendered, retried and eventually uploaded. */
  copyIntoDraft(clientUploadId: string, srcUri: string): Promise<string>;
  addPhoto(photo: WeeklyReportDraftPhoto): void;
  getLiveGps(): Promise<PhotoMetadata | null>;
  upload(input: WeeklyReportImportUpload): Promise<{ fileId: string; remoteUrl: string | null }>;
  resolveUpload(clientUploadId: string, fileId: string, remoteUrl: string | null): void;
}

export interface WeeklyReportImportOutcome {
  /** Copied into the draft and attached — these survive a kill and are retryable. */
  persisted: number;
  /** Never made it onto the draft. The only genuinely lost photos, and the user has to re-pick them. */
  failedToPersist: number;
  /** On the draft with no `files` row yet. `weeklyReportDraftBlocker` holds submit until they land. */
  failedToUpload: number;
}

export async function importWeeklyReportPhotoBatch(
  assets: WeeklyReportImportAsset[],
  deps: WeeklyReportImportDeps,
): Promise<WeeklyReportImportOutcome> {
  // PHASE 1 — copy and attach EVERY picked asset. Nothing here touches the network, so the window in
  // which a pick can evaporate is a few local file copies rather than the length of the whole batch.
  const entries: Array<{
    clientUploadId: string;
    localUri: string;
    exif: PhotoMetadata;
    width?: number;
    height?: number;
  }> = [];
  let failedToPersist = 0;

  for (const asset of assets) {
    const clientUploadId = deps.newClientUploadId();
    const exif = extractExifMetadata(asset.exif);
    try {
      const localUri = await deps.copyIntoDraft(clientUploadId, asset.uri);
      deps.addPhoto({
        key: clientUploadId,
        fileId: null,
        caption: "",
        originalDescription: null,
        remoteUrl: null,
        localUri,
        clientUploadId,
        // The photo's OWN capture time. A live fix always stamps `takenAt: now`, and a photo restamped to
        // today falls outside the 14-day window a late report's picker filters on.
        takenAt: exif.takenAt ?? null,
        width: asset.width,
        height: asset.height,
        // EXIF only, because the live fix does not exist yet at this point and waiting for it is the bug
        // this ordering fixes. The authoritative provenance is the one sent with the upload below; these
        // fields are the draft's local record and are discarded with it on submit.
        latitude: exif.latitude,
        longitude: exif.longitude,
        addressSource: exif.addressSource,
      });
      entries.push({ clientUploadId, localUri, exif, width: asset.width, height: asset.height });
    } catch {
      failedToPersist += 1;
    }
  }

  if (entries.length === 0) {
    return { persisted: 0, failedToPersist, failedToUpload: 0 };
  }

  // PHASE 2 — ONE live fix for the whole batch, and only if some shot actually needs it. Per asset this
  // would serialise an up-to-8s lookup for every coordless photo and freeze a large indoor import.
  const live = entries.some((entry) => !hasPhotoCoords(entry.exif)) ? await deps.getLiveGps() : null;

  // PHASE 3 — upload what is already safely on the draft, one at a time so a jobsite connection is not
  // asked to carry a dozen concurrent PUTs. A failure here leaves the photo attached with no fileId,
  // which blocks submit and is honest: the user's pick is still on their phone.
  let failedToUpload = 0;
  for (const entry of entries) {
    try {
      const uploaded = await deps.upload({
        uri: entry.localUri,
        width: entry.width,
        height: entry.height,
        // Location only — never the live fix's `takenAt`, for the reason given above.
        metadata: mergeLiveGpsIntoExif(entry.exif, live),
        clientUploadId: entry.clientUploadId,
      });
      deps.resolveUpload(entry.clientUploadId, uploaded.fileId, uploaded.remoteUrl);
    } catch {
      failedToUpload += 1;
    }
  }

  return { persisted: entries.length, failedToPersist, failedToUpload };
}

/**
 * What to tell the user after a batch, or null when everything landed.
 *
 * The two failures are not the same event and must not read as one: a photo that never reached the draft
 * is gone and has to be picked again, while one that failed to upload is still sitting in the report
 * waiting for signal. Merging them into "N photos failed" would send someone back to their gallery to
 * re-import photos they can already see on the screen in front of them.
 */
export function weeklyReportImportNotice(outcome: WeeklyReportImportOutcome): string | null {
  const parts: string[] = [];
  if (outcome.failedToPersist > 0) {
    const n = outcome.failedToPersist;
    parts.push(`${n} photo${n === 1 ? "" : "s"} couldn’t be added — pick ${n === 1 ? "it" : "them"} again.`);
  }
  if (outcome.failedToUpload > 0) {
    const n = outcome.failedToUpload;
    parts.push(
      `${n} photo${n === 1 ? "" : "s"} couldn’t upload. Remove ${n === 1 ? "it" : "them"} or try again with a better signal.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}
