// Device-local persistence for in-progress scorecard drafts (per signed-in user + office). Drafts are
// small JSON; evidence photos are COPIED into a durable per-draft directory on attach (raw camera/library
// uris go stale across app-kill/backgrounding — same reason the upload queue copies files). FileSystem-
// backed, mirroring src/capture/upload-queue.ts.

import * as FileSystem from "expo-file-system/legacy";
// Both from the PURE queue core (createAsyncMutex + sanitizeOwnerKey) — avoids pulling the native
// upload-queue module (camera / keep-awake) into a module whose only native dep is expo-file-system.
import { createAsyncMutex, sanitizeOwnerKey } from "../capture/upload-queue-core";
import { isDurableStoreUri, reconstructDurablePhotoUri } from "../capture/doc-dir-uri";
import type { ScorecardDraft } from "./draft";

const ROOT = `${FileSystem.documentDirectory}scorecard-drafts/`;
const OWNER_REGISTRY_PATH = `${ROOT}owners.json`;

export type ScorecardDraftOwner = {
  ownerKey: string;
  officeId: string | null;
};

export type LocatedScorecardDraft = ScorecardDraftOwner & {
  draft: ScorecardDraft;
};

type StoredDraftOwner = ScorecardDraftOwner & {
  userId: string;
};

// Serialize every index READ-MODIFY-WRITE (autosave upsert + delete) for this process. Both read the whole
// index then write it back; run concurrently (a slow autosave racing the submit-delete, or two autosaves)
// they would clobber each other from stale snapshots. Reads (listScorecardDrafts/loadScorecardDraft) stay
// lock-free — writeIndex is atomic (tmp + move), so a read always sees a whole index, never a torn one.
const withDraftLock = createAsyncMutex();
// Deletion must beat any autosave already queued by an open draft screen.
const discardedDraftIdsByOwner = new Map<string, Set<string>>();
// Autosaves are frequent; after the first durable registration in this process, avoid rereading the
// global owner registry on every keystroke/photo-caption save.
const registeredDraftOwnerKeys = new Set<string>();

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
 * Rebase a draft's NEW-evidence photo uris onto the LIVE per-draft directory. copyPhotoIntoDraft freezes an
 * ABSOLUTE uri (rooted at documentDirectory) into index.json; the iOS container UUID in that path rotates
 * across an app update/reinstall/restore, stranding every baked uri while the file itself moved with the
 * container. Since durable copies are named deterministically (`<photoDir>/<clientUploadId><ext>`), rebuild
 * the current path from the live photoDir + clientUploadId so a resumed draft's photos render + submit
 * again. Retained/presigned evidence (existingScorecardPhotoId, a remote uri) and any non-durable uri are
 * left untouched. Pure-ish: no FS I/O, so read paths stay lock-free.
 */
function rebaseDraftPhotoUris(ownerKey: string, draft: ScorecardDraft): ScorecardDraft {
  const liveDir = photoDir(ownerKey, draft.id);
  let changed = false;
  const photos = draft.photos.map((photo) => {
    // Only NEW evidence lives in the durable per-draft dir; retained evidence uses a refreshed remote uri.
    if (photo.existingScorecardPhotoId || !photo.clientUploadId) return photo;
    if (!isDurableStoreUri(photo.uri, FileSystem.documentDirectory)) return photo;
    const rebased = reconstructDurablePhotoUri(photo.uri, liveDir, photo.clientUploadId);
    if (rebased === photo.uri) return photo;
    changed = true;
    return { ...photo, uri: rebased };
  });
  return changed ? { ...draft, photos } : draft;
}

function parseDraftOwner(ownerKey: string): StoredDraftOwner | null {
  const separator = ownerKey.indexOf(":");
  if (separator <= 0) return null;
  const userId = ownerKey.slice(0, separator);
  const officeId = ownerKey.slice(separator + 1);
  return { userId, ownerKey, officeId: officeId || null };
}

