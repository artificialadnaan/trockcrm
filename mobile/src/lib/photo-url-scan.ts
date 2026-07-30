/**
 * ONE shared walk of a project's photo list, re-minting presigned URLs for everybody who needs one.
 *
 * The viewer snapshots the photo list at open time and those URLs carry a fixed TTL, so a gallery left
 * open hands the pager links that now 403. When the TTL lapses it does not lapse for one photo — every
 * mounted cell fails in the same frame. That is what makes the coordination worth having: N cells each
 * walking up to `maxPages` independently multiplies the walk by the render window.
 *
 * Two things have to be true at once, and the first version only got the first:
 *
 *   1. Concurrent callers must not each start a walk. (Deduplication.)
 *   2. One walk must not stop before the LAST caller's photo. (Sharing.)
 *
 * Stopping at the leader's target satisfies 1 and fails 2: a joiner further down the list receives the
 * walk's prefix and nothing else, so it starts its own walk from page 1. With a sparse category/tag
 * filter, adjacent viewer cells can originate from pages 47-50 — they expire together, and four
 * sequential prefix walks cost 47+48+49+50 = 194 requests to recover four photos that share the tail of
 * one list.
 *
 * So the running walk owns a SET of targets rather than a single id, and re-reads it after every page:
 * the set can grow while a request is in flight, and a caller that arrives mid-walk is precisely the one
 * the loop must keep going for. It stops at the page the last outstanding target appears on, which for
 * the ordinary case — everyone on one page — is still page one.
 *
 * Extracted from PhotoViewerModal so this can be tested. Nothing in CI compiles or runs `mobile/`, so
 * logic that only exists inside a component is logic nothing ever checks.
 */

export type PhotoPage = {
  photos: Array<{ id: string; fullImageUrl?: string | null; imageUrl?: string | null }>;
  pagination?: { totalPages?: number | null } | null;
};

export type ScanDeps = {
  /** One page of the project's photos. Rejects on network/auth failure. */
  fetchPage: (page: number) => Promise<PhotoPage>;
  /** Hard bound on the walk, so a huge project cannot spin forever. */
  maxPages: number;
};

/**
 * A coalescing scanner. One instance per viewer; `resolve` is what callers use.
 *
 * Deliberately a closure over two refs rather than a class: the component already holds it in a `useRef`,
 * and the only state that matters is "is a walk running, and who is it for".
 */
export function createUrlScanner(deps: ScanDeps) {
  let running: Promise<Map<string, string>> | null = null;
  let targets = new Set<string>();

  /**
   * Join the running walk, or start one. Returns everything harvested, not just the caller's photo —
   * adjacent cells share pages, so the map a joiner receives usually already answers it.
   */
  function scan(photoId: string): Promise<Map<string, string>> {
    // Registered BEFORE the running check, so a caller arriving mid-walk is picked up by the in-flight
    // loop's next re-read rather than having to start a second walk.
    targets.add(photoId);
    if (running) return running;

    const mine = targets;
    const walk = (async () => {
      const harvested = new Map<string, string>();
      for (let page = 1; page <= deps.maxPages; page += 1) {
        let res: PhotoPage;
        try {
          res = await deps.fetchPage(page);
        } catch {
          break; // network/auth error — return what we have; callers fall back to an error state
        }
        for (const p of res.photos) {
          const url = p.fullImageUrl ?? p.imageUrl;
          if (url) harvested.set(p.id, url);
        }
        // Re-read every page: `mine` can have grown during the await above.
        let outstanding = false;
        for (const id of mine) {
          if (!harvested.has(id)) {
            outstanding = true;
            break;
          }
        }
        if (!outstanding) break;
        const totalPages = res.pagination?.totalPages ?? 1;
        if (page >= totalPages) break; // no more pages to scan
      }
      return harvested;
    })();

    running = walk;
    // Cleared on settle so a LATER expiry can start a fresh walk. The set is REPLACED rather than
    // emptied, so the finished walk's closure keeps reading the set it was actually walking for.
    void walk.finally(() => {
      if (running === walk) {
        running = null;
        targets = new Set();
      }
    });
    return walk;
  }

  /**
   * One photo's fresh URL. Null when it cannot be resolved.
   *
   * The retry is narrow on purpose. A walk that OWED us an answer and did not produce one has genuinely
   * finished looking — it reached the last page, hit the bound, or the network failed — and re-walking
   * would re-request every page for a photo it already established is unreachable. The single case worth
   * a second attempt is the race the target set cannot close: registering after the loop's final re-read
   * but before `finally` cleared the walk, so the scan that answered everyone else never knew about us.
   * That retry becomes the next leader with its own set, and later callers coalesce onto it — which is
   * why it cannot cascade into a walk per caller the way stopping at one target did.
   */
  async function resolve(photoId: string): Promise<string | null> {
    const joined = running !== null;
    const harvested = await scan(photoId);
    const found = harvested.get(photoId);
    if (found) return found;
    if (!joined) return null;
    const retry = await scan(photoId);
    return retry.get(photoId) ?? null;
  }

  return { scan, resolve };
}
