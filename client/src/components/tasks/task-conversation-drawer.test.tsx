// @vitest-environment jsdom

// The conversation drawer is the task DETAIL surface — /tasks/:taskId rendered one TaskRow in a
// banner before this, and both of the feature's emails deep-link here.
//
// The acknowledgement test is the one that carries weight. The drawer must send the timestamp it
// actually RENDERED, never Date.now(): sending now() re-creates the lost update the whole ack model
// exists to close (a reply that lands between the render and the acknowledgement gets marked read by
// somebody who never saw it), and it makes the server's comparison unreachable.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { TaskConversationDrawer } from "./task-conversation-drawer";

const mocks = vi.hoisted(() => ({
  ackTaskRepliesMock: vi.fn(),
  completeTaskMock: vi.fn(),
  postTaskCommentMock: vi.fn(),
  useTaskCommentsMock: vi.fn(),
  useTaskTimelineMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/hooks/use-tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-tasks")>()),
  ackTaskReplies: mocks.ackTaskRepliesMock,
  completeTask: mocks.completeTaskMock,
  postTaskComment: mocks.postTaskCommentMock,
  useTaskComments: mocks.useTaskCommentsMock,
  useTaskTimeline: mocks.useTaskTimelineMock,
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastErrorMock } }));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...(props as any)}>{children}</button>
  ),
}));

const ASSIGNER = "user-adam";
const ASSIGNEE = "user-derek";

const task = {
  id: "task-1",
  title: "Send the roof photos",
  status: "pending",
  assignedTo: ASSIGNEE,
  assignedToName: "Derek Barr",
  createdBy: ASSIGNER,
} as any;

const liveLoop = {
  assignerId: ASSIGNER,
  assignerName: "Adam Shaw",
  assignerIsActive: true,
  notifiesAssigner: true,
  reason: "ok" as const,
};

function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    taskId: "task-1",
    authorId: ASSIGNEE,
    authorName: "Derek Barr",
    body: "On my way",
    kind: "reply",
    createdAt: "2026-05-01T10:00:00.000Z",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(props: Partial<Parameters<typeof TaskConversationDrawer>[0]> = {}) {
  act(() => {
    root.render(
      <TaskConversationDrawer
        task={task}
        currentUserId={ASSIGNER}
        onClose={() => {}}
        onChanged={() => {}}
        {...props}
      />
    );
  });
}

function setComments(comments: unknown[], extra: Record<string, unknown> = {}) {
  mocks.useTaskCommentsMock.mockReturnValue({
    comments,
    loop: liveLoop,
    unreadReplyCount: comments.length,
    loading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    ...extra,
  });
}

