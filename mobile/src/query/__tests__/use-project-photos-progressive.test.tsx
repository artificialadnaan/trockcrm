/**
 * The gallery must PAINT before the page walk finishes.
 *
 * This is the "took forever to load" half of the original field report. The server side is fixed — a
 * page costs ~1.3ms of database time now rather than ~36ms — but the client still waited for EVERY page
 * before rendering anything, and District at Boynton is 8,652 photos: 44 pages, three at a time, ~15
 * sequential round trips of jobsite cellular before a single thumbnail appeared.
 *
 * What is asserted is the ORDER of observable states, not a duration: page 1's photos must be readable
 * by a subscriber while later pages are still in flight. A test that only checked the final result would
 * pass just as happily against the blocking version, which is the whole defect.
 */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";

const mockGetProjectPhotos = jest.fn();
jest.mock("../../api/endpoints", () => ({
  getProjectPhotos: (...args: unknown[]) => mockGetProjectPhotos(...args),
}));

const mockAuth = { fetcher: jest.fn(), user: { id: "user-1", tenantId: "t1" }, activeOfficeId: "office-a" };
jest.mock("../../auth/AuthContext", () => ({ useAuth: () => mockAuth }));

// eslint-disable-next-line import/first
import { useProjectPhotos } from "../hooks";

const photo = (id: string) => ({ id, takenAt: null, createdAt: "2026-09-18T12:00:00Z" });
/** Mirrors PHOTOS_PAGE_CONCURRENCY in hooks.ts — the most one in-flight batch can have requested. */
const PAGE_CONCURRENCY = 3;

/** Renders the hook and records every distinct (count, complete) the subscriber actually observes. */
function Probe({ seen }: { seen: Array<{ count: number; complete: boolean }> }) {
  const q = useProjectPhotos("deal-1", {});
  const count = q.data?.photos.length ?? 0;
  const complete = q.data?.complete === true;
  const last = seen[seen.length - 1];
  if (!last || last.count !== count || last.complete !== complete) seen.push({ count, complete });
  return <Text>{count}</Text>;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * gcTime 0 is not a detail. A QueryClient keeps its default five-minute cache-GC timer alive, and jest
 * will not exit while one is pending — running this file alone passed every assertion and then sat there
 * reporting "Jest did not exit", which in CI is a timeout rather than a pass. The clients are cleared
 * after each test as well, so nothing survives into the next one.
 */
const clients: QueryClient[] = [];
function makeClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return client;
}

beforeEach(() => {
  mockGetProjectPhotos.mockReset();
});

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.clear();
    client.unmount();
  }
});

