// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the API layer so every /tasks request is observable and settles under our control.
const apiMock = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => apiMock(...args) }));

import { useTasks, useTaskCounts, type TaskFilters } from "@/hooks/use-tasks";
import { useTaskSourceFilter, buildTaskSourceToggleOptions } from "./task-list-page";

/**
 * The automated/manual tab filter, from the client side.
 *
 * The one that matters here is the ROLE case. The `?assignee=` param this filter is modelled on is
 * read behind a role gate — `const canAssign = role === "admin" || role === "director"` — so copying
 * that pattern literally would make `?source=` a no-op for reps: the filter would render, the URL
 * would update, and the list would keep showing everything. Reps are the people with the most
 * polluted lists, so that is precisely backwards. `?source=` is read for every role.
 */
function resp(ids: string[]) {
  return {
    tasks: ids.map((id) => ({ id })),
    pagination: { page: 1, limit: 100, total: ids.length, totalPages: 1 },
  };
}

function urlFor(call: unknown[]) {
  return String(call[0]);
}

function Harness({ filters }: { filters: TaskFilters }) {
  const { tasks } = useTasks(filters);
  return <div data-testid="out">{tasks.map((t) => t.id).join(",")}</div>;
}

function CountsHarness() {
  const { counts } = useTaskCounts();
  return (
    <div data-testid="counts">
      {counts.bySource.all}/{counts.bySource.manual}/{counts.bySource.automated}
    </div>
  );
}