function click(selector: string) {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`no element for ${selector}`);
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  mocks.ackTaskRepliesMock.mockReset().mockResolvedValue({ acknowledged: true });
  mocks.postTaskCommentMock.mockReset().mockResolvedValue({ comment: comment(), loop: liveLoop });
  mocks.completeTaskMock.mockReset().mockResolvedValue({});
  mocks.toastErrorMock.mockReset();
  mocks.useTaskTimelineMock.mockReset().mockReturnValue({
    entries: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  setComments([]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the conversation", () => {
  it("renders every comment with its author and body", () => {
    setComments([
      comment({ id: "c1", body: "On my way", authorName: "Derek Barr" }),
      comment({ id: "c2", body: "Thanks", authorName: "Adam Shaw", kind: "note" }),
    ]);
    render();

    expect(container.textContent).toContain("On my way");
    expect(container.textContent).toContain("Derek Barr");
    expect(container.textContent).toContain("Thanks");
    expect(container.textContent).toContain("Adam Shaw");
  });

  it("renders a comment with no recorded author as System", () => {
    setComments([comment({ authorId: null, authorName: null, kind: "system", body: "Auto-closed" })]);
    render();
    expect(container.textContent).toContain("System");
  });

  it("says so when the thread is empty rather than rendering nothing", () => {
    setComments([]);
    render();
    expect(container.textContent).toContain("No replies yet.");
  });
});

describe("the composer", () => {
  it("cannot submit an empty or whitespace-only body", () => {
    render();
    const send = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(send.disabled).toBe(true);

    const textarea = container.querySelector<HTMLTextAreaElement>("#task-reply-composer")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "   ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });

  it("posts the reply and clears the box", async () => {
    render();
    const textarea = container.querySelector<HTMLTextAreaElement>("#task-reply-composer")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Photos are up");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);

    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.postTaskCommentMock).toHaveBeenCalledWith("task-1", "Photos are up");
    expect(container.querySelector<HTMLTextAreaElement>("#task-reply-composer")!.value).toBe("");
  });

  it("trims the body before posting", async () => {
    render();
    const textarea = container.querySelector<HTMLTextAreaElement>("#task-reply-composer")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "  done  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.postTaskCommentMock).toHaveBeenCalledWith("task-1", "done");
  });
});

// C6 — the loop is dead for every rules-engine and AI-disconnect task, and for a departed assigner.
// Saying so is the difference between "recorded here" and "sent to nobody, silently".
describe("the dead-loop notice", () => {
  it("says nobody is notified when the task has no assigner", () => {
    setComments([], {
      loop: { ...liveLoop, assignerId: null, notifiesAssigner: false, reason: "no_assigner" },
    });
    render();
    expect(container.textContent).toContain("created by the system");
    expect(container.textContent).toContain("still recorded here");
  });

  it("names the departed assigner when they are no longer active", () => {
    setComments([], {
      loop: { ...liveLoop, assignerIsActive: false, notifiesAssigner: false, reason: "assigner_inactive" },
    });
    render();
    expect(container.textContent).toContain("Adam Shaw is no longer active");
  });

  it("shows no notice at all on a live loop", () => {
    setComments([comment()]);
    render();
    expect(container.textContent).not.toContain("no longer active");
    expect(container.textContent).not.toContain("nobody is notified");
  });

  // The reply is still a record even when nothing is sent — disabling the composer would throw that
  // away, which is a worse answer than an honest notice.
  it("leaves the composer usable when the loop is dead", () => {
    setComments([], {
      loop: { ...liveLoop, assignerId: null, notifiesAssigner: false, reason: "no_assigner" },
    });
    render();
    expect(container.querySelector<HTMLTextAreaElement>("#task-reply-composer")!.disabled).toBe(false);
  });
});

describe("acknowledgement", () => {
  // THE ONE THAT MATTERS: the RENDERED timestamp, not now().
  it("acknowledges up to the newest RENDERED reply", async () => {
    setComments([
      comment({ id: "c1", createdAt: "2026-05-01T10:00:00.000Z" }),
      comment({ id: "c2", createdAt: "2026-05-01T11:00:00.000Z" }),
    ]);
    await act(async () => { render(); });

    expect(mocks.ackTaskRepliesMock).toHaveBeenCalledWith("task-1", "2026-05-01T11:00:00.000Z");
    // Not "some timestamp near now" — the exact one on screen.
    const sent = mocks.ackTaskRepliesMock.mock.calls[0]![1];
    expect(Math.abs(new Date(sent).getTime() - Date.now())).toBeGreaterThan(1000);
  });

  it("ignores notes when choosing the acknowledgement point", async () => {
    setComments([
      comment({ id: "c1", kind: "reply", createdAt: "2026-05-01T10:00:00.000Z" }),
      comment({ id: "c2", kind: "note", createdAt: "2026-05-01T12:00:00.000Z", authorId: ASSIGNER }),
    ]);
    await act(async () => { render(); });
    expect(mocks.ackTaskRepliesMock).toHaveBeenCalledWith("task-1", "2026-05-01T10:00:00.000Z");
  });

  // The acknowledgement is a statement about a specific person; the ASSIGNEE opening their own task
  // must not clear it out of the assigner's bucket.
  it("does NOT acknowledge when the viewer is not the assigner", async () => {
    setComments([comment()]);
    await act(async () => { render({ currentUserId: ASSIGNEE }); });
    expect(mocks.ackTaskRepliesMock).not.toHaveBeenCalled();
  });

  it("acknowledges nothing on a thread with no replies", async () => {
    setComments([]);
    await act(async () => { render(); });
    expect(mocks.ackTaskRepliesMock).not.toHaveBeenCalled();
  });

  it("does not re-acknowledge the same thread head on a re-render", async () => {
    setComments([comment()]);
    await act(async () => { render(); });
    await act(async () => { render(); });
    expect(mocks.ackTaskRepliesMock).toHaveBeenCalledTimes(1);
  });
});

describe("the history tab", () => {
  it("renders merged timeline entries in the order the server returned them", () => {
    mocks.useTaskTimelineMock.mockReturnValue({
      entries: [
        {
          id: "audit:1", kind: "audit", occurredAt: "2026-05-01T09:00:00.000Z",
          actorId: null, actorLabel: "System", actorType: "system", action: "insert",
          summary: "System created this task", body: null, fieldChanges: [],
        },
        {
          id: "comment:1", kind: "comment", occurredAt: "2026-05-01T10:00:00.000Z",
          actorId: ASSIGNEE, actorLabel: "Derek Barr", actorType: "user", action: "reply",
          summary: "Derek Barr replied", body: "On my way", fieldChanges: [],
        },
      ],
      loading: false, error: null, refetch: vi.fn(),
    });
    render();
    click('button[role="tab"][aria-selected="false"]');

    const text = container.textContent ?? "";
    expect(text).toContain("System created this task");
    expect(text).toContain("Derek Barr replied");
    expect(text.indexOf("System created this task")).toBeLessThan(text.indexOf("Derek Barr replied"));
  });
});

describe("close from the drawer", () => {
  it("completes the task and closes", async () => {
    const onClose = vi.fn();
    const onChanged = vi.fn();
    setComments([]);
    render({ onClose, onChanged });

    await act(async () => {
      const complete = [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Mark complete")
      )!;
      complete.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.completeTaskMock).toHaveBeenCalledWith("task-1");
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("offers no complete action on an already-terminal task", () => {
    setComments([]);
    render({ task: { ...task, status: "completed" } as any });
    expect(container.textContent).not.toContain("Mark complete");
  });
});
