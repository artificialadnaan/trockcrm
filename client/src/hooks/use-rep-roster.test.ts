/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRepRoster } from "./use-rep-roster";

const apiMock = vi.hoisted(() => vi.fn());

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  container?.remove();
  container = null;
  root = null;
  apiMock.mockReset();
});

type Captured = ReturnType<typeof useRepRoster>;

async function mountHook(officeId?: string): Promise<{ current: Captured }> {
  const captured = { current: undefined as unknown as Captured };
  function Probe() {
    captured.current = useRepRoster(officeId === undefined ? {} : { officeId });
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Probe));
  });
  return captured;
}

describe("useRepRoster", () => {
  it("reads the roster endpoint and exposes the reps", async () => {
    apiMock.mockResolvedValue({ users: [{ id: "u1", displayName: "Colby Burling" }] });

    const captured = await mountHook("office-1");

    expect(apiMock).toHaveBeenCalledWith("/dashboard/rep-roster", expect.anything());
    expect(captured.current.reps).toEqual([{ id: "u1", displayName: "Colby Burling" }]);
    expect(captured.current.loading).toBe(false);
  });

  it("falls back to an empty list when the response has no users array", async () => {
    // The white-screen guard. Without it `setReps(undefined)` lands in state and the very next render of
    // the deals dashboard throws on `repOptions.map`, taking down the whole page — not just the dropdown.
    // Any non-conforming body reaches here: an error envelope, an HTML error page from a proxy, {}.
    apiMock.mockResolvedValue({ error: "forbidden" });

    const captured = await mountHook("office-1");

    expect(captured.current.reps).toEqual([]);
  });

  it("survives a null body", async () => {
    apiMock.mockResolvedValue(null);

    const captured = await mountHook("office-1");

    expect(captured.current.reps).toEqual([]);
  });

  it("reports an error and an empty list when the request rejects", async () => {
    apiMock.mockRejectedValue(new Error("network down"));

    const captured = await mountHook("office-1");

    expect(captured.current.reps).toEqual([]);
    expect(captured.current.error).toBe("network down");
    expect(captured.current.loading).toBe(false);
  });

  it("records which office the loaded list belongs to", async () => {
    // Load-bearing for the deals dashboard: it defers pruning a saved rep filter until this matches the
    // office it asked for, so a stale value here silently discards valid saved filters.
    apiMock.mockResolvedValue({ users: [] });

    const captured = await mountHook("office-7");

    expect(captured.current.loadedOfficeId).toBe("office-7");
  });
});
