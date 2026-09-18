/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import source from "./task-create-dialog.tsx?raw";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  createTask: vi.fn(),
  createProjectTask: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks.api }));
vi.mock("@/hooks/use-tasks", () => ({
  createTask: mocks.createTask,
  createProjectTask: mocks.createProjectTask,
  // Real, not a stub: it is the value→label map Base UI needs to render "Urgent" on the trigger
  // instead of the raw enum, so a mock that omitted it would hide exactly the bug it was added for.
  TASK_PRIORITY_SELECT_ITEMS: [
    { value: "urgent", label: "Urgent" },
    { value: "high", label: "High" },
    { value: "normal", label: "Normal" },
    { value: "low", label: "Low" },
  ],
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "user-1", role: "director" } }),
}));
// Render the dialog inline when open so the form is exercisable without the portal/pointer setup.
vi.mock("@/components/ui/dialog", () => ({
  // Drives the real `open` state the component gates its data fetching on.
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange?: (next: boolean) => void;
    children: ReactNode;
  }) => (
    <div data-testid="dialog">
      <button type="button" data-testid="open-dialog" onClick={() => onOpenChange?.(true)}>
        New Task
      </button>
      {open ? children : null}
    </div>
  ),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTrigger: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { TaskCreateDialog } = await import("./task-create-dialog");

function normalize(value: string) {
  return value.replace(/\s+/g, " ");
}

let roots: Root[] = [];
let containers: HTMLElement[] = [];

function renderDialog() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  act(() => {
    root.render(<TaskCreateDialog onCreated={vi.fn()} />);
  });
  // Open the dialog body.
  const trigger = container.querySelector<HTMLButtonElement>('[data-testid="open-dialog"]');
  act(() => {
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return container;
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function openProjectPicker(container: HTMLElement) {
  const toggle = Array.from(container.querySelectorAll("button")).find((b) =>
    b.getAttribute("aria-label") === "Choose a linked project"
  );
  act(() => {
    toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return toggle;
}

function projectSearchInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('input[placeholder="Search projects..."]');
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.createTask.mockReset().mockResolvedValue({});
  mocks.createProjectTask.mockReset().mockResolvedValue({});
  mocks.api.mockResolvedValue({ users: [], deals: [] });
});

afterEach(() => {
  act(() => {
    roots.forEach((root) => root.unmount());
  });
  containers.forEach((c) => c.remove());
  roots = [];
  containers = [];
  vi.useRealTimers();
});

describe("TaskCreateDialog", () => {
  it("allows reps to load the assignee picker and submit cross-user assignments", () => {
    const normalized = normalize(source);

    expect(normalized).toContain('user?.role === "admin" || user?.role === "director" || user?.role === "rep"');
    expect(normalized).toContain('api<{ users: Assignee[] }>("/tasks/assignees")');
    expect(normalized).toContain('assignedTo: canAssign && assignedTo ? assignedTo : undefined');
    expect(normalized).toContain("Assign to teammate");
  });

  it("keeps the project field visible when the deals lookup fails", async () => {
    // Regression: the field used to be gated on `deals.length > 0`, so a failed or empty
    // lookup removed it entirely and the assigner had no way to attach a project.
    vi.useFakeTimers();
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/tasks/assignees")) return { users: [] };
      throw new Error("deals unavailable");
    });

    const container = renderDialog();
    openProjectPicker(container);
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Link to Project");
    expect(container.textContent).toContain("Couldn't load projects");
  });

  it("searches projects server-side rather than filtering a fixed 50", async () => {
    vi.useFakeTimers();
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/tasks/assignees")) return { users: [] };
      return { deals: [{ id: "deal-9", dealNumber: "HS-1", projectNumber: "DFW-1-12826-AH", name: "Palm Villas" }] };
    });

    const container = renderDialog();
    openProjectPicker(container);

    const search = projectSearchInput(container);
    expect(search).not.toBeNull();
    setValue(search!, "palm");
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    const searchCalls = mocks.api.mock.calls.map(([path]) => String(path)).filter((p) => p.includes("search="));
    expect(searchCalls.length).toBeGreaterThan(0);
    expect(searchCalls[searchCalls.length - 1]).toContain("search=palm");
    expect(container.textContent).toContain("DFW-1-12826-AH - Palm Villas");
  });

  it("searches the office-wide project scope, not just the caller's own deals", async () => {
    // Codex P2: /deals defaults to scope=mine (readListScope), so without scope=all the picker
    // cannot find a project the assigner does not own — which is the reported case exactly.
    vi.useFakeTimers();
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/tasks/assignees")) return { users: [] };
      return { deals: [] };
    });

    const container = renderDialog();
    openProjectPicker(container);
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    const dealCalls = mocks.api.mock.calls.map(([path]) => String(path)).filter((p) => p.startsWith("/deals"));
    expect(dealCalls.length).toBeGreaterThan(0);
    expect(dealCalls.every((p) => p.includes("scope=all"))).toBe(true);

    // …and on the search request too.
    setValue(projectSearchInput(container)!, "palm");
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    const searchCalls = mocks.api.mock.calls.map(([path]) => String(path)).filter((p) => p.includes("search="));
    expect(searchCalls.length).toBeGreaterThan(0);
    expect(searchCalls.every((p) => p.includes("scope=all"))).toBe(true);
  });

  it("retires the previous results as soon as the query changes", async () => {
    // Codex P2: results for the OLD query stayed rendered (and clickable) for the whole debounce
    // window, so a project that does not match what the user just typed could still be selected.
    vi.useFakeTimers();
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/tasks/assignees")) return { users: [] };
      return { deals: [{ id: "deal-9", dealNumber: "HS-1", projectNumber: "DFW-1-12826-AH", name: "Palm Villas" }] };
    });

    const container = renderDialog();
    openProjectPicker(container);
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("DFW-1-12826-AH - Palm Villas");

    // Type a new query but do NOT let the debounce fire.
    setValue(projectSearchInput(container)!, "warehouse");

    expect(container.textContent).not.toContain("DFW-1-12826-AH - Palm Villas");
    expect(
      Array.from(container.querySelectorAll("button")).some((b) =>
        b.textContent?.includes("DFW-1-12826-AH")
      )
    ).toBe(false);
  });

  it("does not create the task when Enter is pressed in the project search", async () => {
    vi.useFakeTimers();
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/tasks/assignees")) return { users: [] };
      return { deals: [] };
    });

    const container = renderDialog();
    setValue(container.querySelector<HTMLInputElement>('input[placeholder="Task title"]')!, "Need Property info");
    openProjectPicker(container);

    const search = projectSearchInput(container)!;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      search.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("submits the chosen project as dealId", async () => {
    vi.useFakeTimers();
    mocks.api.mockImplementation(async (path: string) => {
      if (path.startsWith("/tasks/assignees")) return { users: [] };
      return { deals: [{ id: "deal-9", dealNumber: "HS-1", projectNumber: "DFW-1-12826-AH", name: "Palm Villas" }] };
    });

    const container = renderDialog();
    const titleInput = container.querySelector<HTMLInputElement>('input[placeholder="Task title"]')!;
    setValue(titleInput, "Need Property info");

    openProjectPicker(container);
    setValue(projectSearchInput(container)!, "palm");
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    const option = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("DFW-1-12826-AH - Palm Villas")
    );
    act(() => {
      option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Need Property info", dealId: "deal-9" })
    );
  });
});