describe("tasks source filter — client wiring", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  const flush = async () => {
    await act(async () => {});
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    apiMock.mockReset();
  });

  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = "";
  });

  it("sends source=manual on the bucket request when the filter is set", async () => {
    apiMock.mockResolvedValue(resp(["t1"]));
    act(() => {
      root = createRoot(container);
      root.render(<Harness filters={{ section: "overdue", source: "manual" }} />);
    });
    await flush();

    expect(apiMock).toHaveBeenCalled();
    const url = urlFor(apiMock.mock.calls[0]);
    expect(url).toContain("source=manual");
    expect(url).toContain("section=overdue");
  });

  // "All" is the default and must be the pre-existing request, byte for byte -- nothing is hidden
  // until somebody chooses to hide it.
  it("omits the param entirely when no source is selected", async () => {
    apiMock.mockResolvedValue(resp(["t1"]));
    act(() => {
      root = createRoot(container);
      root.render(<Harness filters={{ section: "overdue" }} />);
    });
    await flush();

    expect(urlFor(apiMock.mock.calls[0])).not.toContain("source");
  });

  // The source is part of the query identity: if it were left out of the fetch dependencies the tab
  // would change, the URL would change, and the rows would silently stay on the previous tab's data.
  it("refetches when the source changes", async () => {
    apiMock.mockResolvedValue(resp(["t1"]));
    act(() => {
      root = createRoot(container);
      root.render(<Harness filters={{ section: "overdue", source: "manual" }} />);
    });
    await flush();
    const callsAfterFirst = apiMock.mock.calls.length;

    act(() => {
      root!.render(<Harness filters={{ section: "overdue", source: "automated" }} />);
    });
    await flush();

    expect(apiMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(urlFor(apiMock.mock.calls[apiMock.mock.calls.length - 1])).toContain("source=automated");
  });

  // Finding 5: the source is part of the SCOPE, not a narrowing of the same set. Rows from the previous
  // tab must go the instant the tab changes -- not when the request lands, and not never if it fails.
  it("drops the previous tab's rows synchronously when the source changes", async () => {
    let settle: ((value: unknown) => void) | undefined;
    apiMock.mockResolvedValueOnce(resp(["m1", "m2"]));
    act(() => {
      root = createRoot(container);
      root.render(<Harness filters={{ section: "overdue", source: "manual" }} />);
    });
    await flush();
    expect(container.querySelector('[data-testid="out"]')?.textContent).toBe("m1,m2");

    // The next request never settles, standing in for a slow or failed fetch.
    apiMock.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    act(() => {
      root!.render(<Harness filters={{ section: "overdue", source: "automated" }} />);
    });

    // Before anything resolves: the manual rows must already be gone.
    expect(container.querySelector('[data-testid="out"]')?.textContent).toBe("");
    expect(settle).toBeDefined();
  });

  // A same-scope change must NOT blank the list, or re-sorting flickers on every click.
  it("keeps rows across a sort-only change", async () => {
    apiMock.mockResolvedValue(resp(["m1"]));
    act(() => {
      root = createRoot(container);
      root.render(<Harness filters={{ section: "overdue", source: "manual", sortBy: "due_date" }} />);
    });
    await flush();

    act(() => {
      root!.render(<Harness filters={{ section: "overdue", source: "manual", sortBy: "priority" }} />);
    });
    expect(container.querySelector('[data-testid="out"]')?.textContent).toBe("m1");
  });

  it("exposes per-source counts for the tab labels from a single counts request", async () => {
    apiMock.mockResolvedValue({
      counts: {
        overdue: 1, today: 2, upcoming: 3, completed: 4, completedThisWeek: 5,
        bySource: { manual: 6, automated: 41, all: 47 },
      },
    });
    act(() => {
      root = createRoot(container);
      root.render(<CountsHarness />);
    });
    await flush();

    expect(container.querySelector('[data-testid="counts"]')?.textContent).toBe("47/6/41");
    // One request, not one per tab: the labels carry numbers without a second round trip.
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  // Finding 4: the summary cards read from this endpoint, so it has to know which tab is selected --
  // otherwise an Overdue card counting automated work sits above an Overdue bucket that excluded it.
  it("sends the source to the counts endpoint so the cards match the buckets", async () => {
    apiMock.mockResolvedValue({
      counts: {
        overdue: 1, today: 0, upcoming: 0, completed: 0, completedThisWeek: 0,
        bySource: { manual: 6, automated: 41, all: 47 },
      },
    });
    function Scoped() {
      const { counts } = useTaskCounts(undefined, "manual");
      return <div data-testid="counts">{counts.overdue}</div>;
    }
    act(() => {
      root = createRoot(container);
      root.render(<Scoped />);
    });
    await flush();

    expect(urlFor(apiMock.mock.calls[0])).toContain("source=manual");
  });

  // #1111: the counts hook re-fetches on a tab change but its staleness key tracked only userId, so
  // the PREVIOUS tab's card values stayed eligible for display while the new request was in flight —
  // and indefinitely if it failed. The page renders "—" for stale counts precisely so the cards never
  // show numbers belonging to a filter the user has already left.
  it("reports the counts as stale the moment the tab changes, before the new ones land", async () => {
    const counts = (all: number) => ({
      counts: {
        overdue: all, today: 0, upcoming: 0, completed: 0, completedThisWeek: 0,
        bySource: { manual: 0, automated: 0, all },
      },
    });
    apiMock.mockResolvedValueOnce(counts(41));

    function Scoped({ source }: { source?: "manual" | "automated" }) {
      const { counts: c, stale } = useTaskCounts(undefined, source);
      return <div data-testid="out">{stale ? "stale" : String(c.bySource.all)}</div>;
    }

    act(() => {
      root = createRoot(container);
      root.render(<Scoped source="manual" />);
    });
    await flush();
    expect(container.querySelector('[data-testid="out"]')?.textContent).toBe("41");

    // The next request never settles, standing in for a slow or failed fetch.
    apiMock.mockImplementationOnce(() => new Promise(() => {}));
    act(() => { root!.render(<Scoped source="automated" />); });

    expect(container.querySelector('[data-testid="out"]')?.textContent).toBe("stale");
  });

  // A same-scope re-render must NOT be reported stale, or the cards blank on every unrelated update.
  it("does not report staleness when the tab is unchanged", async () => {
    apiMock.mockResolvedValue({
      counts: {
        overdue: 0, today: 0, upcoming: 0, completed: 0, completedThisWeek: 0,
        bySource: { manual: 0, automated: 0, all: 7 },
      },
    });
    function Scoped() {
      const { counts: c, stale } = useTaskCounts(undefined, "manual");
      return <div data-testid="out">{stale ? "stale" : String(c.bySource.all)}</div>;
    }
    act(() => {
      root = createRoot(container);
      root.render(<Scoped />);
    });
    await flush();
    act(() => { root!.render(<Scoped />); });

    expect(container.querySelector('[data-testid="out"]')?.textContent).toBe("7");
  });

  it("refetches the counts when the tab changes", async () => {
    apiMock.mockResolvedValue({
      counts: {
        overdue: 0, today: 0, upcoming: 0, completed: 0, completedThisWeek: 0,
        bySource: { manual: 0, automated: 0, all: 0 },
      },
    });
    function Scoped({ source }: { source?: "manual" | "automated" }) {
      const { counts } = useTaskCounts(undefined, source);
      return <div data-testid="counts">{counts.bySource.all}</div>;
    }
    act(() => {
      root = createRoot(container);
      root.render(<Scoped source="manual" />);
    });
    await flush();
    const first = apiMock.mock.calls.length;

    act(() => { root!.render(<Scoped source="automated" />); });
    await flush();

    expect(apiMock.mock.calls.length).toBeGreaterThan(first);
    expect(urlFor(apiMock.mock.calls[apiMock.mock.calls.length - 1])).toContain("source=automated");
  });
});

describe("tasks source filter — URL persistence for every role", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  const flush = async () => {
    await act(async () => {});
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    apiMock.mockReset();
    apiMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).startsWith("/tasks/counts")
          ? {
              counts: {
                overdue: 0, today: 0, upcoming: 0, completed: 0, completedThisWeek: 0,
                bySource: { manual: 0, automated: 0, all: 0 },
              },
            }
          : resp([])
      )
    );
  });

  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = "";
  });

  function SourceHarness() {
    const { selection, source, setSource } = useTaskSourceFilter();
    return (
      <div>
        <div data-testid="source">{source ?? "(all)"}</div>
        {/* What the TOGGLE is showing, which is not the same thing as what goes on the wire: the All
            tab is a real selection whose wire value is "send no filter". */}
        <div data-testid="selection">{selection}</div>
        <button data-testid="pick-manual" onClick={() => setSource("manual")} />
        <button data-testid="pick-all" onClick={() => setSource("all")} />
      </div>
    );
  }

  const renderAt = (entry: string) => {
    act(() => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={[entry]}>
          <SourceHarness />
        </MemoryRouter>
      );
    });
  };

  const shown = () => container.querySelector('[data-testid="source"]')?.textContent;
  const selected = () => container.querySelector('[data-testid="selection"]')?.textContent;

  // C11, structurally. The `?assignee=` filter this sits next to is read behind
  // `role === "admin" || role === "director"`, and copying that shape here would silently break the
  // filter for reps. This hook takes NO role argument, so it cannot be gated on one by accident --
  // there is nothing to gate on. The arity assertion is what keeps that true: adding a role
  // parameter, the first move anyone copying the assignee pattern would make, fails right here.
  it("takes no role parameter, so it cannot be role-gated", () => {
    expect(useTaskSourceFilter.length).toBe(0);
  });

  it("restores ?source=automated from a deep link", async () => {
    renderAt("/tasks?source=automated");
    await flush();
    expect(shown()).toBe("automated");
  });

  // The default. The page used to open on 15,409 tasks of which 15,360 were machine-generated; it now
  // opens on the ones a person typed. Absence of the param means the DEFAULT, not "no filter".
  it("opens on Manual when the URL says nothing", async () => {
    renderAt("/tasks");
    await flush();
    expect(shown()).toBe("manual");
    expect(selected()).toBe("manual");
  });

  // An unknown value falls back to the DEFAULT, not to All. "We don't understand what you asked for"
  // is not a reason to answer with fifteen thousand rows.
  it("falls back to the default for a source value outside the allowlist", async () => {
    renderAt("/tasks?source=bogus");
    await flush();
    expect(shown()).toBe("manual");
  });

  it("honours an explicit ?source=all", async () => {
    renderAt("/tasks?source=all");
    await flush();
    expect(shown()).toBe("(all)");
    expect(selected()).toBe("all");
  });

  it("writes the selection to the URL, so a filtered view is linkable and survives a refresh", async () => {
    renderAt("/tasks?source=all");
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="pick-manual"]')!.click();
    });
    expect(shown()).toBe("manual");
  });

  /**
   * THE REGRESSION THIS FEATURE IS ONE LINE AWAY FROM AT ALL TIMES.
   *
   * All used to be expressed by DELETING ?source. Now that an absent param means "manual", deleting
   * it hands the very next render straight back to the default — the selection snaps to Manual and
   * the All tab becomes unclickable. Selecting All has to SAY "all" out loud.
   *
   * Asserted twice on purpose: once on the wire value (no filter) and once on what the toggle shows.
   * The first alone passes even if the control has bounced back to Manual, because Manual and All
   * differ in `source` but a broken implementation could still report `undefined` for one render.
   */
  it("stays on All after choosing it, instead of snapping back to the default", async () => {
    renderAt("/tasks");
    await flush();
    expect(selected()).toBe("manual");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="pick-all"]')!.click();
    });
    await flush();

    expect(selected()).toBe("all");
    expect(shown()).toBe("(all)");
  });
});

