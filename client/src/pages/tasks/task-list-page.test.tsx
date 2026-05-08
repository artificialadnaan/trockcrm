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
});
