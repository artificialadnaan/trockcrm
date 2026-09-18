// @vitest-environment jsdom

// A superseded response must not overwrite a newer one.
//
// This is not a cosmetic race. The drawer's acknowledgement effect derives `seenUpTo` from whatever
// comments are in state: if task A's slow response lands after the drawer has switched to task B, the
// thread shown belongs to A while the acknowledgement is POSTed against B — recording B's assigner as
// having read replies that were never on screen. `useTasks` and `useTaskCounts` already carry a
// request-generation guard for exactly this reason; these two hooks were missing it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => apiMock(...args) }));

const { useTaskComments, useTaskTimeline } = await import("./use-tasks");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function commentsFor(taskId: string) {
  return {
    comments: [
      {
        id: `${taskId}-c1`,
        taskId,
        authorId: "u1",
        authorName: "Derek Barr",
        body: `reply on ${taskId}`,
        kind: "reply",
        createdAt: "2026-05-01T10:00:00.000Z",
      },
    ],
    loop: {
      assignerId: "u2", assignerName: "Adam Shaw", assignerIsActive: true,
      notifiesAssigner: true, reason: "ok",
    },
    unreadReplyCount: 1,
    canComment: true,
  };
}

function CommentsHarness({ taskId }: { taskId: string }) {
  const { comments, canComment } = useTaskComments(taskId);
  return (
    <div data-testid="out">
      {comments.map((c) => c.body).join(",")}|{String(canComment)}
    </div>
  );
}

function TimelineHarness({ taskId }: { taskId: string }) {
  const { entries } = useTaskTimeline(taskId);
  return <div data-testid="out">{entries.map((e) => e.id).join(",")}</div>;
}

let container: HTMLDivElement;
let root: Root | null;

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

describe("useTaskComments", () => {
  it("reports canComment from the server rather than re-deriving it", async () => {
    apiMock.mockResolvedValue({ ...commentsFor("task-a"), canComment: false });
    act(() => {
      root = createRoot(container);
      root.render(<CommentsHarness taskId="task-a" />);
    });
    await act(async () => {});

    expect(container.querySelector('[data-testid="out"]')!.textContent).toContain("|false");
  });

  // THE ONE THAT MATTERS.
  it("ignores a slow response for the PREVIOUS task", async () => {
    const slowA = deferred<unknown>();
    apiMock.mockImplementation(async (url: string) =>
      url.includes("task-a") ? slowA.promise : commentsFor("task-b")
    );

    act(() => {
      root = createRoot(container);
      root.render(<CommentsHarness taskId="task-a" />);
    });
    await act(async () => {});

    // Switch to task B, whose response lands first.
    act(() => { root!.render(<CommentsHarness taskId="task-b" />); });
    await act(async () => {});
    expect(container.textContent).toContain("reply on task-b");

    // Task A's response finally arrives — and must be discarded.
    await act(async () => { slowA.resolve(commentsFor("task-a")); });

    expect(container.textContent).toContain("reply on task-b");
    expect(container.textContent).not.toContain("reply on task-a");
  });

  it("clears the thread when the drawer closes", async () => {
    apiMock.mockResolvedValue(commentsFor("task-a"));
    act(() => {
      root = createRoot(container);
      root.render(<CommentsHarness taskId="task-a" />);
    });
    await act(async () => {});
    expect(container.textContent).toContain("reply on task-a");

    act(() => { root!.render(<CommentsHarness taskId={undefined as unknown as string} />); });
    await act(async () => {});
    expect(container.textContent).not.toContain("reply on task-a");
  });
});

describe("useTaskTimeline", () => {
  it("ignores a slow response for the PREVIOUS task", async () => {
    const slowA = deferred<unknown>();
    apiMock.mockImplementation(async (url: string) =>
      url.includes("task-a") ? slowA.promise : { entries: [{ id: "b1" }] }
    );

    act(() => {
      root = createRoot(container);
      root.render(<TimelineHarness taskId="task-a" />);
    });
    await act(async () => {});

    act(() => { root!.render(<TimelineHarness taskId="task-b" />); });
    await act(async () => {});
    expect(container.textContent).toBe("b1");

    await act(async () => { slowA.resolve({ entries: [{ id: "a1" }] }); });

    expect(container.textContent).toBe("b1");
  });
});
