import * as FileSystem from "expo-file-system/legacy";
// Pure manifest helpers + createAsyncMutex/sanitizeOwnerKey from the queue core (no native deps) — this
// module's only native dependency is expo-file-system, exactly like the upload queue + scorecard drafts.
import { createAsyncMutex, sanitizeOwnerKey } from "./upload-queue-core";
import { addManifestItem, patchManifestCaption, patchManifestMetadata, removeManifestItems, type StagedDraftItem } from "./review-draft-core";
import type { PhotoMetadata } from "./metadata";
import type { SessionPhoto } from "./session-photo";
import type { DraftCtx } from "./review-draft-core";

export type { StagedDraftItem, DraftCtx } from "./review-draft-core";

/**
 * Durable REVIEW-DRAFT store — a per-owner staging area for photos the crew is captioning in the review
 * step, kept SEPARATE from the upload queue.
 *
 * The old design enqueued staged (uncaptioned) review photos into the shared upload queue as HELD rows,
 * coupling them to the drain / background task / offline-backoff / orphan-recovery machinery — every
 * interaction was an edge (async-copy vs queue race, backoff swallowing the post-release drain, cancel-vs-
 * orphan, …). This store ends that: staged photos are copied into their OWN directory + manifest and do NOT
 * enter the upload queue until the crew taps Done (capture.tsx enqueues them then). A crash mid-review leaves
 * the photos (and captions typed so far) in this durable draft, recovered on the next launch.
 *
 * Mirrors src/capture/upload-queue.ts: files COPIED into a durable dir before use (raw camera/library uris
 * go stale across app-kill), a JSON manifest written crash-safely (tmp + .bak + atomic move), and every
 * read-modify-write serialized under a per-process lock. SCOPED PER OWNER (user + office): items live under
 * `review-draft/<ownerKey>/`, so one account's draft can never surface under the next signer.
 */

const ROOT_DIR = `${FileSystem.documentDirectory ?? ""}review-draft/`;

// Serialize every manifest READ-MODIFY-WRITE (stage-append / caption-patch / remove / clear) for this
// process. Pure READS (loadDraft) stay lock-free — writeManifest is atomic (tmp + move), so a read always
// sees a whole manifest, never a torn one.
const withDraftLock = createAsyncMutex();

function ownerDir(ownerKey: string): string {
  return `${ROOT_DIR}${sanitizeOwnerKey(ownerKey)}/`;
}
function manifestFile(ownerKey: string): string {
  return `${ownerDir(ownerKey)}manifest.json`;
}

async function ensureDir(ownerKey: string): Promise<void> {
  const dir = ownerDir(ownerKey);
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
}

// Read+parse one manifest file, or null if it's missing / truncated / unparseable.
async function readManifestFile(file: string): Promise<StagedDraftItem[] | null> {
  try {
    const info = await FileSystem.getInfoAsync(file);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(file);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StagedDraftItem[]) : null;
  } catch {
    return null;
  }
}

async function readManifest(ownerKey: string): Promise<StagedDraftItem[]> {
  const file = manifestFile(ownerKey);
  // A leftover .tmp exists ONLY when a write was interrupted before its final rename — and it holds the
  // NEWEST intended state (written in full before the rename). So prefer a VALID .tmp first (readManifestFile
  // returns null for a partial/corrupt one → fall through), then the live manifest, then the .bak from the
  // previous successful write. Empty only when ALL are unreadable.
  const temp = await readManifestFile(`${file}.tmp`);
  if (temp !== null) return temp;
  const primary = await readManifestFile(file);
  if (primary !== null) return primary;
  const backup = await readManifestFile(`${file}.bak`);
  return backup ?? [];
}

// Crash-safe manifest write: serialize to a temp file FIRST (so the live manifest is never observed
// half-written), keep the prior manifest as .bak, then atomically rename the temp into place.
async function writeManifest(ownerKey: string, items: StagedDraftItem[]): Promise<void> {
  await ensureDir(ownerKey);
  const file = manifestFile(ownerKey);
  const tmp = `${file}.tmp`;
  const bak = `${file}.bak`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(items));
  const current = await FileSystem.getInfoAsync(file);
  if (current.exists) {
    await FileSystem.deleteAsync(bak, { idempotent: true }).catch(() => undefined);
    await FileSystem.copyAsync({ from: file, to: bak }).catch(() => undefined);
    await FileSystem.deleteAsync(file, { idempotent: true });
  }
  await FileSystem.moveAsync({ from: tmp, to: file });
}

/**
 * Load the staged draft for the owner (crash recovery). Lock-free — the manifest is written atomically.
 * Empty for a missing/unreadable manifest.
 */
export async function loadDraft(ownerKey: string): Promise<StagedDraftItem[]> {
  if (!ownerKey) return [];
  return readManifest(ownerKey);
}