describe("useProjectPhotos progressive loading", () => {
  it("publishes page 1 while later pages are still in flight", async () => {
    const page2 = deferred<{ photos: Array<{ id: string }>; pagination: unknown }>();
    mockGetProjectPhotos.mockImplementation((_f: unknown, _d: string, params: { page: number }) => {
      if (params.page === 1) {
        return Promise.resolve({
          photos: [photo("p1"), photo("p2")],
          pagination: { page: 1, limit: 200, total: 3, totalPages: 2, oldestAt: null },
        });
      }
      return page2.promise;
    });

    const seen: Array<{ count: number; complete: boolean }> = [];
    const client = makeClient();
    render(
      <QueryClientProvider client={client}>
        <Probe seen={seen} />
      </QueryClientProvider>,
    );

    // Page 1 lands; page 2 is deliberately left pending. THE assertion: photos are readable while the
    // walk is still running, and the set is openly marked incomplete.
    await waitFor(() => expect(seen[seen.length - 1].count).toBe(2));
    expect(seen[seen.length - 1].complete).toBe(false);

    // Now let the walk finish.
    await act(async () => {
      page2.resolve({ photos: [photo("p3")], pagination: { page: 2, limit: 200, total: 3, totalPages: 2 } });
    });
    await waitFor(() => expect(seen[seen.length - 1].complete).toBe(true));
    expect(seen[seen.length - 1].count).toBe(3);

    // And the subscriber genuinely saw the intermediate state, not just the end.
    expect(seen.some((s) => s.count === 2 && !s.complete)).toBe(true);
  });

  it("dedupes across pages as it streams, not only at the end", async () => {
    // Overlapping pages are real: OFFSET paging over a live table repeats a row when one is inserted
    // mid-walk. A duplicate id renders a blank cell in the viewer's FlatList, so an intermediate publish
    // must not carry one either.
    mockGetProjectPhotos.mockImplementation((_f: unknown, _d: string, params: { page: number }) =>
      Promise.resolve(
        params.page === 1
          ? {
              photos: [photo("p1"), photo("p2")],
              pagination: { page: 1, limit: 200, total: 3, totalPages: 2, oldestAt: null },
            }
          : { photos: [photo("p2"), photo("p3")], pagination: { page: 2, limit: 200, total: 3, totalPages: 2 } },
      ),
    );

    const seen: Array<{ count: number; complete: boolean }> = [];
    const client = makeClient();
    render(
      <QueryClientProvider client={client}>
        <Probe seen={seen} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(seen[seen.length - 1].complete).toBe(true));
    expect(seen[seen.length - 1].count).toBe(3); // p2 counted once, not twice
  });

  it("marks the result complete even when the project fits in one page", async () => {
    mockGetProjectPhotos.mockResolvedValue({
      photos: [photo("p1")],
      pagination: { page: 1, limit: 200, total: 1, totalPages: 1, oldestAt: null },
    });

    const seen: Array<{ count: number; complete: boolean }> = [];
    const client = makeClient();
    render(
      <QueryClientProvider client={client}>
        <Probe seen={seen} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(seen[seen.length - 1].complete).toBe(true));
    expect(seen[seen.length - 1].count).toBe(1);
  });

  /**
   * A cancelled walk must not be able to write to the cache.
   *
   * Pull-to-refresh while pages are still arriving starts a replacement walk and cancels this one — but
   * cancellation does not stop an async function, it only makes React Query ignore its RETURN. Publishing
   * straight to the cache side-steps that, so an abandoned walk keeps writing; if one of its older
   * batches lands last it overwrites the fresh result with stale photos and complete:false, leaving the
   * gallery on the previous set with report and share disabled until another refresh.
   *
   * The assertion is on the PHOTO IDS, not on `complete`. A first version of this test checked only the
   * flag and passed with the guard deleted — the stale write did land, it just happened to carry the
   * same flag value by the time the assertion ran.
   */
  it("does not publish from a walk that was aborted", async () => {
    const stalePage2 = deferred<{ photos: Array<{ id: string }>; pagination: unknown }>();
    let seenPage1 = 0;
    mockGetProjectPhotos.mockImplementation((_f: unknown, _d: string, params: { page: number }) => {
      if (params.page === 1) {
        seenPage1 += 1;
        return seenPage1 === 1
          ? Promise.resolve({
              photos: [photo("old-1")],
              pagination: { page: 1, limit: 200, total: 2, totalPages: 2, oldestAt: null },
            })
          : Promise.resolve({
              photos: [photo("fresh-1")],
              pagination: { page: 1, limit: 200, total: 1, totalPages: 1, oldestAt: null },
            });
      }
      return stalePage2.promise; // only the FIRST walk asks for page 2
    });

    const seen: string[][] = [];
    const client = makeClient();
    let refetch: (() => Promise<unknown>) | undefined;

    function Driver() {
      const q = useProjectPhotos("deal-1", {});
      refetch = q.refetch;
      const ids = (q.data?.photos ?? []).map((p) => p.id);
      const last = seen[seen.length - 1];
      if (!last || last.join() !== ids.join()) seen.push(ids);
      return <Text>{ids.length}</Text>;
    }

    render(
      <QueryClientProvider client={client}>
        <Driver />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(seen[seen.length - 1]).toEqual(["old-1"]));

    // Refresh mid-walk. This cancels the first walk, whose page 2 is still pending.
    await act(async () => {
      void refetch?.();
    });
    await waitFor(() => expect(seen[seen.length - 1]).toEqual(["fresh-1"]));

    // Now let the ABANDONED walk's page finally resolve. Without the abort guard it publishes
    // ["old-1","old-2"] over the fresh result.
    await act(async () => {
      stalePage2.resolve({
        photos: [photo("old-2")],
        pagination: { page: 2, limit: 200, total: 2, totalPages: 2 },
      });
    });
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    // Read the CACHE, not what the component happened to re-render with. setQueryData writes the cache
    // synchronously while a notification may not have been flushed, so asserting on the rendered value
    // lets a stale write land unobserved — a second version of this test did exactly that and passed
    // with the guard deleted.
    const cached = client.getQueryCache().getAll()[0]?.state.data as
      | { photos: Array<{ id: string }>; complete: boolean }
      | undefined;
    expect(cached?.photos.map((p) => p.id)).toEqual(["fresh-1"]);
    expect(cached?.complete).toBe(true);
  });

  /**
   * A cancelled walk must stop FETCHING, not merely stop publishing.
   *
   * Suppressing the cache writes alone left an abandoned walk downloading every remaining page — on a
   * 50-page gallery that is thousands of photos still being fetched and server-presigned, competing for
   * bandwidth and for the API's connection pool with the replacement query the user is actually waiting
   * on.
   */
  it("stops requesting pages once the walk is cancelled", async () => {
    const gate = deferred<{ photos: Array<{ id: string }>; pagination: unknown }>();
    const requested: number[] = [];
    let seenPage1 = 0;
    mockGetProjectPhotos.mockImplementation((_f: unknown, _d: string, params: { page: number }) => {
      requested.push(params.page);
      if (params.page === 1) {
        seenPage1 += 1;
        return Promise.resolve({
          photos: [photo(`p1-${seenPage1}`)],
          // 10 pages on the FIRST walk so there is plenty left to cancel; 1 on the replacement.
          pagination: {
            page: 1,
            limit: 200,
            total: 10,
            totalPages: seenPage1 === 1 ? 10 : 1,
            oldestAt: null,
          },
        });
      }
      return gate.promise;
    });

    const client = makeClient();
    let refetch: (() => Promise<unknown>) | undefined;
    function Driver() {
      const q = useProjectPhotos("deal-1", {});
      refetch = q.refetch;
      return <Text>{q.data?.photos.length ?? 0}</Text>;
    }
    const view = render(
      <QueryClientProvider client={client}>
        <Driver />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(view.getByText("1")).toBeTruthy());

    await act(async () => {
      void refetch?.();
    });
    await act(async () => {
      gate.resolve({ photos: [photo("late")], pagination: { page: 2, limit: 200, total: 10, totalPages: 10 } });
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    // The abandoned walk planned pages 2..10. It must not have kept marching through them after the
    // cancellation: only the batch already in flight when it was cancelled may appear.
    const laterPages = requested.filter((p) => p > 1);
    expect(laterPages.length).toBeLessThanOrEqual(PAGE_CONCURRENCY);
  });
});
