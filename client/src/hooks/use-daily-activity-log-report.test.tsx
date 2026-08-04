// @vitest-environment jsdom
//
// Guards the superseded-response rule in useDailyActivityLogReport. This report has 13 type chips
// plus paging and the owner/office/date controls, so rapid changes routinely leave an older request
// in flight. Without a request-generation guard a slower earlier response lands last and repaints the
// page with the previous filter's entries -- the user sees "Note" selected over unfiltered data.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useSearchParams } from "react-router-dom";

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

const {
  useDailyActivityLogReport,
  useRepActivityReport,
  useWorkflowBottlenecksReport,
  useProjectReadinessReport,
} = await import("./use-reports");

/**
 * Generic harness: mount any report hook inside a router and switch ?officeId IN PLACE (no remount —
 * a remount would refetch trivially and prove nothing about the dependency).
 */
async function renderScopedHook<T>(useHook: () => T, initialEntry: string) {
  const container = document.createElement("div");
  const root = createRoot(container);
  let current: T;
  let setParams: ReturnType<typeof useSearchParams>[1];
  function Probe() {
    const [, setSearchParams] = useSearchParams();
    setParams = setSearchParams;
    current = useHook();
    return null;
  }
  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: [initialEntry] }, createElement(Probe)));
  });
  return {
    get current() {
      return current;
    },
    async setOffice(officeId: string) {
      await act(async () => {
        setParams(new URLSearchParams({ officeId }));
      });
    },
  };
}

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

// The hook reads ?officeId (the app-level cross-office scope) via useSearchParams, so it has to run
// inside a router. setParams is captured from the live tree so a test can change the URL WITHOUT
// remounting — a remount would refetch trivially and prove nothing about the dependency key.
async function renderLog(initialEntry = "/reports/performance/daily-activity-log") {
  const container = document.createElement("div");
  const root = createRoot(container);
  let current: ReturnType<typeof useDailyActivityLogReport>;
  let setParams: ReturnType<typeof useSearchParams>[1];
  function Probe({ types }: { types: string[] }) {
    const [, setSearchParams] = useSearchParams();
    setParams = setSearchParams;
    current = useDailyActivityLogReport({ dateFrom: "2026-06-01", dateTo: "2026-06-30", types });
    return null;
  }
  function Tree({ types }: { types: string[] }) {
    return createElement(
      MemoryRouter,
      { initialEntries: [initialEntry] },
      createElement(Probe, { types })
    );
  }
  await act(async () => {
    root.render(createElement(Tree, { types: [] }));
  });
  return {
    get current() {
      return current;
    },
    async rerender(types: string[]) {
      await act(async () => {
        root.render(createElement(Tree, { types }));
      });
    },
    /** Change the app-level office scope in place, as the office switcher does. */
    async setOffice(officeId: string) {
      await act(async () => {
        setParams(new URLSearchParams({ officeId }));
      });
    },
  };
}

beforeEach(() => {
  pending.length = 0;
});

describe("useDailyActivityLogReport office scope", () => {
  // ?officeId never reaches the hook's options — api() reads it off window.location and sends it as
  // x-office-id. Leaving it out of the dependency key meant switching office re-rendered the page
  // (so deal links immediately pointed at the NEW office) without refetching, so the rows on screen
  // still belonged to the PREVIOUS office. Every row then linked somewhere it did not belong.
  it("refetches when the app-level office scope changes and shows the NEW office's rows", async () => {
    const hook = await renderLog("/reports/performance/daily-activity-log?officeId=office-a");
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending[0].resolve(payload("office-a-rows"));
    });
    expect(hook.current.data?.appliedTypes).toEqual(["office-a-rows"]);

    // Switch office in place — no remount, exactly what the office switcher does.
    await hook.setOffice("office-b");

    // A second request must actually have been issued...
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[1].resolve(payload("office-b-rows"));
    });

    // ...and the DISPLAYED data must come from it. Asserting only that the URL changed would pass
    // while the bug was live, which is the exact shape of the bug.
    expect(hook.current.data?.appliedTypes).toEqual(["office-b-rows"]);
  });

  it("does not leave the previous office's rows visible if the new request is still pending", async () => {
    const hook = await renderLog("/reports/performance/daily-activity-log?officeId=office-a");
    await act(async () => {
      pending[0].resolve(payload("office-a-rows"));
    });
    expect(hook.current.data?.appliedTypes).toEqual(["office-a-rows"]);

    await hook.setOffice("office-b");

    // While office B is in flight the report must read as loading rather than presenting office A's
    // rows as if they belonged to office B.
    expect(hook.current.loading).toBe(true);
  });
});

