// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuditLog } from "./use-audit-log";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

function flushEffects() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function HookProbe({
  onSnapshot,
}: {
  onSnapshot: (snapshot: ReturnType<typeof useAuditLog>) => void;
}) {
  const state = useAuditLog();
  onSnapshot(state);
  return null;
}

function feedRow(id: number) {
  return {
    type: "single" as const,
    id,
    actorLabel: "Kevin Scott",
    actorType: "user" as const,
    action: "update",
    entityType: "deals",
    entityName: `Deal ${id}`,
    occurredAt: "2026-05-15T18:00:00.000Z",
    fieldChanges: [],
    visibilityScope: "internal" as const,
  };
}

describe("useAuditLog", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("loads the first bounded audit page without requesting an exact total count", async () => {
    const snapshots: Array<ReturnType<typeof useAuditLog>> = [];

    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/admin/audit/entity-types")) {
        return Promise.resolve({ entityTypes: ["deals"] });
      }
      if (path.startsWith("/admin/audit/count")) {
        throw new Error("count endpoint should not be used");
      }
      if (path.startsWith("/admin/audit?")) {
        return Promise.resolve({
          rows: [feedRow(1)],
          hasMore: true,
          nextCursor: "cursor-page-2",
        });
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(<HookProbe onSnapshot={(snapshot) => snapshots.push(snapshot)} />);
      await flushEffects();
    });

    const finalSnapshot = snapshots[snapshots.length - 1];
    expect(finalSnapshot?.loading).toBe(false);
    expect(finalSnapshot?.rows).toHaveLength(1);
    expect(finalSnapshot?.hasMore).toBe(true);
    expect(finalSnapshot?.total).toBeNull();
    expect(finalSnapshot?.totalLoading).toBe(false);
    expect(apiMock.mock.calls.some(([path]) => String(path).startsWith("/admin/audit/count"))).toBe(false);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });

  it("uses the returned cursor when moving to the next page", async () => {
    const snapshots: Array<ReturnType<typeof useAuditLog>> = [];
    let latestState: ReturnType<typeof useAuditLog> | null = null;

    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/admin/audit/entity-types")) {
        return Promise.resolve({ entityTypes: ["deals"] });
      }
      if (path === "/admin/audit?page=1&limit=50") {
        return Promise.resolve({ rows: [feedRow(1)], hasMore: true, nextCursor: "cursor-page-2" });
      }
      if (path === "/admin/audit?page=2&limit=50&cursor=cursor-page-2") {
        return Promise.resolve({ rows: [feedRow(2)], hasMore: false, nextCursor: null });
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(<HookProbe onSnapshot={(snapshot) => {
        latestState = snapshot;
        snapshots.push(snapshot);
      }} />);
      await flushEffects();
    });

    await act(async () => {
      latestState?.setPage(2);
      await flushEffects();
    });

    const finalSnapshot = snapshots[snapshots.length - 1];
    expect(finalSnapshot?.page).toBe(2);
    expect(finalSnapshot?.rows[0]?.id).toBe(2);
    expect(apiMock).toHaveBeenCalledWith("/admin/audit?page=2&limit=50&cursor=cursor-page-2");

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });

  it("resets to the first cursor window when filters change", async () => {
    const snapshots: Array<ReturnType<typeof useAuditLog>> = [];
    let latestState: ReturnType<typeof useAuditLog> | null = null;

    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/admin/audit/entity-types")) {
        return Promise.resolve({ entityTypes: ["deals", "tasks"] });
      }
      if (path === "/admin/audit?page=1&limit=50") {
        return Promise.resolve({ rows: [feedRow(1)], hasMore: true, nextCursor: "cursor-page-2" });
      }
      if (path === "/admin/audit?page=2&limit=50&cursor=cursor-page-2") {
        return Promise.resolve({ rows: [feedRow(2)], hasMore: true, nextCursor: "cursor-page-3" });
      }
      if (path === "/admin/audit?page=1&limit=50&entityType=tasks") {
        return Promise.resolve({ rows: [], hasMore: false, nextCursor: null });
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(<HookProbe onSnapshot={(snapshot) => {
        latestState = snapshot;
        snapshots.push(snapshot);
      }} />);
      await flushEffects();
    });

    await act(async () => {
      latestState?.setPage(2);
      await flushEffects();
    });

    await act(async () => {
      latestState?.setFilter((current) => ({ ...current, entityType: "tasks" }));
      await flushEffects();
    });

    const finalSnapshot = snapshots[snapshots.length - 1];
    expect(finalSnapshot?.page).toBe(1);
    expect(finalSnapshot?.filter.entityType).toBe("tasks");
    expect(apiMock).toHaveBeenCalledWith("/admin/audit?page=1&limit=50&entityType=tasks");

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });
});
