// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { TaskListPage, getTaskProjectContext } from "./task-list-page";
import taskListPageSource from "./task-list-page.tsx?raw";
// The resolver moved to @/lib/task-project-context so the list row and the F4 detail drawer share
// ONE definition — a deep-linked task labelling its project differently from the same task in the
// list is exactly the card/drawer divergence this repo keeps re-learning. The behavioural assertions
// below are unchanged; only the file the source-shape assertions read had to follow the code.
import taskProjectContextSource from "@/lib/task-project-context.ts?raw";

const mocks = vi.hoisted(() => ({
  completeTaskMock: vi.fn(),
  getTaskStatusLabelMock: vi.fn((status: string) => status),
  isTerminalTaskStatusMock: vi.fn((status: string) => status === "completed" || status === "dismissed"),
  snoozeTaskMock: vi.fn(),
  toastErrorMock: vi.fn(),
  useAuthMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  useTaskCountsMock: vi.fn(),
  useTaskMock: vi.fn(),
  useTasksMock: vi.fn(),
  useTasksAwaitingMeMock: vi.fn(),
  useTaskCommentsMock: vi.fn(),
  useTaskTimelineMock: vi.fn(),
  ackTaskRepliesMock: vi.fn(),
}));

vi.mock("@/hooks/use-tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-tasks")>()),
  completeTask: mocks.completeTaskMock,
  getTaskStatusLabel: mocks.getTaskStatusLabelMock,
  isTerminalTaskStatus: mocks.isTerminalTaskStatusMock,
  snoozeTask: mocks.snoozeTaskMock,
  useTaskCounts: mocks.useTaskCountsMock,
  useTask: mocks.useTaskMock,
  useTasks: mocks.useTasksMock,
  // F4 closed loop. The page also drives the "Needs your attention" bucket and the detail drawer now;
  // mocked here so this suite keeps testing the LIST rather than starting to exercise the loop's
  // fetches through an unmocked api layer.
  useTasksAwaitingMe: mocks.useTasksAwaitingMeMock,
  useTaskComments: mocks.useTaskCommentsMock,
  useTaskTimeline: mocks.useTaskTimelineMock,
  ackTaskReplies: mocks.ackTaskRepliesMock,
}));

vi.mock("@/hooks/use-task-assignees", () => ({
  useTaskAssignees: mocks.useTaskAssigneesMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastErrorMock,
  },
}));

vi.mock("@/components/tasks/task-create-dialog", () => ({
  TaskCreateDialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/tasks/task-edit-dialog", () => ({
  TaskEditDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog">Edit task dialog</div> : null),
}));