async function readOwnerRegistryFile(file: string): Promise<StoredDraftOwner[] | null> {
  try {
    const info = await FileSystem.getInfoAsync(file);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(file);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((entry): StoredDraftOwner[] => {
      if (!entry || typeof entry !== "object") return [];
      const candidate = entry as Partial<StoredDraftOwner>;
      if (typeof candidate.userId !== "string" || typeof candidate.ownerKey !== "string") return [];
      if (candidate.officeId !== null && typeof candidate.officeId !== "string") return [];
      const normalized = parseDraftOwner(candidate.ownerKey);
      // Never let a corrupt/tampered registry redirect one user's recovery pass into another user's local
      // namespace or bind a queue to a mismatched office header.
      if (!normalized || normalized.userId !== candidate.userId || normalized.officeId !== candidate.officeId) return [];
      return [normalized];
    });
  } catch {
    return null;
  }
}

async function readOwnerRegistry(): Promise<StoredDraftOwner[]> {
  const temp = await readOwnerRegistryFile(`${OWNER_REGISTRY_PATH}.tmp`);
  if (temp !== null) return temp;
  return (await readOwnerRegistryFile(OWNER_REGISTRY_PATH)) ?? [];
}

async function writeOwnerRegistry(owners: StoredDraftOwner[]): Promise<void> {
  await ensureDir(ROOT);
  const tmp = `${OWNER_REGISTRY_PATH}.tmp`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(owners));
  await FileSystem.deleteAsync(OWNER_REGISTRY_PATH, { idempotent: true });
  await FileSystem.moveAsync({ from: tmp, to: OWNER_REGISTRY_PATH });
}

/**
 * Remember every office namespace that has held one of this user's scorecard drafts. This lets the
 * In Progress screen and background uploader recover an edit created from a cross-office scorecard;
 * neither surface can infer that owning office from the currently active office alone.
 *
 * Must be called while holding withDraftLock.
 */
async function registerDraftOwner(ownerKey: string): Promise<void> {
  if (registeredDraftOwnerKeys.has(ownerKey)) return;
  const owner = parseDraftOwner(ownerKey);
  if (!owner) return; // Tests/legacy callers may use a non-production key without the user:office shape.
  const owners = await readOwnerRegistry();
  if (owners.some((entry) => entry.ownerKey === ownerKey)) {
    registeredDraftOwnerKeys.add(ownerKey);
    return;
  }
  await writeOwnerRegistry([...owners, owner]);
  registeredDraftOwnerKeys.add(ownerKey);
}

/** All known scorecard-draft office namespaces for a user, always including the active/fallback one. */
export async function listScorecardDraftOwners(
  userId: string,
  fallbackOwnerKey: string,
): Promise<ScorecardDraftOwner[]> {
  const fallback = parseDraftOwner(fallbackOwnerKey);
  const registered = (await readOwnerRegistry()).filter((entry) => entry.userId === userId);
  const byKey = new Map<string, ScorecardDraftOwner>();
  if (fallback?.userId === userId) {
    byKey.set(fallback.ownerKey, { ownerKey: fallback.ownerKey, officeId: fallback.officeId });
  }
  for (const owner of registered) {
    byKey.set(owner.ownerKey, { ownerKey: owner.ownerKey, officeId: owner.officeId });
  }
  return [...byKey.values()];
}

/** Aggregate local drafts across active and cross-office namespaces, retaining where each draft lives. */
export async function listScorecardDraftsForUser(
  userId: string,
  fallbackOwnerKey: string,
): Promise<LocatedScorecardDraft[]> {
  const owners = await listScorecardDraftOwners(userId, fallbackOwnerKey);
  const batches = await Promise.all(
    owners.map(async (owner) =>
      (await listScorecardDrafts(owner.ownerKey)).map((draft) => ({ ...owner, draft })),
    ),
  );
  // A draft id should have one owner, but prefer the newest copy if an interrupted migration/old build ever
  // left a duplicate so the UI never displays two resumptions of the same logical draft.
  const byId = new Map<string, LocatedScorecardDraft>();
  for (const located of batches.flat()) {
    const current = byId.get(located.draft.id);
    if (!current || located.draft.updatedAt > current.draft.updatedAt) byId.set(located.draft.id, located);
  }
  return [...byId.values()];
}

