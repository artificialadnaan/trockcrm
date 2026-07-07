// Pure manifest logic for the review-draft store — NO native imports (only type-only imports of
// PhotoMetadata / CaptureTargetRef, erased at runtime), so it is unit-testable in isolation. The native I/O
// (file copy, manifest read/write under a lock) lives in ./review-draft and composes these.
//
// The review-draft store is a DURABLE staging area for photos the crew is captioning in the review step,
// kept SEPARATE from the upload queue: staged photos are copied into their own directory + manifest and do
// NOT enter the upload queue until the crew taps Done. This decouples review-staging from the drain /
// background-task / offline-backoff / orphan-recovery machinery, ending the cascade of held-row edge cases.
import type { PhotoMetadata } from "./metadata";
import type { CaptureTargetRef } from "./upload";

/** The capture-time destination snapshot each staged photo carries, so Done/recovery enqueues to the
 * project the photo was captured for (never a project selected later). */
export type DraftCtx = { target: CaptureTargetRef; category: string | null; tags: string[] };

/** One photo staged into the durable review draft (its file already COPIED into the draft dir). */
export type StagedDraftItem = {
  /** Session key (stable within a review session) — the manifest key used to patch/remove an item. */
  key: string;
  /** Stable idempotency key carried into enqueue → confirm-upload (server dedupes on it). */
  clientUploadId: string;
  /** The DURABLE copy's uri (inside the draft dir) — survives an app kill, unlike the raw camera/library uri. */
  uri: string;
  width?: number;
  height?: number;
  metadata: PhotoMetadata;
  /** The optional per-photo caption typed so far (persisted so a crash preserves it). */
  caption: string;
  ctx: DraftCtx;
};

/**
 * Append a staged item to the manifest, ignoring one whose clientUploadId is already present (idempotent —
 * a re-stage of the same photo must not duplicate it). Returns a new array; the input is never mutated.
 */
export function addManifestItem(items: StagedDraftItem[], item: StagedDraftItem): StagedDraftItem[] {
  if (items.some((i) => i.clientUploadId === item.clientUploadId)) return items;
  return [...items, item];
}

/** Drop the items whose `key` is in `keys`, keeping the rest in order. */
export function removeManifestItems(items: StagedDraftItem[], keys: Iterable<string>): StagedDraftItem[] {
  const drop = new Set(keys);
  return items.filter((i) => !drop.has(i.key));
}

/**
 * Set the caption on the item matching `key` (so a crash preserves captions typed so far). Reports whether
 * anything changed so the caller only rewrites the durable manifest when it did; a no-op (key absent, or
 * caption unchanged) returns the original array reference unchanged.
 */
export function patchManifestCaption(
  items: StagedDraftItem[],
  key: string,
  caption: string,
): { items: StagedDraftItem[]; changed: boolean } {
  let changed = false;
  const next = items.map((i) => {
    if (i.key !== key || i.caption === caption) return i;
    changed = true;
    return { ...i, caption };
  });
  return { items: changed ? next : items, changed };
}
