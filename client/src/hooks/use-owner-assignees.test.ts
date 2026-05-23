/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOwnerAssignees } from "./use-owner-assignees";

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

function mount(element: ReturnType<typeof createElement>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
}

describe("useOwnerAssignees", () => {
  it("fetches cross-office CRM owner options", async () => {
    apiMock.mockResolvedValue({
      users: [
        { id: "rep-1", displayName: "Dallas Rep" },
        { id: "rep-2", displayName: "Atlanta Rep" },
      ],
    });

    const snapshots: Array<{ assignees: Array<{ id: string; displayName: string }>; loading: boolean }> = [];
    function Probe() {
      const result = useOwnerAssignees();
      snapshots.push({ assignees: result.assignees, loading: result.loading });
      return null;
    }

    await act(async () => {
      mount(createElement(Probe));
    });

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/users/crm-owners"));
    await vi.waitFor(() => expect(snapshots[snapshots.length - 1]?.loading).toBe(false));
    expect(snapshots[snapshots.length - 1]?.assignees).toEqual([
      { id: "rep-1", displayName: "Dallas Rep" },
      { id: "rep-2", displayName: "Atlanta Rep" },
    ]);
  });
});
