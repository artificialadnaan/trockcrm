// @vitest-environment jsdom

// The "Needs your attention" bucket — the direct answer to "Adam assigns tasks and then forgets what
// he assigned".
//
// These tasks are assigned to somebody ELSE, so they appear NOWHERE in the assigner's own list:
// /tasks scopes reps to `assigned_to = me`. That is why the bucket is a separate endpoint and not a
// filter, and why the tests below assert on the REQUEST as well as on the render — a bucket fed from
// the ordinary list query would be permanently empty and look fine.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => apiMock(...args) }));

const mocks = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ useAuth: mocks.useAuthMock }));
vi.mock("@/hooks/use-task-assignees", () => ({ useTaskAssignees: mocks.useTaskAssigneesMock }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/tasks/task-create-dialog", () => ({ TaskCreateDialog: () => null }));
vi.mock("@/components/tasks/task-edit-dialog", () => ({ TaskEditDialog: () => null }));
vi.mock("@/components/tasks/task-conversation-drawer", () => ({
  TaskConversationDrawer: ({ task }: { task: { title: string } }) => (
    <div data-testid="drawer">{task.title}</div>
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...(props as any)}>{children}</button>
  ),
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/shared/scope-toggle", () => ({ ScopeToggle: () => null }));
vi.mock("@/components/shared/metric-card", () => ({ MetricCard: () => null }));

const { TaskListPage } = await import("./task-list-page");

const ASSIGNER = "user-adam";

function taskFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Send the roof photos",
    description: null,
    type: "manual",
    priority: "normal",
    status: "pending",
    source: "manual",
    assignedTo: "user-derek",
    assignedToName: "Derek Barr",
    createdBy: ASSIGNER,
    dealId: null,
    contactId: null,
    emailId: null,
    dueDate: null,
    dueTime: null,
    remindAt: null,
    scheduledFor: null,
    waitingOn: null,
    blockedBy: null,
    startedAt: null,
    completedAt: null,
    isOverdue: false,
    createdAt: "2026-05-01T09:00:00.000Z",
    updatedAt: "2026-05-01T09:00:00.000Z",
    lastReplyAt: "2026-05-01T10:00:00.000Z",
    lastReplyBy: "user-derek",
    lastReplyByName: "Derek Barr",
    lastReplyBody: "On my way",
    assignerAckAt: null,
    unreadReplyCount: 2,
    ...overrides,
  };
}

const EMPTY_LIST = { tasks: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } };
const EMPTY_COUNTS = {
  counts: {
    overdue: 0, today: 0, upcoming: 0, completed: 0, completedThisWeek: 0,
    bySource: { manual: 0, automated: 0, all: 0 },
  },
};

/** Route every /tasks request; `awaitingMe` decides what the new endpoint returns. */
function mockApi(awaitingMe: unknown[]) {
  apiMock.mockImplementation(async (url: string) => {
    if (url.startsWith("/tasks/awaiting-me")) return { tasks: awaitingMe };
    if (url.startsWith("/tasks/counts")) return EMPTY_COUNTS;
    return EMPTY_LIST;
  });
}

let container: HTMLDivElement;
let root: Root | null;
/** Live view of the router location, so a navigation can be asserted on. */
const locationRef = { pathname: "", search: "" };

function LocationProbe() {
  const location = useLocation();
  locationRef.pathname = location.pathname;
  locationRef.search = location.search;
  return null;
}

const flush = async () => {
  await act(async () => {});
};

function renderPage(path = "/tasks") {
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route path="/tasks" element={<TaskListPage />} />
          <Route path="/tasks/:taskId" element={<TaskListPage />} />
        </Routes>
      </MemoryRouter>
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  apiMock.mockReset();
  mocks.useAuthMock.mockReturnValue({
    user: { id: ASSIGNER, role: "rep", displayName: "Adam Shaw" },
    loading: false,
  });
  mocks.useTaskAssigneesMock.mockReturnValue({ assignees: [], loading: false });
});

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

