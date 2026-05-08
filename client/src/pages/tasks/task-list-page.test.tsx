// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { TaskListPage } from "./task-list-page";
import taskListPageSource from "./task-list-page.tsx?raw";

const mocks = vi.hoisted(() => ({
  completeTaskMock: vi.fn(),
  getTaskStatusLabelMock: vi.fn((status: string) => status),
  isTerminalTaskStatusMock: vi.fn((status: string) => status === "completed" || status === "dismissed"),
  snoozeTaskMock: vi.fn(),
  toastErrorMock: vi.fn(),
  useAuthMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  useTaskCountsMock: vi.fn(),
  useTasksMock: vi.fn(),
}));

vi.mock("@/hooks/use-tasks", () => ({
  completeTask: mocks.completeTaskMock,
  getTaskStatusLabel: mocks.getTaskStatusLabelMock,
  isTerminalTaskStatus: mocks.isTerminalTaskStatusMock,
  snoozeTask: mocks.snoozeTaskMock,
  useTaskCounts: mocks.useTaskCountsMock,
  useTasks: mocks.useTasksMock,
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
      counts: { overdue: 1, today: 0, upcoming: 0, completed: 0 },
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

  function renderPage() {
    act(() => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={["/tasks"]}>
          <TaskListPage />
        </MemoryRouter>
      );
    });
  }

  it("formats and renders project context for deal-linked tasks", () => {
    const source = normalize(taskListPageSource);

    expect(source).toContain("function getTaskProjectContext");
    expect(source).toContain("if (task.dealNumber && task.dealName) return `${task.dealNumber} - ${task.dealName}`;");
    expect(source).toContain("if (task.dealName) return task.dealName;");
    expect(source).toContain("if (task.dealNumber) return task.dealNumber;");
    expect(source).toContain("return \"Project linked\";");
    expect(source).toContain("const projectContext = getTaskProjectContext(task);");
    expect(source).toContain("{projectContext ? <span className=\"truncate\">{projectContext}</span> : null}");
    expect(source).toContain("type GroupKey = \"overdue\" | \"today\" | \"this_week\" | \"later\" | \"completed\";");
    expect(source).toContain("getTaskStatusLabel(task.status)");
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

  it("surfaces complete task failures without leaving the action busy", async () => {
    mocks.completeTaskMock.mockRejectedValueOnce(new Error("Task API failed"));
    renderPage();

    const completeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Complete Call Palm Villas"]');
    expect(completeButton).not.toBeNull();

    await act(async () => {
      completeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(completeButton?.disabled).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith("[tasks] complete failed", expect.any(Error));
    expect(mocks.toastErrorMock).toHaveBeenCalledWith("Task API failed");
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

    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Assignee"]');
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

    expect(container.querySelector('select[aria-label="Assignee"]')).toBeNull();
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

    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Assignee"]');
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

    expect(mocks.useTaskCountsMock).toHaveBeenLastCalledWith("rep-2");
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "overdue", assignedTo: "rep-2" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "today", assignedTo: "rep-2" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "upcoming", assignedTo: "rep-2" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "completed", assignedTo: "rep-2" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ status: "scheduled", assignedTo: "rep-2" }));
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
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "upcoming" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ section: "completed" }));
    expect(mocks.useTasksMock).toHaveBeenCalledWith(expect.objectContaining({ status: "scheduled" }));
  });

  it("completedThisWeek excludes tasks completed more than 7 days ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00.000Z"));
    mocks.useTaskCountsMock.mockReturnValue({
      counts: { overdue: 0, today: 0, upcoming: 0, completed: 99 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.useTasksMock.mockImplementation((filters: { section?: string; status?: string }) => ({
      tasks:
        filters.section === "completed"
          ? [
              { ...makeTask(), id: "recent-completed", status: "completed", completedAt: "2026-05-06T12:00:00.000Z" },
              { ...makeTask(), id: "old-completed", status: "completed", completedAt: "2026-04-20T12:00:00.000Z" },
              { ...makeTask(), id: "missing-completed", status: "completed", completedAt: null },
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
    expect(completedCardText).toContain("1");
    expect(completedCardText).not.toContain("99");
    vi.useRealTimers();
  });
});