vi.mock("@/components/tasks/task-resolution-dialog", () => ({
  TaskResolutionDialog: ({
    open,
    onResolve,
  }: {
    open: boolean;
    onResolve: (resolutionNote: string) => Promise<void>;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() => {
          void onResolve("Called the customer and confirmed the next step.").catch(() => {});
        }}
      >
        Save task outcome
      </button>
    ) : null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: ReactNode;
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="Assignee"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

function makeTask() {
  return {
    id: "task-1",
    title: "Call Palm Villas",
    description: null,
    type: "call",
    priority: "normal",
    status: "pending",
    assignedTo: "rep-1",
    assignedToName: "Brett Jones",
    createdBy: "director-1",
    dealId: "deal-1",
    dealName: "Palm Villas",
    dealNumber: "TR-2026-0001",
    contactId: null,
    emailId: null,
    dueDate: "2026-05-07",
    dueTime: null,
    remindAt: null,
    scheduledFor: null,
    waitingOn: null,
    blockedBy: null,
    startedAt: null,
    completedAt: null,
    isOverdue: true,
    createdAt: "2026-05-06T12:00:00.000Z",
    updatedAt: "2026-05-06T12:00:00.000Z",
  };
}

describe("TaskListPage project context", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mocks.completeTaskMock.mockReset();
    mocks.completeTaskMock.mockResolvedValue(undefined);
    mocks.snoozeTaskMock.mockReset();
    mocks.snoozeTaskMock.mockResolvedValue(undefined);
    mocks.toastErrorMock.mockReset();
    mocks.useAuthMock.mockReset();
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "director-1",
        email: "director@example.test",
        displayName: "Director User",
        role: "director",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
      loading: false,
    });
    mocks.useTaskAssigneesMock.mockReset();
    mocks.useTaskAssigneesMock.mockReturnValue({
      assignees: [
        { id: "rep-1", displayName: "Brett Jones" },
        { id: "rep-2", displayName: "Casey Smith" },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.useTaskCountsMock.mockReset();
    mocks.useTaskCountsMock.mockReturnValue({
      counts: { overdue: 1, today: 0, upcoming: 0, completed: 0, completedThisWeek: 0, bySource: { manual: 0, automated: 1, all: 1 } },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.useTasksAwaitingMeMock.mockReset();
    mocks.useTasksAwaitingMeMock.mockReturnValue({ tasks: [], loading: false, error: null, refetch: vi.fn() });
    mocks.useTaskCommentsMock.mockReset();
    mocks.useTaskCommentsMock.mockReturnValue({
      comments: [],
      loop: null,
      unreadReplyCount: 0,
      loading: false,
      error: null,
      refetch: vi.fn().mockResolvedValue(undefined),
    });
    mocks.useTaskTimelineMock.mockReset();
    mocks.useTaskTimelineMock.mockReturnValue({ entries: [], loading: false, error: null, refetch: vi.fn() });
    mocks.ackTaskRepliesMock.mockReset();
    mocks.ackTaskRepliesMock.mockResolvedValue({ acknowledged: false });
    mocks.useTaskMock.mockReset();
    mocks.useTaskMock.mockReturnValue({
      task: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.useTasksMock.mockReset();
    mocks.useTasksMock.mockImplementation((filters: { section?: string }) => ({
      tasks: filters.section === "overdue" ? [makeTask()] : [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    }));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    consoleErrorSpy.mockRestore();
    container.remove();
  });

  function renderPage(initialEntry = "/tasks") {
    act(() => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/tasks" element={<TaskListPage />} />
            <Route path="/tasks/:taskId" element={<TaskListPage />} />
          </Routes>
        </MemoryRouter>
      );
    });
  }

  it("formats and renders project context for deal-linked tasks", () => {
    const source = normalize(taskListPageSource);

    expect(getTaskProjectContext({
      dealId: "deal-1",
      dealName: "Northstar Expansion",
      dealNumber: "HS-324283495135",
      projectNumber: "DFW-1-12826-aa",
    })).toBe("DFW-1-12826-aa - Northstar Expansion");
    expect(getTaskProjectContext({
      dealId: "deal-2",
      dealName: "HubSpot Import",
      dealNumber: "HS-324283495135",
      projectNumber: null,
    })).toBe("HubSpot Import");
    const resolver = normalize(taskProjectContextSource);
    expect(resolver).toContain("function getTaskProjectContext");
    expect(resolver).toContain("formatDealDisplayNumber(task)");
    expect(resolver).toContain("return \"Project linked\";");
    // ...and the page still consumes it rather than having grown a second, divergent copy.
    expect(source).toContain("const projectContext = getTaskProjectContext(task);");
    expect(source).not.toContain("function getTaskProjectContext");
    expect(source).toContain("{projectContext ? <span className=\"truncate\">{projectContext}</span> : null}");
    expect(source).toContain("type GroupKey = \"overdue\" | \"today\" | \"this_week\" | \"later\" | \"completed\";");
    expect(source).toContain("getTaskStatusLabel(task.status)");
  });

  it("does not expose HS-prefixed identifiers embedded in generated task titles", () => {
    mocks.useTasksMock.mockImplementation((filters: { section?: string }) => ({
      tasks: filters.section === "overdue" ? [{ ...makeTask(), title: "Follow up: HS-323641734879 closes 2026-05-08" }] : [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    }));

    renderPage();

    expect(container.textContent).toContain("Follow up: Project pending closes 2026-05-08");
    expect(container.textContent).not.toContain("HS-323641734879");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Complete Follow up: Project pending closes 2026-05-08"]')).not.toBeNull();
  });

  it("surfaces the linked task when opened from /tasks/:taskId", () => {
    const linkedTask = {
      ...makeTask(),
      id: "linked-task",
      title: "Review linked task",
      dueDate: "2026-05-20",
      isOverdue: false,
    };
    mocks.useTasksMock.mockImplementation(() => ({
      tasks: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    }));
    mocks.useTaskMock.mockReturnValue({
      task: linkedTask,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderPage("/tasks/linked-task");

    expect(mocks.useTaskMock).toHaveBeenCalledWith("linked-task");
    // The "Linked task" banner became the conversation drawer (F4/C7): /tasks/:taskId was never a
    // detail page, and both of the loop's emails deep-link here. The REQUIREMENT this test carries is
    // unchanged and is what is asserted below — a task opened from a deep link must name its project
    // and its assignee rather than falling back to the generic labels.
    expect(container.querySelector('[data-testid="task-conversation-drawer"]')).not.toBeNull();
    expect(container.textContent).toContain("Review linked task");
    // The whole point of the email deep link: the assignee must be able to tell which project the
    // task belongs to, and who it is assigned to. GET /tasks/:id has to supply the joined deal
    // columns and the assignee name for these to render.
    expect(container.textContent).toContain("Palm Villas");
    expect(container.textContent).toContain("Brett Jones");
    expect(container.textContent).not.toContain("Project linked");
    expect(container.textContent).not.toContain("Unassigned");
  });

  it("degrades to the generic fallbacks when the API omits the joined deal/assignee columns", () => {
    // Guards the shape the endpoint used to return: dealId present, deal columns absent.
    const { dealName: _dealName, dealNumber: _dealNumber, assignedToName: _assignedToName, ...bare } = makeTask();
    mocks.useTasksMock.mockImplementation(() => ({
      tasks: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    }));
    mocks.useTaskMock.mockReturnValue({
      task: { ...bare, id: "linked-task", title: "Review linked task" },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderPage("/tasks/linked-task");

    expect(container.querySelector('[data-testid="task-conversation-drawer"]')).not.toBeNull();
    expect(container.textContent).toContain("Project linked");
    expect(container.textContent).toContain("Unassigned");
  });

  it("keeps child action keydown events from opening the row edit dialog", () => {
    renderPage();

    const completeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Complete Call Palm Villas"]');
    const row = container.querySelector<HTMLElement>('[data-testid="task-row-content"]');

    expect(completeButton).not.toBeNull();
    expect(row).not.toBeNull();

    act(() => {
      completeButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(container.textContent).not.toContain("Edit task dialog");

    act(() => {
      row?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(container.textContent).toContain("Edit task dialog");
  });

  it("collects an outcome before completing a task", async () => {
    renderPage();

    const completeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Complete Call Palm Villas"]');
    expect(completeButton).not.toBeNull();

    await act(async () => {
      completeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.completeTaskMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Save task outcome");

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Save task outcome"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.completeTaskMock).toHaveBeenCalledWith(
      "task-1",
      "Called the customer and confirmed the next step."
    );
  });

  it("surfaces snooze task failures without leaving the action busy", async () => {
    mocks.snoozeTaskMock.mockRejectedValueOnce(new Error("Snooze failed"));
    renderPage();

    const snoozeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Snooze Call Palm Villas"]');
    expect(snoozeButton).not.toBeNull();

    await act(async () => {
      snoozeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(snoozeButton?.disabled).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith("[tasks] snooze failed", expect.any(Error));
    expect(mocks.toastErrorMock).toHaveBeenCalledWith("Snooze failed");
  });

  it("does not open the edit dialog when terminal rows are activated", () => {
    mocks.useTasksMock.mockImplementation((filters: { section?: string }) => ({
      tasks: filters.section === "overdue" ? [{ ...makeTask(), status: "completed" }] : [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    }));
    renderPage();

    const row = container.querySelector<HTMLElement>('[data-testid="task-row-content"]');
    expect(row).not.toBeNull();

    act(() => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("Edit task dialog");

    act(() => {
      row?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(container.textContent).not.toContain("Edit task dialog");
  });

  it("prevents default Space scrolling when keyboard-activating task rows", () => {
    renderPage();

    const row = container.querySelector<HTMLElement>('[data-testid="task-row-content"]');
    expect(row).not.toBeNull();
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    const preventDefault = vi.spyOn(event, "preventDefault");

    act(() => {
      row?.dispatchEvent(event);
    });

    expect(preventDefault).toHaveBeenCalled();
  });

  it("renders task row content as a single button without nested action buttons", () => {
    renderPage();

    expect(container.querySelector('div[role="button"]')).toBeNull();
    const contentButton = container.querySelector<HTMLButtonElement>('[data-testid="task-row-content"]');
    expect(contentButton).not.toBeNull();
    expect(contentButton?.tagName).toBe("BUTTON");
    expect(contentButton?.querySelector("button")).toBeNull();
    for (const button of Array.from(container.querySelectorAll("button"))) {
      expect(button.querySelector("button")).toBeNull();
    }
  });

  it("completed task rows are not keyboard-focusable", () => {
    mocks.useTasksMock.mockImplementation((filters: { section?: string }) => ({
      tasks: filters.section === "overdue" ? [{ ...makeTask(), status: "completed" }] : [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    }));
    renderPage();

    const contentButton = container.querySelector<HTMLButtonElement>('[data-testid="task-row-content"]');
    expect(contentButton).not.toBeNull();
    expect(contentButton?.disabled).toBe(true);
  });

  it("renders assignee picker for director role", () => {
    renderPage();

    const picker = container.querySelector<HTMLSelectElement>('[data-testid="assignee-filter"] select');
    expect(picker).not.toBeNull();
    expect(picker?.textContent).toContain("All assignees");
    expect(picker?.textContent).toContain("Brett Jones");
  });

  it("does not render assignee picker for rep role", () => {
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "rep-1",
        email: "rep@example.test",
        displayName: "Rep User",
        role: "rep",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
      loading: false,
    });

    renderPage();

    expect(container.querySelector('[data-testid="assignee-filter"]')).toBeNull();
  });

  it("applies assignee filter to task fetches when picker selection changes", () => {
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "admin-1",
        email: "admin@example.test",
        displayName: "Admin User",
        role: "admin",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
      loading: false,
    });
    renderPage();

    const picker = container.querySelector<HTMLSelectElement>('[data-testid="assignee-filter"] select');
    expect(picker).not.toBeNull();

    act(() => {
      picker?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    act(() => {
      if (picker) {
        picker.value = "rep-2";
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    // Second argument is the automated/manual tab, undefined here because no tab is selected. The
    // counts endpoint takes it so the summary cards scope to the same rows the buckets do.
    expect(mocks.useTaskCountsMock).toHaveBeenLastCalledWith("rep-2", undefined);
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "overdue", assignedTo: "rep-2" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "today", assignedTo: "rep-2" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "this_week", assignedTo: "rep-2" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "later", assignedTo: "rep-2" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "completed", assignedTo: "rep-2" }));
  });

  it("does not fire task fetches before auth resolves", () => {
    mocks.useAuthMock.mockReturnValue({
      user: null,
      loading: true,
    });
    mocks.useTaskCountsMock.mockClear();
    mocks.useTasksMock.mockClear();

    renderPage();

    expect(container.textContent).toContain("Loading tasks...");
    expect(mocks.useTaskCountsMock).not.toHaveBeenCalled();
    expect(mocks.useTasksMock).not.toHaveBeenCalled();

    act(() => {
      mocks.useAuthMock.mockReturnValue({
        user: {
          id: "director-1",
          email: "director@example.test",
          displayName: "Director User",
          role: "director",
          officeId: "office-1",
          activeOfficeId: "office-1",
        },
        loading: false,
      });
      root?.render(
        <MemoryRouter initialEntries={["/tasks"]}>
          <TaskListPage />
        </MemoryRouter>
      );
    });

    expect(mocks.useTaskCountsMock).toHaveBeenCalled();
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "overdue" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "today" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "this_week" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "later" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "completed" }));
  });

  it("Completed-this-week card reads the server count, not the limited Completed bucket", () => {
    // The card must come from counts.completedThisWeek (full-set, sort-independent) so it can't
    // drift when the Completed bucket is re-sorted/limited.
    mocks.useTaskCountsMock.mockReturnValue({
      counts: { overdue: 0, today: 0, upcoming: 0, completed: 200, completedThisWeek: 7, bySource: { manual: 0, automated: 0, all: 0 } },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    // The Completed bucket returns only 2 rows — the card must NOT be derived from this length.
    mocks.useTasksMock.mockImplementation((filters: { section?: string }) => ({
      tasks:
        filters.section === "completed"
          ? [
              { ...makeTask(), id: "c1", status: "completed", completedAt: "2026-05-06T12:00:00.000Z" },
              { ...makeTask(), id: "c2", status: "completed", completedAt: "2026-05-05T12:00:00.000Z" },
            ]
          : [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    }));

    renderPage();

    const completedCardText = Array.from(container.querySelectorAll("div"))
      .map((element) => element.textContent ?? "")
      .find((text) => text.includes("Completed this week") && text.includes("Last 7 days"));
    expect(completedCardText).toContain("7"); // the server count, not "2" (bucket length)
  });

  it("fetches every bucket with its default sort and offers a per-bucket sort dropdown", () => {
    renderPage();

    // Defaults: active buckets by due date ascending; Completed by completed date descending.
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "overdue", sortBy: "due_date", sortDir: "asc" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "this_week", sortBy: "due_date", sortDir: "asc" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "later", sortBy: "due_date", sortDir: "asc" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "completed", sortBy: "completed_at", sortDir: "desc" }));

    // Each open bucket renders its own sort control.
    expect(container.querySelector('[data-sort-group="overdue"] select')).not.toBeNull();
  });

  it("shows a placeholder in the summary cards while the assignee counts are stale (scope swap in flight)", () => {
    mocks.useTaskCountsMock.mockReturnValue({
      counts: { overdue: 7, today: 3, upcoming: 0, completed: 0, completedThisWeek: 5, bySource: { manual: 4, automated: 6, all: 10 } },
      loading: true,
      stale: true,
      error: null,
      refetch: vi.fn(),
    });

    renderPage();

    // The 3 summary-card VALUES (rendered in <p class="text-4xl …">) must all be the placeholder —
    // not the previous assignee's 7 / 3 / 5 — while the new scope's counts are loading.
    const cardValues = Array.from(container.querySelectorAll("p.text-4xl")).map((el) => el.textContent);
    expect(cardValues).toEqual(["—", "—", "—"]);

    // The automated/manual tab labels read the SAME stale counts and must blank too. The cards were
    // already guarded; the toggle was added later and read counts.bySource straight through, so after
    // an assignee change its totals went on describing the previous assignee — indefinitely if the
    // request failed. Asserted through a real render so the page's CALL SITE is covered, not just the
    // helper that builds the options.
    const tabs = Array.from(
      container.querySelectorAll('[role="group"][aria-label="Filter tasks by who created them"] button')
    ).map((el) => el.textContent);
    expect(tabs).toEqual(["All", "Manual", "Automated"]);
    for (const label of tabs) {
      expect(label, "a stale tab label must carry no number").not.toMatch(/\d/);
    }
  });

  it("shows the tab counts once they belong to the current scope", () => {
    mocks.useTaskCountsMock.mockReturnValue({
      counts: { overdue: 7, today: 3, upcoming: 0, completed: 0, completedThisWeek: 5, bySource: { manual: 4, automated: 6, all: 10 } },
      loading: false,
      stale: false,
      error: null,
      refetch: vi.fn(),
    });

    renderPage();

    const tabs = Array.from(
      container.querySelectorAll('[role="group"][aria-label="Filter tasks by who created them"] button')
    ).map((el) => el.textContent);
    expect(tabs).toEqual(["All10", "Manual4", "Automated6"]);
  });

  it("a scope (assignee) change reloads in place without a full-page blank after first load", () => {
    // The stale-row SAFETY (the previous assignee's rows can't stay actionable mid-refetch) lives in
    // useTasks, which drops the rows synchronously on a scope change — gate-proven in
    // use-tasks.scope.test.tsx. The page just reloads in place; it does not whole-page blank again.
    let scopeLoading = false;
    mocks.useTasksMock.mockImplementation((filters: { section?: string }) => ({
      tasks: filters.section === "overdue" ? [makeTask()] : [],
      loading: scopeLoading,
      error: null,
      refetch: vi.fn(),
    }));

    renderPage();
    expect(container.textContent).not.toContain("Loading tasks...");

    scopeLoading = true;
    const picker = container.querySelector<HTMLSelectElement>('[data-testid="assignee-filter"] select');
    act(() => {
      if (picker) {
        picker.value = "rep-2";
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    expect(container.textContent).not.toContain("Loading tasks...");
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "overdue", assignedTo: "rep-2" }));
  });

  it("disables a bucket's row actions while it is refetching (no acting on stale/just-mutated rows)", () => {
    let overdueLoading = false;
    mocks.useTasksMock.mockImplementation((filters: { section?: string }) => ({
      tasks: filters.section === "overdue" ? [makeTask()] : [],
      loading: filters.section === "overdue" ? overdueLoading : false,
      error: null,
      refetch: vi.fn(),
    }));

    renderPage();
    let completeBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Complete Call Palm Villas"]');
    expect(completeBtn?.disabled).toBe(false); // settled → actionable

    // Bucket begins refetching (e.g. right after a complete/snooze, or a sort change).
    overdueLoading = true;
    const overdueSort = container.querySelector<HTMLSelectElement>('[data-sort-group="overdue"] select');
    act(() => {
      if (overdueSort) {
        overdueSort.value = "priority:desc";
        overdueSort.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    completeBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Complete Call Palm Villas"]');
    const rowContent = container.querySelector<HTMLButtonElement>('[data-testid="task-row-content"]');
    expect(completeBtn?.disabled).toBe(true); // refreshing → locked
    expect(rowContent?.disabled).toBe(true); // can't open edit on a stale row mid-refetch
  });

  it("a sort-only refetch (same scope) does NOT blank the page", () => {
    let sortLoading = false;
    mocks.useTasksMock.mockImplementation((filters: { section?: string }) => ({
      tasks: filters.section === "overdue" ? [makeTask()] : [],
      loading: filters.section === "overdue" ? sortLoading : false,
      error: null,
      refetch: vi.fn(),
    }));

    renderPage();
    expect(container.textContent).not.toContain("Loading tasks...");

    // Overdue bucket refetches for a sort change (same assignee) — page must stay visible.
    sortLoading = true;
    const overdueSort = container.querySelector<HTMLSelectElement>('[data-sort-group="overdue"] select');
    act(() => {
      if (overdueSort) {
        overdueSort.value = "priority:desc";
        overdueSort.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    expect(container.textContent).not.toContain("Loading tasks...");
    expect(container.querySelector('button[aria-label="Complete Call Palm Villas"]')).not.toBeNull();
  });

  it("changing a bucket's sort dropdown refetches that bucket server-side with the new sort", () => {
    renderPage();

    const overdueSort = container.querySelector<HTMLSelectElement>('[data-sort-group="overdue"] select');
    expect(overdueSort).not.toBeNull();

    mocks.useTasksMock.mockClear();
    act(() => {
      if (overdueSort) {
        overdueSort.value = "priority:desc";
        overdueSort.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    // Only the Overdue bucket switches sort; other buckets keep their own selection.
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "overdue", sortBy: "priority", sortDir: "desc" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "today", sortBy: "due_date", sortDir: "asc" }));
  });

  // `?complete=1` arrives from ONE task's emailed "Mark complete" link. Every other query parameter
  // describes where the reader is — the filters, and `?officeId`, which is load-bearing because
  // dropping it re-resolves the tenant from the reader's home office. This one describes what they
  // were asked to do, and about what, so it is the one that must not ride along to a different task.
  it("carries the view parameters to another conversation but drops the complete flag", () => {
    function LocationSpy() {
      const { pathname, search } = useLocation();
      return <span data-testid="where">{`${pathname}${search}`}</span>;
    }
    act(() => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={["/tasks?source=manual&complete=1"]}>
          <LocationSpy />
          <Routes>
            <Route path="/tasks" element={<TaskListPage />} />
            <Route path="/tasks/:taskId" element={<TaskListPage />} />
          </Routes>
        </MemoryRouter>
      );
    });

    const open = [...container.querySelectorAll<HTMLElement>("button")].find((b) =>
      (b.getAttribute("aria-label") ?? b.textContent ?? "").toLowerCase().includes("conversation")
    );
    if (!open) throw new Error("no conversation button rendered");
    act(() => open.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const where = container.querySelector('[data-testid="where"]')!.textContent!;
    expect(where).toContain("source=manual");
    // Otherwise the next drawer focuses and highlights THAT task's close action as though the email
    // had asked for it — one click from completing the wrong task.
    expect(where).not.toContain("complete=1");
  });
});
