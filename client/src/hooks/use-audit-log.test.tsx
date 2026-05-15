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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

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

describe("useAuditLog", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("loads rows before the async total count finishes", async () => {
    const countRequest = deferred<{ total: number }>();
    const snapshots: Array<ReturnType<typeof useAuditLog>> = [];

    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/admin/audit/entity-types")) {
        return Promise.resolve({ entityTypes: ["deals"] });
      }
      if (path.startsWith("/admin/audit/count")) {
        return countRequest.promise;
      }
      if (path.startsWith("/admin/audit?")) {
        return Promise.resolve({
          rows: [{
            type: "single",
            id: 1,
            actorLabel: "Kevin Scott",
            actorType: "user",
            action: "update",
            entityType: "deals",
            entityName: "Legacy Deal",
            occurredAt: "2026-05-15T18:00:00.000Z",
            fieldChanges: [],
            visibilityScope: "internal",
          }],
          hasMore: true,
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

    const preCountSnapshot = snapshots[snapshots.length - 1];
    expect(preCountSnapshot?.loading).toBe(false);
    expect(preCountSnapshot?.rows).toHaveLength(1);
    expect(preCountSnapshot?.total).toBeNull();
    expect(preCountSnapshot?.totalLoading).toBe(true);

    await act(async () => {
      countRequest.resolve({ total: 105244 });
      await flushEffects();
    });

    const postCountSnapshot = snapshots[snapshots.length - 1];
    expect(postCountSnapshot?.total).toBe(105244);
    expect(postCountSnapshot?.totalLoading).toBe(false);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });

  it("ignores stale total-count responses after the filter changes", async () => {
    const firstCountRequest = deferred<{ total: number }>();
    const secondCountRequest = deferred<{ total: number }>();
    const snapshots: Array<ReturnType<typeof useAuditLog>> = [];

    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/admin/audit/entity-types")) {
        return Promise.resolve({ entityTypes: ["deals", "tasks"] });
      }
      if (path === "/admin/audit/count?") {
        return firstCountRequest.promise;
      }
      if (path === "/admin/audit/count?entityType=tasks") {
        return secondCountRequest.promise;
      }
      if (path.startsWith("/admin/audit?entityType=tasks")) {
        return Promise.resolve({ rows: [], hasMore: false });
      }
      if (path.startsWith("/admin/audit?")) {
        return Promise.resolve({
          rows: [{
            type: "single",
            id: 1,
            actorLabel: "Kevin Scott",
            actorType: "user",
            action: "update",
            entityType: "deals",
            entityName: "Legacy Deal",
            occurredAt: "2026-05-15T18:00:00.000Z",
            fieldChanges: [],
            visibilityScope: "internal",
          }],
          hasMore: true,
        });
      }
      throw new Error(`Unexpected path ${path}`);
    });

    let latestState: ReturnType<typeof useAuditLog> | null = null;

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
      latestState?.setFilter((current) => ({ ...current, entityType: "tasks" }));
      await flushEffects();
    });

    await act(async () => {
      secondCountRequest.resolve({ total: 7 });
      await flushEffects();
    });

    await act(async () => {
      firstCountRequest.resolve({ total: 105244 });
      await flushEffects();
    });

    const finalSnapshot = snapshots[snapshots.length - 1];
    expect(finalSnapshot?.filter.entityType).toBe("tasks");
    expect(finalSnapshot?.total).toBe(7);
    expect(finalSnapshot?.totalLoading).toBe(false);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });
});
