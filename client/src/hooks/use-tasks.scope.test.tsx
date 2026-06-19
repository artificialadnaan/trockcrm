// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the API layer so we control when each /tasks request settles.
const apiMock = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => apiMock(...args) }));

import { useTasks, type TaskFilters } from "./use-tasks";

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

    await act(async () => { dB.resolve(resp(["b1"])); }); // B settles first
    expect(out()?.textContent).toBe("b1");

    await act(async () => { dA.resolve(resp(["a1", "a2"])); }); // the OLD A response arrives LATE
    expect(out()?.textContent).toBe("b1"); // …and is dropped — B's rows are not clobbered
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
