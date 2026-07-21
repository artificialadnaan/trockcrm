// Pure URI-rebasing logic shared by the three durable device-local stores (upload queue, review draft,
// scorecard drafts). NO native imports — the caller passes in the LIVE directory + the deterministic layout
// pieces, so this stays unit-testable in isolation.
//
// WHY THIS EXISTS: every durable store COPIES a photo into a directory rooted at
// `FileSystem.documentDirectory` and freezes that ABSOLUTE uri into its JSON index/manifest. On iOS the
// document directory carries a per-install container UUID (…/<UUID>/Documents/…) that is NOT stable across
// an app UPDATE / reinstall / device restore-migration. When it rotates, the store's own index/manifest
// path is recomputed from the live directory (so the JSON still loads), but every `uri` string baked into
// that JSON still embeds the OLD container path. The file itself moved with the container, so the old uri
// now points at nothing → the photo renders blank AND a submit's `FileSystem.copyAsync({from: oldUri})`
// rejects, bricking the whole submit with an opaque error. Rebasing the stored uri onto the live document
// directory at READ time lets a container move self-heal.

/** The `/Documents/` path segment an iOS documentDirectory-rooted uri contains. */
const DOCUMENTS_SEGMENT = "/Documents/";

/** The file extension (incl. the leading dot) of a uri, or "" if none — mirrors how the stores derive the
 * durable filename's ext at copy time (last dot, query/fragment stripped). */
function uriExtension(uri: string): string {
  const dot = uri.lastIndexOf(".");
  if (dot < 0) return "";
  return uri.slice(dot).split(/[?#]/)[0];
}

/**
 * True when `uri` looks like a path under a documentDirectory-rooted durable store (ours or a stale
 * container's), NOT a remote presigned uri or a raw camera/library cache uri. Used to decide whether a
 * stored uri is even a candidate for rebasing.
 *
 * A durable-store uri is a local `file://` path that either sits under the LIVE document directory already,
 * or under some OTHER `…/Documents/…` container (the stale-UUID case we want to heal). Remote http(s) uris,
 * `ph://` asset uris, and `…/Caches/…` or `…/tmp/…` cache uris fail this test and are left untouched.
 */
export function isDurableStoreUri(uri: string, liveDocDir: string | null | undefined): boolean {
  if (!uri) return false;
  if (liveDocDir && uri.startsWith(liveDocDir)) return true;
  return uri.startsWith("file://") && uri.includes(DOCUMENTS_SEGMENT);
}

/**
 * Rebase a stored, documentDirectory-rooted uri onto the LIVE document directory so a rotated iOS container
 * UUID self-heals. The relative tail (everything from `Documents/` onward — our `scorecard-drafts/…`,
 * `upload-queue/…`, `review-draft/…` layout) is preserved verbatim, including the `.tmp` recovery suffix.
 *
 * ROBUST BY DESIGN — returns the uri UNCHANGED when it is not a documentDirectory-rooted local path
 * (remote presigned evidence, raw camera/library cache uris, legacy/test uris), or when either side lacks a
 * `/Documents/` segment to splice on. So it only ever moves a uri that genuinely lived under the app's
 * document directory.
 */
export function rebaseDocumentDirectoryUri(storedUri: string, liveDocDir: string | null | undefined): string {
  if (!storedUri || !liveDocDir) return storedUri;
  // Already rooted at the live directory → nothing to do (the common, container-unchanged case).
  if (storedUri.startsWith(liveDocDir)) return storedUri;
  const storedTailIdx = storedUri.indexOf(DOCUMENTS_SEGMENT);
  const liveTailIdx = liveDocDir.indexOf(DOCUMENTS_SEGMENT);
  if (storedTailIdx < 0 || liveTailIdx < 0) return storedUri;
  const relativeTail = storedUri.slice(storedTailIdx + DOCUMENTS_SEGMENT.length);
  const liveRoot = liveDocDir.slice(0, liveTailIdx + DOCUMENTS_SEGMENT.length);
  return `${liveRoot}${relativeTail}`;
}

/**
 * Reconstruct a durable photo's absolute uri from the LIVE store layout + its clientUploadId, self-healing a
 * stale container path deterministically. Because every store names its durable copy
 * `${liveDir}${clientUploadId}${ext}`, the live directory + id + the stored uri's extension fully determine
 * the current path — independent of the `/Documents/` literal, so it heals even when the doc dir shape
 * differs from iOS's.
 *
 * Applied ONLY when the stored uri is a durable-store uri (`isDurableStoreUri`); a remote presigned or raw
 * cache uri is returned unchanged so retained evidence / in-session captures are never rewritten.
 *
 * @param storedUri the uri frozen in the index/manifest (source of the file extension)
 * @param liveDir   the LIVE per-owner (+ per-draft) directory the copy lives in, ending in a trailing slash
 * @param clientUploadId the deterministic filename stem
 */
export function reconstructDurablePhotoUri(
  storedUri: string,
  liveDir: string,
  clientUploadId: string | null | undefined,
): string {
  // Without a deterministic filename stem there is nothing to rebuild from — return the uri unchanged rather
  // than synthesize a `${liveDir}undefined${ext}` path. (Durable items always carry a clientUploadId; this is
  // defense-in-depth so a caller that doesn't pre-filter can't corrupt a uri.)
  if (!clientUploadId) return storedUri;
  return `${liveDir}${clientUploadId}${uriExtension(storedUri)}`;
}