// The tab labels carry numbers from /tasks/counts, and those numbers belong to a SCOPE — the assignee
// and the tab. useTaskCounts reports `stale` while a scope swap is in flight, and the summary cards
// already honour it (cardValue renders "—"). The toggle read counts.bySource straight through, so on
// an assignee change the tab totals kept describing the previous assignee while the buckets underneath
// had already switched — and indefinitely if the request failed.
describe("tab labels do not show another scope's numbers", () => {
  const bySource = { manual: 6, automated: 41, all: 47 };

  it("shows the counts when they belong to the current scope", () => {
    const options = buildTaskSourceToggleOptions(bySource, false);

    expect(options.map((o) => o.value)).toEqual(["all", "manual", "automated"]);
    expect(options.map((o) => o.count)).toEqual([47, 6, 41]);
  });

  it("omits every count while the scope swap is in flight", () => {
    const options = buildTaskSourceToggleOptions(bySource, true);

    // Undefined rather than 0: ScopeToggle renders no number at all for undefined, whereas 0 would be
    // a confident claim that the new scope is empty — which is exactly what is not yet known.
    expect(options.map((o) => o.count)).toEqual([undefined, undefined, undefined]);
    // The labels themselves must survive, or the control disappears mid-swap.
    expect(options.map((o) => o.label)).toEqual(["All", "Manual", "Automated"]);
  });
});