describe("usePerformanceReport office scope (shared by 3 sibling reports)", () => {
  // The same gap existed in usePerformanceReport, which backs Director Scorecard, Rep Activity and
  // Forecast Accuracy. The fix lives in that shared hook, so it needs its own guard — otherwise a
  // future edit could restore the bug for all three while the Daily Activity Log tests stayed green.
  // Rep Activity stands in for the three; they share one code path.
  async function renderRepActivity(initialEntry: string) {
    const container = document.createElement("div");
    const root = createRoot(container);
    let current: ReturnType<typeof useRepActivityReport>;
    let setParams: ReturnType<typeof useSearchParams>[1];
    function Probe() {
      const [, setSearchParams] = useSearchParams();
      setParams = setSearchParams;
      current = useRepActivityReport({ dateFrom: "2026-06-01", dateTo: "2026-06-30" });
      return null;
    }
    await act(async () => {
      root.render(
        createElement(MemoryRouter, { initialEntries: [initialEntry] }, createElement(Probe))
      );
    });
    return {
      get current() {
        return current;
      },
      async setOffice(officeId: string) {
        await act(async () => {
          setParams(new URLSearchParams({ officeId }));
        });
      },
    };
  }

  it("refetches Rep Activity when the office scope changes", async () => {
    const hook = await renderRepActivity("/reports/performance/rep-activity?officeId=office-a");
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending[0].resolve({ data: { kpis: { totalTouchpoints: 11 } } });
    });
    expect((hook.current.data as { kpis: { totalTouchpoints: number } } | null)?.kpis.totalTouchpoints).toBe(11);

    await hook.setOffice("office-b");
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[1].resolve({ data: { kpis: { totalTouchpoints: 22 } } });
    });
    expect((hook.current.data as { kpis: { totalTouchpoints: number } } | null)?.kpis.totalTouchpoints).toBe(22);
  });

  it("ignores the OLD office's response when it lands after the new one", async () => {
    // Making these reports refetch on office change also gave them a race they did not have before:
    // office A's request is still in flight when the scope switches, and if it resolves last it
    // overwrites office B's rows — the same stale-data symptom the refetch was meant to fix, reached
    // from the other side. A refetch trigger without an ordering guarantee is only half a fix.
    const hook = await renderRepActivity("/reports/performance/rep-activity?officeId=office-a");
    expect(pending).toHaveLength(1);

    // Switch office BEFORE office A's response arrives.
    await hook.setOffice("office-b");
    expect(pending).toHaveLength(2);

    // The newer request settles first, then the stale one lands late.
    await act(async () => {
      pending[1].resolve({ data: { kpis: { totalTouchpoints: 22 } } });
    });
    await act(async () => {
      pending[0].resolve({ data: { kpis: { totalTouchpoints: 11 } } });
    });

    expect((hook.current.data as { kpis: { totalTouchpoints: number } } | null)?.kpis.totalTouchpoints).toBe(22);
    expect(hook.current.loading).toBe(false);
  });

  it("ignores a superseded request's ERROR so a dead request cannot blank a good page", async () => {
    const hook = await renderRepActivity("/reports/performance/rep-activity?officeId=office-a");
    await hook.setOffice("office-b");

    await act(async () => {
      pending[1].resolve({ data: { kpis: { totalTouchpoints: 22 } } });
    });
    await act(async () => {
      pending[0].reject(new Error("stale office request failed"));
    });

    expect(hook.current.error).toBeNull();
    expect((hook.current.data as { kpis: { totalTouchpoints: number } } | null)?.kpis.totalTouchpoints).toBe(22);
  });
});

