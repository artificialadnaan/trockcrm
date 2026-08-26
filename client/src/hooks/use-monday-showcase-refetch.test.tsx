// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * useMondayShowcase's staleness contract. The page also defends itself (it will not render a caveat that
 * describes a payload other than the current selection), but that only protects the consumers someone
 * remembered to gate. The hook clearing its payload at refetch start is the structural half: while a new
 * request is in flight there IS no previous payload for any consumer to derive stale copy from.
 *
 * This matters here more than the usual "spinner vs stale data" preference: the copy derived from this
 * payload is what tells a reader which figures the Service/Other filter reached, and that Active leads are
 * not among them.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A controllable api: each call parks a resolver so a request can be observed mid-flight.
const pending: Array<(value: unknown) => void> = [];
const apiMock = vi.fn(
  () =>
    new Promise((resolve) => {
      pending.push(resolve);
    })
);
vi.mock("@/lib/api", () => ({ api: apiMock }));

const { useMondayShowcase } = await import("./use-reports");

const payloadFor = (selected: string[], wonCount = 1) => ({
  data: {
    period: { from: "2026-06-08", to: "2026-06-12", mode: "to_date", label: "x" },
    departments: [],
    execHero: {
      won: { count: wonCount, value: { amount: 1, basisLabel: "b" } },
      sent: { count: 1, value: { amount: 1, basisLabel: "b" } },
      estimated: { count: 1, value: { amount: 1, basisLabel: "b" } },
    },
    reps: [],
    officeProjection: { bands: [], coverage: { n: 0, m: 0, undatedValue: 0 }, coverageCaption: "" },
    weeklyTrend: [],
    valueBases: { won_awarded_first: "a", open_best_estimate: "b" },
    routeFilter: { selected, active: selected.length === 1, unfilterable: [] },
    notes: [],
  },
});

let container: HTMLDivElement;
let root: Root;
let seen: { data: unknown; loading: boolean } = { data: null, loading: false };
let navigateTo: ((to: string) => void) | null = null;

function Probe({ routes }: { routes?: string[] }) {
  const { data, loading } = useMondayShowcase("to_date", routes as never);
  seen = { data, loading };
  return null;
}

function RoutedProbe({ routes }: { routes?: string[] }) {
  navigateTo = useNavigate();
  return <Probe routes={routes} />;
}

function renderProbe(routes?: string[], initialEntry = "/") {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <RoutedProbe routes={routes} />
      </MemoryRouter>
    );
  });
}

beforeEach(() => {
  pending.length = 0;
  apiMock.mockClear();
  navigateTo = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useMondayShowcase staleness", () => {
  it("clears the previous payload as soon as a new request starts", async () => {
    renderProbe(["service"]);
    // Settle the first request so there IS a payload to go stale.
    await act(async () => {
      pending[0](payloadFor(["service"]));
    });
    expect((seen.data as { routeFilter: { selected: string[] } }).routeFilter.selected).toEqual(["service"]);
    expect(seen.loading).toBe(false);

    // Change the selection: the second request is now in flight.
    renderProbe(undefined);
    // THE ASSERTION: mid-flight there is no payload left to derive stale copy from.
    expect(seen.loading).toBe(true);
    expect(seen.data).toBeNull();

    await act(async () => {
      pending[1](payloadFor(["service", "other"]));
    });
    expect((seen.data as { routeFilter: { selected: string[] } }).routeFilter.selected).toEqual([
      "service",
      "other",
    ]);
  });

  it("still delivers the payload normally on a first load (the clear is not a general blocker)", async () => {
    renderProbe(["other"]);
    expect(seen.data).toBeNull();
    await act(async () => {
      pending[0](payloadFor(["other"]));
    });
    expect(seen.data).not.toBeNull();
    expect(seen.loading).toBe(false);
  });

  it("clears old-office rows before refetching when the tenant scope changes", async () => {
    renderProbe(["service"], "/reports/monday-showcase?officeId=office-a");
    await act(async () => {
      pending[0](payloadFor(["service"]));
    });
    expect(seen.data).not.toBeNull();
    expect(seen.loading).toBe(false);

    act(() => {
      navigateTo?.("/reports/monday-showcase?officeId=office-b");
    });
    // A1's deal href now targets office-b. There must be no painted office-a payload while its B request
    // is pending, and the old response must have been superseded before a newer one can resolve.
    expect(seen.data).toBeNull();
    expect(seen.loading).toBe(true);
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[1](payloadFor(["service"]));
    });
    expect(seen.data).not.toBeNull();
    expect(seen.loading).toBe(false);
  });

  it("drops an older office response after a newer office payload has landed", async () => {
    renderProbe(["service"], "/reports/monday-showcase?officeId=office-a");
    // Keep office A's request in flight, then switch to B before it resolves.
    act(() => {
      navigateTo?.("/reports/monday-showcase?officeId=office-b");
    });
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[1](payloadFor(["service"], 222));
    });
    expect((seen.data as { execHero: { won: { count: number } } }).execHero.won.count).toBe(222);

    await act(async () => {
      pending[0](payloadFor(["service"], 111));
    });
    expect((seen.data as { execHero: { won: { count: number } } }).execHero.won.count).toBe(222);
  });

  it("does not treat the report-level office predicate as a tenant-scope switch", async () => {
    renderProbe(["service"], "/reports/monday-showcase?officeId=office-a");
    await act(async () => {
      pending[0](payloadFor(["service"], 111));
    });

    act(() => {
      navigateTo?.("/reports/monday-showcase?officeId=office-a&office=regional-sales");
    });
    expect(pending).toHaveLength(1);
    expect((seen.data as { execHero: { won: { count: number } } }).execHero.won.count).toBe(111);
    expect(seen.loading).toBe(false);
  });
});
