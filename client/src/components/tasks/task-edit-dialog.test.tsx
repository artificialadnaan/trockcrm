// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskEditDialog } from "./task-edit-dialog";
import type { Task } from "@/hooks/use-tasks";

/**
 * THE BUG THIS FILE EXISTS FOR: the Edit Task dialog rendered the assignee's raw uuid.
 *
 * Base UI's `Select.Value` resolves its label from the `items` prop on `Select.Root` — NEVER from the
 * `SelectItem` children. Given no `items` it falls through to `String(value)`, so the trigger read
 * `5687a3c6-1556-4dd6-a3d6-b26fbc22f471` where a person's name belongs, and the Priority control
 * beside it read `urgent` in lowercase next to an item labelled `Urgent`.
 *
 * This suite drives the REAL `@/components/ui/select`. Mocking it — as the list-page suite does, for
 * good reasons of its own — would make every assertion here vacuous, because the mock renders a plain
 * `<select>` whose options carry their own text and which therefore cannot reproduce the defect.
 *
 * There was no test file for this component at all before, which is how it shipped.
 */

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
  updateTaskMock: vi.fn(),
  transitionTaskMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "director-1", role: "director" } }),
}));

vi.mock("@/hooks/use-tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-tasks")>()),
  updateTask: mocks.updateTaskMock,
  transitionTask: mocks.transitionTaskMock,
}));

const ASSIGNEE_ID = "5687a3c6-1556-4dd6-a3d6-b26fbc22f471";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Stage Move",
    description: "Addy\nPlease move this back to estimating",
    type: "manual",
    priority: "urgent",
    status: "pending",
    source: "manual",
    assignedTo: ASSIGNEE_ID,
    assignedToName: "Adnaan Iqbal",
    createdBy: "director-1",
    assignedByName: "Adam Shaw",
    assignedAt: "2026-08-14T12:00:00.000Z",
    dealId: "deal-9",
    dealName: "Avela Real Estate Partners Property",
    dealNumber: "DFW-2-18126-ae",
    projectNumber: "DFW-2-18126-ae",
    contactId: null,
    emailId: null,
    dueDate: "2026-08-14",
    dueTime: null,
    remindAt: null,
    scheduledFor: null,
    waitingOn: null,
    blockedBy: null,
    startedAt: null,
    completedAt: null,
    isOverdue: false,
    createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:00:00.000Z",
    ...overrides,
  } as Task;
}

describe("TaskEditDialog", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;

    // Base UI's popup machinery reaches for browser APIs jsdom does not implement. Without these the
    // component throws before it can render anything worth asserting on.
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
    if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
    if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
    if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }

    mocks.apiMock.mockReset();
    mocks.apiMock.mockResolvedValue({
      users: [
        { id: ASSIGNEE_ID, displayName: "Adnaan Iqbal" },
        { id: "rep-2", displayName: "Casey Smith" },
      ],
    });
    mocks.updateTaskMock.mockReset();
    mocks.updateTaskMock.mockResolvedValue(undefined);
    mocks.transitionTaskMock.mockReset();
    mocks.transitionTaskMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = "";
  });

  async function renderDialog(task: Task = makeTask()) {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <TaskEditDialog task={task} open onOpenChange={() => {}} onUpdated={() => {}} />
      );
    });
    // The assignee roster arrives from a promise; let it land before asserting on the trigger.
    await act(async () => {
      await Promise.resolve();
    });
  }

  // The dialog portals to document.body, so the mount container is not where the content lands.
  const dialogText = () => document.body.textContent ?? "";

  it("shows the assignee's NAME on the trigger, not their uuid", async () => {
    await renderDialog();

    expect(dialogText()).toContain("Adnaan Iqbal");
    expect(dialogText()).not.toContain(ASSIGNEE_ID);
  });

  /**
   * The same defect, one control up, and the reason it went unnoticed for longer: a raw priority
   * value still looks like a word. `urgent` is not the label — `Urgent` is.
   */
  it("shows the priority LABEL on the trigger, not the raw enum value", async () => {
    await renderDialog();

    const trigger = document.body.querySelector('[data-slot="select-trigger"]');
    expect(trigger).not.toBeNull();
    const triggers = Array.from(document.body.querySelectorAll('[data-slot="select-trigger"]'));
    const labels = triggers.map((node) => node.textContent ?? "");
    expect(labels.some((label) => label.includes("Urgent"))).toBe(true);
    expect(labels.some((label) => label.trim() === "urgent")).toBe(false);
  });

  /**
   * A task whose assignee is not in the roster still gets a name.
   *
   * `assigneeOptions` prepends the current assignee when the fetched list omits them (a deactivated
   * user, a cross-office assignment). If `items` were built from the fetched list rather than from
   * that merged array, exactly this case would fall back to the uuid — which is the shape the bug
   * had in the first place.
   */
  it("names an assignee who is missing from the fetched roster", async () => {
    mocks.apiMock.mockResolvedValue({ users: [{ id: "rep-2", displayName: "Casey Smith" }] });

    await renderDialog();

    expect(dialogText()).toContain("Adnaan Iqbal");
    expect(dialogText()).not.toContain(ASSIGNEE_ID);
  });

  it("falls back to a readable label when the assignee has no name anywhere", async () => {
    mocks.apiMock.mockResolvedValue({ users: [] });

    await renderDialog(makeTask({ assignedToName: null }));

    expect(dialogText()).toContain("Assigned teammate");
    expect(dialogText()).not.toContain(ASSIGNEE_ID);
  });

  /**
   * The way out of the dialog.
   *
   * "I can save changes to the task but I'm unable to do anything with it" — the editor named no
   * project and offered no route to one, so finding the job meant copying the number into the global
   * search. New tab, because the reader is mid-edit.
   */
  it("links the task's project, opening it in a new tab", async () => {
    await renderDialog();

    const link = document.body.querySelector<HTMLAnchorElement>('[data-testid="task-project-link"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("DFW-2-18126-ae - Avela Real Estate Partners Property");
    expect(link?.getAttribute("href")).toBe("/deals/deal-9");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("says who handed the task over", async () => {
    await renderDialog();

    expect(dialogText()).toContain("Assigned by Adam Shaw");
  });

  it("renders no project row for a task with no deal", async () => {
    await renderDialog(
      makeTask({ dealId: null, dealName: null, dealNumber: null, projectNumber: null, assignedByName: null })
    );

    expect(document.body.querySelector('[data-testid="task-project-link"]')).toBeNull();
  });

  it("labels the title and description fields rather than relying on placeholders", async () => {
    await renderDialog();

    const title = document.body.querySelector<HTMLInputElement>("#task-edit-title");
    const description = document.body.querySelector<HTMLTextAreaElement>("#task-edit-description");
    expect(title).not.toBeNull();
    expect(description).not.toBeNull();
    expect(document.body.querySelector('label[for="task-edit-title"]')?.textContent).toBe("Title");
    expect(document.body.querySelector('label[for="task-edit-description"]')?.textContent).toBe("Description");
  });
});
