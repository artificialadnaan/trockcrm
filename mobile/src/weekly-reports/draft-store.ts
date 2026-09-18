// Device-local persistence for in-progress weekly reports (per signed-in user + office). Drafts are small
// JSON; imported photos are COPIED into a durable per-draft directory on attach, because raw
// camera/library uris go stale across an app kill or a backgrounding.
//
// Structurally this is scorecards/draft-store.ts, and deliberately so — the atomic tmp+move index write,
// the read-modify-write mutex, the discarded-id guard and the #938 photo-uri rebase are each there
// because of a defect that shipped, and a second store that skipped any of them would reproduce it. The
// rebase in particular reuses the SAME pure helpers (capture/doc-dir-uri) rather than a copy of the logic.
//
// What is NOT carried over is the cross-office owner registry. A scorecard can be opened for editing from
// a cross-office submitted list, so that store has to remember which office namespace each draft lives in.
// Weekly reports have no such path: the field routes run under tenantMiddleware, which pins every read and
// write to the user's ACTIVE office, so a draft only ever belongs to the office it was started in.

import * as FileSystem from "expo-file-system/legacy";
// Both from the PURE queue core — avoids pulling the native upload-queue module (camera / keep-awake)
// into a module whose only native dependency is expo-file-system.
import { createAsyncMutex, sanitizeOwnerKey } from "../capture/upload-queue-core";
import { isDurableStoreUri, reconstructDurablePhotoUri } from "../capture/doc-dir-uri";
import type { WeeklyReportDraft } from "./draft";

const ROOT = `${FileSystem.documentDirectory}weekly-report-drafts/`;

// Serialize every index READ-MODIFY-WRITE (autosave upsert + delete) for this process. Both read the whole
// index then write it back; run concurrently — a slow autosave racing the submit-delete, or two autosaves —
// they would clobber each other from stale snapshots. Reads stay lock-free: writeIndex is atomic (tmp +
// move), so a read always sees a whole index, never a torn one.
const withDraftLock = createAsyncMutex();
// Deletion must beat any autosave already queued by an open wizard screen.
const discardedDraftIdsByOwner = new Map<string, Set<string>>();

function discardedDraftIds(ownerKey: string): Set<string> {
  let ids = discardedDraftIdsByOwner.get(ownerKey);
  if (!ids) {
    ids = new Set();
    discardedDraftIdsByOwner.set(ownerKey, ids);
  }
  return ids;
}

function ownerDir(ownerKey: string): string {
  return `${ROOT}${sanitizeOwnerKey(ownerKey)}/`;
}
function indexPath(ownerKey: string): string {
  return `${ownerDir(ownerKey)}index.json`;
}
function photoDir(ownerKey: string, draftId: string): string {
  return `${ownerDir(ownerKey)}${draftId}/`;
}

async function ensureDir(dir: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
}

/**
 * Rebase an imported photo's `localUri` onto the LIVE per-draft directory (#938).
 *
 * copyPhotoIntoWeeklyDraft freezes an ABSOLUTE uri (rooted at documentDirectory) into index.json. The iOS
 * container UUID in that path rotates across an app update / reinstall / device restore, stranding every
 * baked uri while the file itself moved with the container — so a resumed draft renders blank photos and
 * its re-upload rejects with an opaque error. Because durable copies are named deterministically
 * (`<photoDir>/<clientUploadId><ext>`), the current path can be rebuilt from the live photoDir + the id.
 *
 * Gallery photos are untouched: they carry no clientUploadId and their preview is a remote presigned url,
 * which is refreshed from the server on load rather than rebased.
 *
 * Pure-ish — no FS I/O — so read paths stay lock-free.
 */
function rebaseDraftPhotoUris(ownerKey: string, draft: WeeklyReportDraft): WeeklyReportDraft {
  const liveDir = photoDir(ownerKey, draft.id);
  let changed = false;
  const photos = draft.photos.map((photo) => {
    if (!photo.clientUploadId || !photo.localUri) return photo;
    if (!isDurableStoreUri(photo.localUri, FileSystem.documentDirectory)) return photo;
    const rebased = reconstructDurablePhotoUri(photo.localUri, liveDir, photo.clientUploadId);
    if (rebased === photo.localUri) return photo;
    changed = true;
    return { ...photo, localUri: rebased };
  });
  return changed ? { ...draft, photos } : draft;
}

