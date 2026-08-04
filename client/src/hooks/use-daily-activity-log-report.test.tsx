// @vitest-environment jsdom
//
// Guards the superseded-response rule in useDailyActivityLogReport. This report has 13 type chips
// plus paging and the owner/office/date controls, so rapid changes routinely leave an older request
// in flight. Without a request-generation guard a slower earlier response lands last and repaints the
// page with the previous filter's entries -- the user sees "Note" selected over unfiltered data.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

type Deferred = { url: string; resolve: (value: unknown) => void; reject: (err: unknown) => void };
const pending: Deferred[] = [];

vi.mock("@/lib/api", () => ({
  api: vi.fn(
    (url: string) =>
      new Promise((resolve, reject) => {
        pending.push({ url, resolve, reject });
      })
  ),
}));

const { useDailyActivityLogReport } = await import("./use-reports");

function payload(tag: string) {
  return {
    data: {
      kpis: { totalEntries: 0, notes: 0, daysCovered: 0, repsLogging: 0, offDayLogged: 0 },
      days: [],
      pagination: { page: 1, limit: 200, total: 0, returned: 0, totalPages: 0, hasMore: false },
      appliedTypes: [tag],
    },
  };
}

async function renderLog() {
  const container = document.createElement("div");
  const root = createRoot(container);
  let current: ReturnType<typeof useDailyActivityLogReport>;
  function Probe({ types }: { types: string[] }) {
    current = useDailyActivityLogReport({ dateFrom: "2026-06-01", dateTo: "2026-06-30", types });
    return null;
  }
  await act(async () => {
    root.render(createElement(Probe, { types: [] }));
  });
  return {
    get current() {
      return current;
    },
    async rerender(types: string[]) {
      await act(async () => {
        root.render(createElement(Probe, { types }));
      });
    },
  };
}

beforeEach(() => {
  pending.length = 0;
});

describe("useDailyActivityLogReport superseded responses", () => {
  it("drops a slow earlier response that resolves after a newer one", async () => {
    const hook = await renderLog();
    expect(pending).toHaveLength(1);

    await hook.rerender(["note"]);
    expect(pending).toHaveLength(2);
    expect(pending[1].url).toContain("types=note");

    // The NEWER request completes first, then the older one lands late.
    await act(async () => {
      pending[1].resolve(payload("note"));
    });
    await act(async () => {
      pending[0].resolve(payload("stale-unfiltered"));
    });

    // The late response must not overwrite the current filter's data.
    expect(hook.current.data?.appliedTypes).toEqual(["note"]);
    expect(hook.current.loading).toBe(false);
  });

  it("does not let a superseded request clear the loading flag while the newest is still in flight", async () => {
    const hook = await renderLog();
    await hook.rerender(["note"]);
    expect(pending).toHaveLength(2);

    // Only the OLD request settles; the current one is still pending, so the page is still loading.
    await act(async () => {
      pending[0].resolve(payload("stale-unfiltered"));
    });
    expect(hook.current.loading).toBe(true);
    expect(hook.current.data).toBeNull();

    await act(async () => {
      pending[1].resolve(payload("note"));
    });
    expect(hook.current.loading).toBe(false);
    expect(hook.current.data?.appliedTypes).toEqual(["note"]);
  });

  it("ignores an error from a superseded request", async () => {
    const hook = await renderLog();
    await hook.rerender(["note"]);

    await act(async () => {
      pending[1].resolve(payload("note"));
    });
    await act(async () => {
      pending[0].reject(new Error("stale request blew up"));
    });

    // A dead request's failure must not blank a good page.
    expect(hook.current.error).toBeNull();
    expect(hook.current.data?.appliedTypes).toEqual(["note"]);
  });
});
