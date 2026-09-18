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

beforeEach(() => {
  mockGetProjectPhotos.mockReset();
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
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Probe seen={seen} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(seen[seen.length - 1].complete).toBe(true));
    expect(seen[seen.length - 1].count).toBe(1);
  });
});
