// Device-local persistence for in-progress scorecard drafts (per signed-in user + office). Drafts are
// small JSON; evidence photos are COPIED into a durable per-draft directory on attach (raw camera/library
// uris go stale across app-kill/backgrounding — same reason the upload queue copies files). FileSystem-
// backed, mirroring src/capture/upload-queue.ts.

import * as FileSystem from "expo-file-system/legacy";
import { sanitizeOwnerKey } from "../capture/upload-queue";
import type { ScorecardDraft } from "./draft";

const ROOT = `${FileSystem.documentDirectory}scorecard-drafts/`;

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
  const temp = await readDraftIndexFile(`${path}.tmp`);
  if (temp !== null) return temp;
  const primary = await readDraftIndexFile(path);
  if (primary !== null) return primary;
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
  const drafts = await listScorecardDrafts(ownerKey);
  const stamped = { ...draft, updatedAt: now };
  const idx = drafts.findIndex((d) => d.id === draft.id);
  if (idx >= 0) drafts[idx] = stamped;
  else drafts.push(stamped);
  await writeIndex(ownerKey, drafts);
}

export async function loadScorecardDraft(ownerKey: string, draftId: string): Promise<ScorecardDraft | null> {
  const drafts = await listScorecardDrafts(ownerKey);
  return drafts.find((d) => d.id === draftId) ?? null;
}

export async function deleteScorecardDraft(ownerKey: string, draftId: string): Promise<void> {
  const drafts = await listScorecardDrafts(ownerKey);
  await writeIndex(ownerKey, drafts.filter((d) => d.id !== draftId));
  // Best-effort cleanup of the draft's copied photos.
  try {
    await FileSystem.deleteAsync(photoDir(ownerKey, draftId), { idempotent: true });
  } catch {
    /* ignore */
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
