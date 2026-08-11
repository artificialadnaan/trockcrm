import { createUrlScanner, type PhotoPage } from "../lib/photo-url-scan";

/**
 * A fake project list. `pages[i]` is page i+1; each entry is the photo ids that page yields.
 *
 * Every fetch is recorded, because the whole point of the coalescing is REQUEST COUNT — an assertion
 * that the right URL came back would pass just as happily on the version that walked the list four
 * times.
 */
function makeList(pages: string[][]) {
  const requested: number[] = [];
  let deferred: Array<() => void> = [];
  const fetchPage = (page: number): Promise<PhotoPage> => {
    requested.push(page);
    const photos = (pages[page - 1] ?? []).map((id) => ({ id, fullImageUrl: `fresh:${id}` }));
    const body: PhotoPage = { photos, pagination: { totalPages: pages.length } };
    // Resolved on demand, so a test can hold a page open and let another caller join mid-walk.
    return new Promise((res) => deferred.push(() => res(body)));
  };
  /** Let every page request issued so far complete, then yield to the microtask queue. */
  const flush = async (rounds = 1) => {
    for (let i = 0; i < rounds; i += 1) {
      const pending = deferred;
      deferred = [];
      pending.forEach((r) => r());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { fetchPage, requested, flush };
}

describe("one shared walk for a whole window of expired photos", () => {
  it("resolves a photo on the first page in one request", async () => {
    const list = makeList([["a", "b"], ["c"]]);
    const scanner = createUrlScanner({ fetchPage: list.fetchPage, maxPages: 50 });
    const p = scanner.resolve("a");
    await list.flush(3);
    expect(await p).toBe("fresh:a");
    expect(list.requested).toEqual([1]);
  });

  it("does NOT stop at the first caller's photo when a later one has joined", async () => {
    // The defect. With targets on pages 1 and 3, stopping at the leader's target left the joiner to
    // walk pages 1-3 all over again. One walk must cover both.
    const list = makeList([["a"], ["b"], ["c"]]);
    const scanner = createUrlScanner({ fetchPage: list.fetchPage, maxPages: 50 });
    const first = scanner.resolve("a");
    const second = scanner.resolve("c");
    await list.flush(5);
    expect(await first).toBe("fresh:a");
    expect(await second).toBe("fresh:c");
    // Pages 1, 2, 3 — once each. Not 1, then 1-2-3 again.
    expect(list.requested).toEqual([1, 2, 3]);
  });

  it("costs pages-to-the-last-target, not pages-per-caller", async () => {
    // The 194-request scenario, scaled down. Four adjacent cells from the tail of a sparse list expire
    // together; four prefix walks would be 1..2 + 1..3 + 1..4 + 1..5 = 14 requests for a 5-page list.
    const list = makeList([["a"], ["b"], ["c"], ["d"], ["e"]]);
    const scanner = createUrlScanner({ fetchPage: list.fetchPage, maxPages: 50 });
    const all = [
      scanner.resolve("b"),
      scanner.resolve("c"),
      scanner.resolve("d"),
      scanner.resolve("e"),
    ];
    await list.flush(8);
    expect(await Promise.all(all)).toEqual(["fresh:b", "fresh:c", "fresh:d", "fresh:e"]);
    expect(list.requested).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps walking for a caller that arrives while a page is in flight", async () => {
    // The set has to be RE-READ each page, not captured once. A joiner registering during page 1's
    // request is exactly the caller the loop must keep going for.
    const list = makeList([["a"], ["b"]]);
    const scanner = createUrlScanner({ fetchPage: list.fetchPage, maxPages: 50 });
    const first = scanner.resolve("a");
    const late = scanner.resolve("b"); // joins before page 1 resolves
    await list.flush(5);
    expect(await first).toBe("fresh:a");
    expect(await late).toBe("fresh:b");
    expect(list.requested).toEqual([1, 2]);
  });

  it("stops at the last page rather than walking to the bound", async () => {
    const list = makeList([["a"], ["b"]]);
    const scanner = createUrlScanner({ fetchPage: list.fetchPage, maxPages: 50 });
    const missing = scanner.resolve("not-in-this-project");
    await list.flush(6);
    expect(await missing).toBeNull();
    expect(list.requested).toEqual([1, 2]);
  });

  it("does not re-walk for a photo the list genuinely does not contain", async () => {
    // A scan aimed at OUR id that finished without finding it has established the photo is unreachable.
    // Re-walking would re-request every page to learn the same thing.
    const list = makeList([["a"], ["b"], ["c"]]);
    const scanner = createUrlScanner({ fetchPage: list.fetchPage, maxPages: 50 });
    const missing = scanner.resolve("ghost");
    await list.flush(8);
    expect(await missing).toBeNull();
    expect(list.requested).toEqual([1, 2, 3]);
  });

  it("respects the page bound on a project longer than the walk", async () => {
    const list = makeList([["a"], ["b"], ["c"], ["d"]]);
    const scanner = createUrlScanner({ fetchPage: list.fetchPage, maxPages: 2 });
    const missing = scanner.resolve("d");
    await list.flush(6);
    expect(await missing).toBeNull();
    expect(list.requested).toEqual([1, 2]);
  });

  it("gives up on a network failure instead of retrying every page", async () => {
    const requested: number[] = [];
    const scanner = createUrlScanner({
      fetchPage: async (page) => {
        requested.push(page);
        throw new Error("offline");
      },
      maxPages: 50,
    });
    expect(await scanner.resolve("a")).toBeNull();
    expect(requested).toEqual([1]);
  });

  it("starts a fresh walk for an expiry that happens after the first one settled", async () => {
    // The scan is cleared on settle. A later TTL lapse is a new event and must not be answered from a
    // completed walk's map.
    const list = makeList([["a", "b"]]);
    const scanner = createUrlScanner({ fetchPage: list.fetchPage, maxPages: 50 });
    const first = scanner.resolve("a");
    await list.flush(3);
    expect(await first).toBe("fresh:a");
    const later = scanner.resolve("b");
    await list.flush(3);
    expect(await later).toBe("fresh:b");
    expect(list.requested).toEqual([1, 1]);
  });

  it("harvests every photo on a page, not only the ones asked for", async () => {
    // This is what makes a joiner cheap: the map it receives usually already answers it, because the
    // cells that expire together are adjacent and share pages.
    const list = makeList([["a", "b", "c"]]);
    const scanner = createUrlScanner({ fetchPage: list.fetchPage, maxPages: 50 });
    const p = scanner.scan("a");
    await list.flush(3);
    const harvested = await p;
    expect(harvested.get("b")).toBe("fresh:b");
    expect(harvested.get("c")).toBe("fresh:c");
  });

  it("skips a photo the server returned with no usable URL", async () => {
    const scanner = createUrlScanner({
      fetchPage: async () => ({
        photos: [{ id: "a", fullImageUrl: null, imageUrl: null }],
        pagination: { totalPages: 1 },
      }),
      maxPages: 50,
    });
    expect(await scanner.resolve("a")).toBeNull();
  });

  it("falls back to imageUrl when there is no full-res URL", async () => {
    const scanner = createUrlScanner({
      fetchPage: async () => ({
        photos: [{ id: "a", imageUrl: "fallback:a" }],
        pagination: { totalPages: 1 },
      }),
      maxPages: 50,
    });
    expect(await scanner.resolve("a")).toBe("fallback:a");
  });
});
