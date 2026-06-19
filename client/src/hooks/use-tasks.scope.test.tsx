// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the API layer so we control when each /tasks request settles.
const apiMock = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => apiMock(...args) }));

import { useTasks, useTaskCounts, type TaskFilters } from "./use-tasks";

/**
 * Gate-proof for the stale-row guard (Codex #773): when the SCOPE (assignedTo) changes, useTasks must
 * drop the previous scope's rows synchronously — before the new request settles — so the prior
 * assignee's interactive rows can never stay actionable mid-refetch. A same-scope change (sort/search)
 * must keep the rows so re-sorting doesn't flicker.
 */
function resp(ids: string[]) {
  return { tasks: ids.map((id) => ({ id })), pagination: { page: 1, limit: 100, total: ids.length, totalPages: 1 } };
}

function Harness({ filters }: { filters: TaskFilters }) {
  const { tasks } = useTasks(filters);
  return <div data-testid="out">{tasks.map((t) => t.id).join(",")}</div>;
}

describe("useTasks scope guard", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  const out = () => container.querySelector('[data-testid="out"]');
  const flush = async () => {
    // Resolve queued microtasks (the awaited api promise + the resulting setState).
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
    if (root) act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("drops the previous scope's rows synchronously when assignedTo changes (no actionable stale rows mid-refetch)", async () => {
    apiMock.mockResolvedValueOnce(resp(["a1", "a2"])); // scope A settles
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness filters={{ section: "overdue", assignedTo: "A" }} />);
    });
    await flush();
    expect(out()?.textContent).toBe("a1,a2"); // scope A's rows are shown

    // Switch to scope B with the new request still IN FLIGHT (never settles during this test).
    apiMock.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      root?.render(<Harness filters={{ section: "overdue", assignedTo: "B" }} />);
    });

    // Scope B's request hasn't settled, yet scope A's rows are already gone — nothing to act on.
    expect(out()?.textContent).toBe("");
  });

  it("ignores a stale in-flight response from the previous scope (last-write-wins)", async () => {
    const defer = () => {
      let resolve!: (v: unknown) => void;
      const promise = new Promise((r) => { resolve = r; });
      return { promise, resolve };
    };
    const dA = defer();
    const dB = defer();

    apiMock.mockReturnValueOnce(dA.promise); // scope A request — left in flight
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness filters={{ section: "overdue", assignedTo: "A" }} />);
    });
    expect(out()?.textContent).toBe(""); // A hasn't settled

    apiMock.mockReturnValueOnce(dB.promise); // scope B request — also in flight
    await act(async () => {
      root?.render(<Harness filters={{ section: "overdue", assignedTo: "B" }} />);
    });

    // The OLD A request resolves FIRST — before B even settles. The scope change invalidated the
    // request token synchronously, so A must be dropped and the cleared rows must stay empty (this
    // covers the window before B's passive fetch effect has run).
    await act(async () => { dA.resolve(resp(["a1", "a2"])); });
    expect(out()?.textContent).toBe("");

    // Then B settles and its rows show — never clobbered by the stale A response.
    await act(async () => { dB.resolve(resp(["b1"])); });
    expect(out()?.textContent).toBe("b1");
  });

  it("keeps rows during a same-scope (sort) change so re-sorting doesn't flicker", async () => {
    apiMock.mockResolvedValueOnce(resp(["a1", "a2"]));
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness filters={{ section: "overdue", assignedTo: "A", sortBy: "due_date", sortDir: "asc" }} />);
    });
    await flush();
    expect(out()?.textContent).toBe("a1,a2");

    // Same assignee, different sort, request still in flight — rows must persist (no clear).
    apiMock.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      root?.render(<Harness filters={{ section: "overdue", assignedTo: "A", sortBy: "priority", sortDir: "desc" }} />);
    });
    expect(out()?.textContent).toBe("a1,a2");
  });
});

function CountsHarness({ userId }: { userId?: string }) {
  const { counts, loading, stale } = useTaskCounts(userId);
  return (
    <div data-testid="out" data-loading={String(loading)} data-stale={String(stale)}>
      {counts.overdue}
    </div>
  );
}

describe("useTaskCounts scope guard", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  const out = () => container.querySelector('[data-testid="out"]');
  const flush = async () => { await act(async () => {}); };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    apiMock.mockReset();
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("marks counts stale + loading while a scope (userId) change is in flight, not before", async () => {
    apiMock.mockResolvedValueOnce({ counts: { overdue: 1, today: 0, upcoming: 0, completed: 0, completedThisWeek: 0 } });
    await act(async () => {
      root = createRoot(container);
      root.render(<CountsHarness userId={undefined} />);
    });
    await flush();
    expect(out()?.getAttribute("data-stale")).toBe("false"); // settled for the "all" scope
    expect(out()?.getAttribute("data-loading")).toBe("false");
    expect(out()?.textContent).toBe("1");

    // Switch to a specific assignee; that request stays in flight.
    apiMock.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      root?.render(<CountsHarness userId="rep-2" />);
    });
    expect(out()?.getAttribute("data-stale")).toBe("true"); // loaded counts belong to a different scope
    expect(out()?.getAttribute("data-loading")).toBe("true"); // fetchCounts sets loading on refetch
  });
});