// The operations reports use a DIFFERENT hook family from usePerformanceReport, so the office-scope
// refetch never reached them. Their DealLink was then given a correct ?officeId, which made them
// strictly worse: correct links rendered over rows fetched from the previous office. Both hooks now
// go through useScopedReport, so they carry all three properties.
describe.each([
  ["useWorkflowBottlenecksReport", useWorkflowBottlenecksReport],
  ["useProjectReadinessReport", useProjectReadinessReport],
])("%s office scope", (_name, useHook) => {
  it("refetches on an office switch and shows the NEW office's rows", async () => {
    const hook = await renderScopedHook(() => useHook({}), "/reports/x?officeId=office-a");
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending[0].resolve({ data: { marker: "office-a" } });
    });
    expect((hook.current.data as { marker: string } | null)?.marker).toBe("office-a");

    await hook.setOffice("office-b");
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[1].resolve({ data: { marker: "office-b" } });
    });
    expect((hook.current.data as { marker: string } | null)?.marker).toBe("office-b");
  });

  it("does not let the previous office's rows survive the switch", async () => {
    // Property 3, distinct from the stale-response guard: the guard stops an old RESPONSE landing, it
    // does nothing about old ROWS already painted. The layout effect must clear them before paint,
    // because deal links have ALREADY re-rendered with the new office id by this point.
    const hook = await renderScopedHook(() => useHook({}), "/reports/x?officeId=office-a");
    await act(async () => {
      pending[0].resolve({ data: { marker: "office-a" } });
    });
    expect(hook.current.data).not.toBeNull();

    await hook.setOffice("office-b");

    expect(hook.current.data).toBeNull();
    expect(hook.current.loading).toBe(true);
  });

  it("ignores the old office's response when it lands after the new one", async () => {
    const hook = await renderScopedHook(() => useHook({}), "/reports/x?officeId=office-a");
    await hook.setOffice("office-b");
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[1].resolve({ data: { marker: "office-b" } });
    });
    await act(async () => {
      pending[0].resolve({ data: { marker: "office-a" } });
    });

    expect((hook.current.data as { marker: string } | null)?.marker).toBe("office-b");
  });
});

describe("synchronous invalidation on scope change", () => {
  it("clears rows for the Daily Activity Log too, not just the operations reports", async () => {
    const hook = await renderScopedHook(
      () => useDailyActivityLogReport({ dateFrom: "2026-06-01", dateTo: "2026-06-30" }),
      "/reports/performance/daily-activity-log?officeId=office-a"
    );
    await act(async () => {
      pending[0].resolve(payload("office-a-rows"));
    });
    expect(hook.current.data).not.toBeNull();

    await hook.setOffice("office-b");

    expect(hook.current.data).toBeNull();
    expect(hook.current.loading).toBe(true);
  });

  it("does not blank the data on a non-office change", async () => {
    // The invalidation is keyed on the office scope alone. A filter or page change already refetches
    // through `deps`; blanking the table on every filter tweak would be a different behaviour change.
    const hook = await renderLog("/reports/performance/daily-activity-log?officeId=office-a");
    await act(async () => {
      pending[0].resolve(payload("first"));
    });
    expect(hook.current.data).not.toBeNull();

    await hook.rerender(["note"]);

    // A refetch is in flight, but the previous rows are still shown until it lands.
    expect(hook.current.data).not.toBeNull();
    expect(pending).toHaveLength(2);
  });
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