// Read + parse one index file, or null if missing / partial / unparseable.
async function readDraftIndexFile(file: string): Promise<ScorecardDraft[] | null> {
  try {
    const info = await FileSystem.getInfoAsync(file);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(file);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ScorecardDraft[]) : null;
  } catch {
    return null; // a partial write shouldn't brick the tab
  }
}

export async function listScorecardDrafts(ownerKey: string): Promise<ScorecardDraft[]> {
  const path = indexPath(ownerKey);
  // A leftover .tmp exists ONLY when writeIndex was interrupted after fully writing tmp but before the
  // rename completed — and it holds the NEWEST intended state (written in full before the rename). So
  // prefer a VALID .tmp first (readDraftIndexFile returns null for a partial/corrupt one → fall through),
  // then the live index. Reading the live index first here would return the STALE pre-save copy and the
  // next save would overwrite the newer edit that had already been fully written. Empty only if both fail.
  // Rebase every returned draft's photo uris onto the live document directory so a rotated iOS container
  // path self-heals on resume (covers BOTH the .tmp recovery path and the live index, and loadScorecardDraft
  // which delegates here).
  const temp = await readDraftIndexFile(`${path}.tmp`);
  if (temp !== null) return temp.map((draft) => rebaseDraftPhotoUris(ownerKey, draft));
  const primary = await readDraftIndexFile(path);
  if (primary !== null) return primary.map((draft) => rebaseDraftPhotoUris(ownerKey, draft));
  return [];
}

async function writeIndex(ownerKey: string, drafts: ScorecardDraft[]): Promise<void> {
  await ensureDir(ownerDir(ownerKey));
  const path = indexPath(ownerKey);
  const tmp = `${path}.tmp`;
  // Write to a temp file then move it over the live index, so an interrupted write can't leave a
  // half-written index.json (which would parse-fail and hide EVERY local draft).
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(drafts));
  await FileSystem.deleteAsync(path, { idempotent: true });
  await FileSystem.moveAsync({ from: tmp, to: path });
}

/** Upsert a draft (stamping updatedAt at persist time — the reducer stays pure/time-free). */
export async function saveScorecardDraft(ownerKey: string, draft: ScorecardDraft, now: number): Promise<void> {
  await withDraftLock(async () => {
    if (discardedDraftIds(ownerKey).has(draft.id)) return;
    // Register before the per-owner index write. A stale registry entry is harmless if the later write
    // fails, while an unregistered successful cross-office draft would be invisible to recovery surfaces.
    await registerDraftOwner(ownerKey);
    const drafts = await listScorecardDrafts(ownerKey);
    const stamped = { ...draft, updatedAt: now };
    const idx = drafts.findIndex((d) => d.id === draft.id);
    if (idx >= 0) drafts[idx] = stamped;
    else drafts.push(stamped);
    await writeIndex(ownerKey, drafts);
  });
}

export async function loadScorecardDraft(ownerKey: string, draftId: string): Promise<ScorecardDraft | null> {
  const drafts = await listScorecardDrafts(ownerKey);
  return drafts.find((d) => d.id === draftId) ?? null;
}

export async function deleteScorecardDraft(ownerKey: string, draftId: string): Promise<void> {
  // Set before waiting on the mutex so an already-queued autosave cannot recreate this draft.
  discardedDraftIds(ownerKey).add(draftId);
  try {
    await withDraftLock(async () => {
      const drafts = await listScorecardDrafts(ownerKey);
      await writeIndex(ownerKey, drafts.filter((d) => d.id !== draftId));
      // Clean up the draft's copied photos UNDER THE SAME LOCK so a concurrent saveScorecardDraft can't
      // resurrect the index entry while its photo dir is being deleted.
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
 * Copy a freshly captured/imported photo into the draft's durable directory and return the new uri.
 * Call this ON ATTACH so a long-lived draft never depends on a raw camera/library uri that expires.
 */
export async function copyPhotoIntoDraft(
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