// Read + parse one index file, or null if missing / partial / unparseable.
async function readDraftIndexFile(file: string): Promise<WeeklyReportDraft[] | null> {
  try {
    const info = await FileSystem.getInfoAsync(file);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(file);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WeeklyReportDraft[]) : null;
  } catch {
    return null; // a partial write must not brick the tab
  }
}

export async function listWeeklyReportDrafts(ownerKey: string): Promise<WeeklyReportDraft[]> {
  const path = indexPath(ownerKey);
  // A leftover .tmp exists ONLY when writeIndex was interrupted after fully writing tmp but before the
  // rename completed — and it holds the NEWEST intended state. So prefer a VALID .tmp first (a partial one
  // parse-fails and falls through), then the live index. Reading the live index first would return the
  // STALE pre-save copy and the next save would overwrite the newer edit already written in full.
  const temp = await readDraftIndexFile(`${path}.tmp`);
  const drafts = temp !== null ? temp : ((await readDraftIndexFile(path)) ?? []);
  return drafts.map((draft) => rebaseDraftPhotoUris(ownerKey, draft));
}

async function writeIndex(ownerKey: string, drafts: WeeklyReportDraft[]): Promise<void> {
  await ensureDir(ownerDir(ownerKey));
  const path = indexPath(ownerKey);
  const tmp = `${path}.tmp`;
  // Write to a temp file then move it over the live index, so an interrupted write cannot leave a
  // half-written index.json — which would parse-fail and hide EVERY local draft.
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(drafts));
  await FileSystem.deleteAsync(path, { idempotent: true });
  await FileSystem.moveAsync({ from: tmp, to: path });
}

/** Upsert a draft, stamping updatedAt at persist time so the reducer stays pure and time-free. */
export async function saveWeeklyReportDraft(
  ownerKey: string,
  draft: WeeklyReportDraft,
  now: number,
): Promise<void> {
  await withDraftLock(async () => {
    if (discardedDraftIds(ownerKey).has(draft.id)) return;
    const drafts = await listWeeklyReportDrafts(ownerKey);
    const stamped = { ...draft, updatedAt: now };
    const index = drafts.findIndex((d) => d.id === draft.id);
    if (index >= 0) drafts[index] = stamped;
    else drafts.push(stamped);
    await writeIndex(ownerKey, drafts);
  });
}

export async function loadWeeklyReportDraft(
  ownerKey: string,
  draftId: string,
): Promise<WeeklyReportDraft | null> {
  const drafts = await listWeeklyReportDrafts(ownerKey);
  return drafts.find((d) => d.id === draftId) ?? null;
}

export async function deleteWeeklyReportDraft(ownerKey: string, draftId: string): Promise<void> {
  // Set BEFORE waiting on the mutex so an already-queued autosave cannot recreate this draft.
  discardedDraftIds(ownerKey).add(draftId);
  try {
    await withDraftLock(async () => {
      const drafts = await listWeeklyReportDrafts(ownerKey);
      await writeIndex(
        ownerKey,
        drafts.filter((d) => d.id !== draftId),
      );
      // Reclaim the copied photos UNDER THE SAME LOCK, so a concurrent save cannot resurrect the index
      // entry while its photo directory is being deleted.
      try {
        await FileSystem.deleteAsync(photoDir(ownerKey, draftId), { idempotent: true });
      } catch {
        /* best-effort */
      }
    });
  } catch (error) {
    discardedDraftIds(ownerKey).delete(draftId);
    throw error;
  }
}

/**
 * Copy a freshly imported photo into the draft's durable directory and return the new uri.
 *
 * Called ON ATTACH, before the upload starts, so a draft that outlives the app process never depends on a
 * library uri that has since expired. The deterministic `<clientUploadId><ext>` filename is what makes the
 * container rebase above possible.
 */
export async function copyPhotoIntoWeeklyDraft(
  ownerKey: string,
  draftId: string,
  clientUploadId: string,
  srcUri: string,
): Promise<string> {
  const dir = photoDir(ownerKey, draftId);
  await ensureDir(dir);
  const dotExt = srcUri.includes(".") ? srcUri.slice(srcUri.lastIndexOf(".")).split(/[?#]/)[0] : ".jpg";
  const dest = `${dir}${clientUploadId}${dotExt}`;
  await FileSystem.copyAsync({ from: srcUri, to: dest });
  return dest;
}

/** Delete one durable copy (best-effort, never throws). Use when a photo is removed from an open draft. */
export async function deleteWeeklyDraftPhotoFile(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    /* best-effort */
  }
}