/**
 * Stage ONE photo into the durable draft: COPY its file into the draft dir (so it survives an app kill —
 * the raw camera/library uri does not), then append it to the manifest under the lock. Per-photo, so a
 * copy/write failure is isolated to this photo (the caller catches + keeps the raw uri for Done). Returns
 * the durable item (its `uri` is the copy inside the draft dir).
 */
export async function stageDraftPhoto(ownerKey: string, photo: SessionPhoto, ctx: DraftCtx): Promise<StagedDraftItem> {
  // Refuse an empty owner: sanitizeOwnerKey("") is "anon", but loadDraft/clearDraft always run with the REAL
  // owner, so an anon draft is never recovered or cleared (permanent file leak + a silently-unrecovered photo).
  // Throw — the caller's staging catch keeps the raw uri, so the photo still enqueues from its in-session uri
  // at Done. Mirrors the empty-owner short-circuit on every sibling mutator (only this one WRITES durable state).
  if (!ownerKey) throw new Error("stageDraftPhoto: missing ownerKey");
  await ensureDir(ownerKey);
  const dir = ownerDir(ownerKey);
  const dotExt = photo.uri.includes(".") ? photo.uri.slice(photo.uri.lastIndexOf(".")).split(/[?#]/)[0] : ".jpg";
  const dest = `${dir}${photo.clientUploadId}${dotExt}`;
  await FileSystem.copyAsync({ from: photo.uri, to: dest });
  const item: StagedDraftItem = {
    key: photo.key,
    clientUploadId: photo.clientUploadId,
    uri: dest,
    width: photo.width,
    height: photo.height,
    metadata: photo.metadata,
    caption: photo.caption,
    ctx,
  };
  await withDraftLock(async () => {
    await writeManifest(ownerKey, addManifestItem(await readManifest(ownerKey), item));
  });
  return item;
}

/**
 * Persist the caption onto the manifest item matching `clientUploadId` so a crash preserves captions typed so
 * far. Best-effort + lock-safe; a no-op if the id is gone or the caption is unchanged. Keyed on clientUploadId
 * (globally unique across processes), never the per-process session `key`.
 */
export async function updateDraftCaption(ownerKey: string, clientUploadId: string, caption: string): Promise<void> {
  if (!ownerKey) return;
  await withDraftLock(async () => {
    const { items, changed } = patchManifestCaption(await readManifest(ownerKey), clientUploadId, caption);
    if (changed) await writeManifest(ownerKey, items);
  });
}

/**
 * Merge a late session GPS fix onto the draft item matching `clientUploadId` — a batch shot staged coordless,
 * then geotagged when the camera session's fix resolves, so a crash before Done still recovers it WITH
 * coordinates (the live Done path already reconciles via the session GPS ref). Best-effort + lock-safe; a no-op
 * if the id is gone or the item already has coordinates.
 */
export async function updateDraftMetadata(
  ownerKey: string,
  clientUploadId: string,
  coords: { latitude: number; longitude: number; addressSource?: PhotoMetadata["addressSource"] },
): Promise<void> {
  if (!ownerKey) return;
  await withDraftLock(async () => {
    const { items, changed } = patchManifestMetadata(await readManifest(ownerKey), clientUploadId, coords);
    if (changed) await writeManifest(ownerKey, items);
  });
}

/** Drop the given manifest items (by clientUploadId) AND delete their copied files — the crew removed them from
 * the tray, or Done/recovery consumed them. Identity is clientUploadId, NOT the per-process session `key`: that
 * counter restarts at sp-1 each mount, so a recovered orphan and a fresh photo can collide and a key-scoped
 * delete would wipe the live photo's durable copy too. */
export async function removeDraftPhotos(ownerKey: string, clientUploadIds: string[]): Promise<void> {
  if (!ownerKey || clientUploadIds.length === 0) return;
  const drop = new Set(clientUploadIds);
  await withDraftLock(async () => {
    const current = await readManifest(ownerKey);
    const removed = current.filter((i) => drop.has(i.clientUploadId));
    if (removed.length === 0) return;
    await writeManifest(ownerKey, removeManifestItems(current, clientUploadIds));
    await Promise.all(
      removed.map((i) => FileSystem.deleteAsync(i.uri, { idempotent: true }).catch(() => undefined)),
    );
  });
}

/**
 * Delete the WHOLE draft for the owner — every copied file + the manifest. Called on Done (after the photos
 * are enqueued into the upload queue) and on Cancel (discard). Throws on a real delete failure so Cancel can
 * keep the review open + retry (a stranded draft would otherwise auto-upload on the next recovery).
 */
export async function clearDraft(ownerKey: string): Promise<void> {
  if (!ownerKey) return;
  await withDraftLock(async () => {
    await FileSystem.deleteAsync(ownerDir(ownerKey), { idempotent: true });
  });
}
