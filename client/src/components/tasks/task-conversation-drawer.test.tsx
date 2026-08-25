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
const STRANGER = "user-nobody";

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
    canComment: true,
    loading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    ...extra,
  });
}

/** Switch to the History tab. */
function openHistoryTab() {
  const tabs = [...container.querySelectorAll<HTMLElement>('button[role="tab"]')];
  const history = tabs.find((t) => t.textContent?.includes("History"))!;
  act(() => history.dispatchEvent(new MouseEvent("click", { bubbles: true })));
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

  // The acknowledgement is a claim that a specific person SAW something. Recording it while the
  // conversation is not even on screen is the one guarantee this feature sells.
  it("does NOT acknowledge while the History tab is showing", async () => {
    setComments([comment()]);
    await act(async () => { render(); });
    expect(mocks.ackTaskRepliesMock).toHaveBeenCalledTimes(1);

    mocks.ackTaskRepliesMock.mockClear();
    openHistoryTab();
    setComments([comment(), comment({ id: "c2", createdAt: "2026-05-01T12:00:00.000Z" })]);
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

describe("what the UI is allowed to claim", () => {
  // The assignee's own replies are not "new replies" TO THEM — they wrote them. The badge is an
  // assigner-only indicator, exactly as the list row already treats it.
  it("shows the unread count to the assigner and not to the assignee", () => {
    setComments([comment(), comment({ id: "c2" })]);
    render();
    expect(container.textContent).toContain("2 new replies");

    act(() => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => { root = createRoot(container); });
    render({ currentUserId: ASSIGNEE });
    expect(container.textContent).not.toContain("new replies");
  });

  // completeTask only moves pending/in_progress/waiting_on/blocked, and the transition table has no
  // scheduled -> completed edge. Offering the button anyway produces a misleading "already completed
  // or dismissed" error on every click.
  it("hides Mark complete when the server says the viewer may not close the task", () => {
    setComments([]);
    render({ task: { ...task, canClose: false } as any });
    expect(container.textContent).not.toContain("Mark complete");
  });

  it("offers Mark complete only for statuses the API will actually accept", () => {
    for (const status of ["pending", "in_progress", "waiting_on", "blocked"]) {
      setComments([]);
      render({ task: { ...task, status } as any });
      expect(container.textContent, status).toContain("Mark complete");
    }
    for (const status of ["scheduled", "completed", "dismissed"]) {
      setComments([]);
      render({ task: { ...task, status } as any });
      expect(container.textContent, status).not.toContain("Mark complete");
    }
  });

  // Construction and field_contractor users can OPEN any task in the office but may not speak on one
  // they are unrelated to. The server answers this; the composer must not offer a Send it will 403.
  it("hides the composer when the server says the viewer cannot comment", () => {
    setComments([], { canComment: false });
    render({ currentUserId: STRANGER });

    expect(container.querySelector("#task-reply-composer")).toBeNull();
    expect(container.textContent).toContain("cannot reply");
  });

  it("shows the composer when the viewer may comment", () => {
    setComments([], { canComment: true });
    render();
    expect(container.querySelector("#task-reply-composer")).not.toBeNull();
  });

  // "Nothing has happened yet" and "we could not load the history" are different facts, and rendering
  // the first when the second is true is an authoritative-looking lie.
  it("surfaces a timeline failure instead of claiming an empty history", () => {
    mocks.useTaskTimelineMock.mockReturnValue({
      entries: [], loading: false, error: "Failed to load the timeline", refetch: vi.fn(),
    });
    setComments([]);
    render();
    openHistoryTab();

    expect(container.textContent).toContain("Failed to load the timeline");
    expect(container.textContent).not.toContain("Nothing has happened yet");
  });

  // The summary already says "(+N more)". Saying it and then providing no way to see them is worse
  // than not mentioning them.
  it("renders the field changes an audit entry reports", () => {
    mocks.useTaskTimelineMock.mockReturnValue({
      entries: [{
        id: "audit:1", kind: "audit", occurredAt: "2026-05-01T09:00:00.000Z",
        actorId: ASSIGNER, actorLabel: "Adam Shaw", actorType: "user", action: "update",
        summary: "Adam Shaw changed Priority from normal to urgent (+1 more)", body: null,
        fieldChanges: [
          { key: "priority", label: "Priority", fromDisplay: "normal", toDisplay: "urgent", transition: "changed" },
          { key: "due_date", label: "Due date", fromDisplay: null, toDisplay: "2026-05-09", transition: "set" },
        ],
      }],
      loading: false, error: null, refetch: vi.fn(),
    });
    setComments([]);
    render();
    openHistoryTab();

    expect(container.textContent).toContain("Due date");
    expect(container.textContent).toContain("2026-05-09");
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

// The reply email's second CTA. A dead affordance in an accountability feature is worse than none:
// the assigner clicks it, believes the loop is closed, and it is not.
describe("the emailed Mark complete CTA", () => {
  it("focuses and highlights the completion action when opened with ?complete=1", async () => {
    setComments([]);
    await act(async () => { render({ completeRequested: true }); });

    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Mark complete")
    )!;
    expect(button.getAttribute("data-complete-requested")).toBe("true");
    expect(document.activeElement).toBe(button);
  });

  // It must NOT complete on its own: a link in an email is a GET, and a GET that mutates is one
  // mail-scanner prefetch away from closing tasks nobody touched.
  it("does not complete the task on its own", async () => {
    setComments([]);
    await act(async () => { render({ completeRequested: true }); });
    expect(mocks.completeTaskMock).not.toHaveBeenCalled();
  });

  it("leaves the button unfocused on an ordinary open", async () => {
    setComments([]);
    await act(async () => { render(); });
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Mark complete")
    )!;
    expect(button.getAttribute("data-complete-requested")).toBe("false");
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

// The drawer is ONE component instance reused for every task the list opens. Everything below is the
// same defect wearing different clothes: state that belongs to a task outliving the task.
//
// The acknowledgement case is the one with teeth. `renderedUpTo` is derived from whatever comments are
// in state and posted against `task.id`, so during the window where the drawer has swung to B and B's
// comments have not landed, it will post A's timestamp against B — and the server accepts it, because
// A's timestamp is a perfectly valid one. The assigner is then recorded as having read replies that
// were never on screen, which is the single guarantee this whole feature sells.
describe("switching to another task", () => {
  const otherTask = { ...task, id: "task-2", title: "Order the dumpster" } as any;

  function typeDraft(text: string) {
    const textarea = container.querySelector<HTMLTextAreaElement>("#task-reply-composer")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("clears a draft typed against the previous task", () => {
    setComments([]);
    render();
    typeDraft("the north slope is still open, do not send the client photos yet");
    expect(container.querySelector<HTMLTextAreaElement>("#task-reply-composer")!.value).toContain(
      "north slope"
    );

    render({ task: otherTask });

    // Otherwise Send posts one task's text — which is exactly where the sensitive sentence lives —
    // into another task's thread.
    expect(container.querySelector<HTMLTextAreaElement>("#task-reply-composer")!.value).toBe("");
  });

  // Reached through the FAILED-ack path, which the drawer handles deliberately: a failed
  // acknowledgement clears `ackedRef` so it can be retried. That is correct on its own, and it also
  // removes the only thing standing between a stale thread and a wrong-task acknowledgement.
  //
  // (Written the obvious way first — same comment on both tasks — this passed, because `ackedRef`
  // still held that timestamp and the effect early-returned. It was not acking the wrong task, but
  // only by accident. A test that passes because of an unrelated guard proves nothing about this one.)
  it("does not acknowledge the new task using the previous task's comments", async () => {
    mocks.ackTaskRepliesMock.mockRejectedValueOnce(new Error("offline"));
    setComments([comment({ id: "c1", taskId: "task-1", createdAt: "2026-05-01T11:00:00.000Z" })]);
    await act(async () => { render(); });
    expect(mocks.ackTaskRepliesMock).toHaveBeenCalledWith("task-1", "2026-05-01T11:00:00.000Z");
    mocks.ackTaskRepliesMock.mockClear().mockResolvedValue({ acknowledged: true });

    // The drawer swings to task-2 while the hook is still holding task-1's thread — the ordinary
    // in-flight state, not a race. Nothing in view belongs to task-2.
    setComments([comment({ id: "c1", taskId: "task-1", createdAt: "2026-05-01T11:00:00.000Z" })], {
      loading: true,
    });
    await act(async () => { render({ task: otherTask }); });

    expect(mocks.ackTaskRepliesMock).not.toHaveBeenCalledWith("task-2", expect.anything());
  });

  it("still acknowledges the new task when its newest reply shares a timestamp with the last one", async () => {
    const sharedStamp = "2026-05-01T11:00:00.000Z";
    setComments([comment({ id: "c1", taskId: "task-1", createdAt: sharedStamp })]);
    await act(async () => { render(); });
    expect(mocks.ackTaskRepliesMock).toHaveBeenCalledWith("task-1", sharedStamp);
    mocks.ackTaskRepliesMock.mockClear();

    // `ackedRef` guards against re-posting the same thread head. Keyed to the timestamp alone it also
    // swallows a DIFFERENT task whose head happens to match — two replies a minute apart round to the
    // same second often enough for this to be real.
    setComments([comment({ id: "c9", taskId: "task-2", createdAt: sharedStamp })]);
    await act(async () => { render({ task: otherTask }); });

    expect(mocks.ackTaskRepliesMock).toHaveBeenCalledWith("task-2", sharedStamp);
  });
});
