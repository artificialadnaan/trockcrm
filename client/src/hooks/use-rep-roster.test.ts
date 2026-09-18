/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
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
  return mountHookWith(officeId === undefined ? {} : { officeId });
}

async function mountHookWith(
  options: Parameters<typeof useRepRoster>[0],
  initialUrl = "/deals"
): Promise<{ current: Captured }> {
  const captured = { current: undefined as unknown as Captured };
  function Probe() {
    captured.current = useRepRoster(options);
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    // Router-wrapped because the hook reads ?officeId to stay reactive to office switches.
    root?.render(createElement(MemoryRouter, { initialEntries: [initialUrl] }, createElement(Probe)));
  });
  return captured;
}

describe("useRepRoster", () => {
  it("reads the roster endpoint and exposes the reps", async () => {
    apiMock.mockResolvedValue({ users: [{ id: "u1", displayName: "Colby Burling" }] });

    const captured = await mountHook("office-1");

    expect(apiMock).toHaveBeenCalledWith("/dashboard/rep-roster", expect.anything());
    // The response above carries no `group` — an older or cached server. The hook defaults it to "sales"
    // so such a rep still lands in a section instead of being dropped from both.
    expect(captured.current.reps).toEqual([{ id: "u1", displayName: "Colby Burling", group: "sales" }]);
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

  it("issues NO request when disabled (Codex P3)", async () => {
    // The deals list section mounts this hook unconditionally but draws its own owner dropdown only
    // outside FilterBar mode, so the stage page, the director rep detail and the base /deals view were
    // fetching the roster — and its deal_owners scan — only to discard it, duplicating the parent's call.
    apiMock.mockResolvedValue({ users: [{ id: "u1", displayName: "Colby Burling" }] });

    const captured = await mountHookWith({ officeId: "office-1", enabled: false });

    expect(apiMock).not.toHaveBeenCalled();
    expect(captured.current.reps).toEqual([]);
    expect(captured.current.loading).toBe(false);
    // Settled, so a caller gating on loadedOfficeId is not left waiting for a load that never comes.
    expect(captured.current.loadedOfficeId).toBe("office-1");
  });

  it("tracks the URL office when the caller passes none (Codex P2)", async () => {
    // Office context is URL-driven, so callers that omit officeId — the leads list, the legacy owner
    // control in the deals list section — previously depended only on that undefined value. Switching
    // ?officeId never re-ran the effect and the dropdown kept offering the PREVIOUS tenant's owners.
    apiMock.mockResolvedValue({ users: [] });

    const captured = await mountHookWith({}, "/leads?officeId=office-atlanta");

    expect(captured.current.loadedOfficeId).toBe("office-atlanta");
  });

  it("lets an explicit officeId win over the URL", async () => {
    // deal-list-page passes its own effectiveOfficeId; that must keep precedence.
    apiMock.mockResolvedValue({ users: [] });

    const captured = await mountHookWith({ officeId: "office-explicit" }, "/deals?officeId=office-atlanta");

    expect(captured.current.loadedOfficeId).toBe("office-explicit");
  });

  it("records which office the loaded list belongs to", async () => {
    // Load-bearing for the deals dashboard: it defers pruning a saved rep filter until this matches the
    // office it asked for, so a stale value here silently discards valid saved filters.
    apiMock.mockResolvedValue({ users: [] });

    const captured = await mountHook("office-7");

    expect(captured.current.loadedOfficeId).toBe("office-7");
  });
});