describe("Needs your attention", () => {
  it("fetches the dedicated endpoint, not a filtered task list", async () => {
    mockApi([]);
    renderPage();
    await flush();

    expect(apiMock.mock.calls.some(([url]) => String(url) === "/tasks/awaiting-me")).toBe(true);
  });

  it("renders a task somebody else is assigned, with its unread reply count", async () => {
    mockApi([taskFixture()]);
    renderPage();
    await flush();

    const bucket = container.querySelector('[data-testid="needs-attention-group"]')!;
    expect(bucket).not.toBeNull();
    expect(bucket.textContent).toContain("Send the roof photos");
    expect(bucket.textContent).toContain("2 replies");
    expect(bucket.textContent).toContain("Derek Barr");
  });

  it("singularises a single reply", async () => {
    mockApi([taskFixture({ unreadReplyCount: 1 })]);
    renderPage();
    await flush();

    const bucket = container.querySelector('[data-testid="needs-attention-group"]')!;
    expect(bucket.textContent).toContain("1 reply");
    expect(bucket.textContent).not.toContain("1 replies");
  });

  // A permanently-present empty section trains people to stop looking at it, and this one is only
  // ever useful when it has something in it.
  it("is absent entirely when nothing is waiting", async () => {
    mockApi([]);
    renderPage();
    await flush();

    expect(container.querySelector('[data-testid="needs-attention-group"]')).toBeNull();
  });

  // The affordance is only meaningful to the ASSIGNER. On the assignee's own buckets it would be
  // telling them about their own reply, so the ordinary date buckets never pass showUnreadReplies.
  it("does not render the unread affordance in the ordinary date buckets", async () => {
    apiMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/tasks/awaiting-me")) return { tasks: [] };
      if (url.startsWith("/tasks/counts")) return EMPTY_COUNTS;
      if (url.includes("section=overdue")) {
        return {
          tasks: [taskFixture({ id: "own-1", title: "My own task", unreadReplyCount: 5 })],
          pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
        };
      }
      return EMPTY_LIST;
    });
    renderPage();
    await flush();

    expect(container.textContent).toContain("My own task");
    expect(container.textContent).not.toContain("5 replies");
  });
});

// SILENCE AND ZERO MUST NOT RENDER THE SAME. NeedsAttentionGroup hides itself when empty, so a failed
// /tasks/awaiting-me rendered exactly like "nothing needs you" — Adam is told he is clear when the
// truth is that we could not find out.
describe("when the attention bucket cannot be loaded", () => {
  it("says so instead of rendering as though nothing is waiting", async () => {
    apiMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/tasks/awaiting-me")) throw new Error("Failed to load replies awaiting you");
      if (url.startsWith("/tasks/counts")) return EMPTY_COUNTS;
      return EMPTY_LIST;
    });
    renderPage();
    await flush();

    expect(container.textContent).toContain("Failed to load replies awaiting you");
    // ...and it must not silently render the "nothing waiting" shape.
    expect(container.querySelector('[data-testid="needs-attention-group"]')).toBeNull();
  });

  it("stays quiet when the bucket is genuinely empty", async () => {
    mockApi([]);
    renderPage();
    await flush();

    expect(container.textContent).not.toContain("Failed to load replies awaiting you");
  });
});

// Opening a conversation from a filtered list and closing it must return to that list, not to an
// unfiltered one — the whole reason this is a drawer over the list rather than a separate page.
describe("triage context is preserved", () => {
  it("keeps the active filters in the URL when opening a conversation", async () => {
    apiMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/tasks/awaiting-me")) return { tasks: [] };
      if (url.startsWith("/tasks/counts")) return EMPTY_COUNTS;
      if (url.includes("section=overdue")) {
        return {
          tasks: [taskFixture({ id: "own-1", title: "Filtered task" })],
          pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
        };
      }
      return EMPTY_LIST;
    });
    renderPage("/tasks?source=manual&assignee=user-derek");
    await flush();

    const open = container.querySelector<HTMLElement>(
      'button[aria-label="Open the conversation for Filtered task"]'
    )!;
    await act(async () => {
      open.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(locationRef.pathname).toBe("/tasks/own-1");
    expect(locationRef.search).toContain("source=manual");
    expect(locationRef.search).toContain("assignee=user-derek");
  });
});

describe("/tasks/:taskId", () => {
  // C7: this route rendered one TaskRow in a "Linked task" banner. Both of the feature's emails
  // deep-link here, so it has to be the detail surface.
  it("renders the conversation drawer, not the old linked-task banner", async () => {
    apiMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/tasks/awaiting-me")) return { tasks: [] };
      if (url.startsWith("/tasks/counts")) return EMPTY_COUNTS;
      if (url === "/tasks/task-1") return { task: taskFixture() };
      return EMPTY_LIST;
    });
    renderPage("/tasks/task-1");
    await flush();

    expect(container.querySelector('[data-testid="drawer"]')?.textContent).toBe(
      "Send the roof photos"
    );
    expect(container.textContent).not.toContain("Linked task");
  });

  it("renders no drawer on the bare list route", async () => {
    mockApi([]);
    renderPage();
    await flush();

    expect(container.querySelector('[data-testid="drawer"]')).toBeNull();
  });
});
