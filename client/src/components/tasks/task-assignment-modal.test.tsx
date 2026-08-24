// @vitest-environment jsdom
//
// The modal is an INTERRUPTION the user did not trigger, so most of what is worth testing here is
// about restraint: it must not open on a page the user reached without logging in, it must not open
// onto an empty list, and it must acknowledge exactly once no matter which of the four dismissal paths
// the user takes.
//
// C10 is the shape of the whole component. Routing acknowledgement through the buttons, then Escape,
// then the backdrop separately gives three racing POSTs and then needs a StrictMode guard to paper over
// the races it just created. Base UI funnels every close through `onOpenChange`, so that is the single
// place it happens — and "closed exactly once" is asserted for each path rather than assumed.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => apiMock(...args) }));

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigateMock };
});

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ useAuth: () => authMock() }));

import { TaskAssignmentModal } from "./task-assignment-modal";

type PendingTask = {
  id: string;
  title: string;
  priority: string;
  dueDate: string | null;
  assignedByName: string | null;
};

function task(overrides: Partial<PendingTask> = {}): PendingTask {
  return {
    id: overrides.id ?? "task-1",
    title: overrides.title ?? "Walk the Henderson roof",
    priority: overrides.priority ?? "normal",
    dueDate: overrides.dueDate ?? null,
    assignedByName: overrides.assignedByName ?? "Adam Shaw",
    ...overrides,
  };
}

function setPending(tasks: PendingTask[], total = tasks.length) {
  apiMock.mockImplementation(async (path: string) => {
    if (path === "/tasks/pending-acknowledgement") return { tasks, total };
    if (path === "/tasks/acknowledge") return undefined;
    throw new Error(`unexpected api call: ${path}`);
  });
}

function acknowledgeCalls() {
  return apiMock.mock.calls.filter(([path]) => path === "/tasks/acknowledge");
}

let container: HTMLDivElement;
let root: Root | null;

async function render(flag: boolean | undefined) {
  authMock.mockReturnValue({ user: flag === undefined ? null : { id: "u1", hasPendingTaskAssignments: flag } });
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <TaskAssignmentModal />
      </MemoryRouter>
    );
  });
  await settle();
}

/**
 * Flush far enough for Base UI to have MOVED FOCUS, which is two hops past a microtask.
 *
 * FloatingFocusManager resolves `initialFocus` inside a queueMicrotask and then hands the element to
 * `enqueueFocus`, which schedules the actual `.focus()` call in a requestAnimationFrame. jsdom's rAF
 * fires on a ~16ms timer, so a `setTimeout(0)` flush lands BEFORE the focus has moved — and every
 * focus assertion then reads a DOM where the trap has not engaged yet. That failure is also
 * order-dependent (enqueueFocus keeps ONE module-level rAF id and cancels the previous one), so it
 * shows up as two focus tests that each pass alone and fail together, which reads exactly like a
 * broken focus trap. It is not. Round one settles the fetch and mounts the dialog; round two waits out
 * the animation frame the focus call is sitting in.
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });
}

function dialog() {
  return document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
}

function buttonLabelled(text: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((el) =>
    el.textContent?.trim().startsWith(text)
  );
}

async function click(el: HTMLElement | undefined) {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
  navigateMock.mockReset();
  authMock.mockReset();
  container = document.createElement("div");
  document.body.innerHTML = "";
  document.body.appendChild(container);
  root = createRoot(container);
});

// Unmount is AWAITED and flushed. Base UI restores focus when a dialog unmounts, and that restoration
// lands a tick later — an unflushed teardown lets the previous test's focus restore fire in the middle
// of the next test's open, which is a cross-test failure that looks exactly like a broken focus trap.
afterEach(async () => {
  // CLOSE the dialog before tearing the tree down, rather than yanking it open. Base UI tracks open
  // popups in module state that outlives a React root, and a dialog unmounted while open leaves that
  // state believing one is still up — the next test's dialog is then treated as nested and never takes
  // focus. That reads as a broken focus trap in whichever test happens to run second, which is a lie.
  if (dialog()) await click(buttonLabelled("Close"));
  if (root) {
    await act(async () => {
      root?.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  root = null;
  container.remove();
  // jsdom leaves activeElement pointing at whatever the torn-down tree last focused. Reset it, or the
  // next test's "focus moved" assertion is reading the previous test's residue.
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe("TaskAssignmentModal — when it appears", () => {
  it("opens, and names the task and who assigned it", async () => {
    setPending([task({ title: "Walk the Henderson roof", assignedByName: "Adam Shaw" })]);

    await render(true);

    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("Walk the Henderson roof");
    expect(dialog()!.textContent).toContain("Adam Shaw");
  });

  it("does not fetch, and does not open, when the flag is false", async () => {
    setPending([task()]);

    await render(false);

    expect(apiMock).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("does not open when there is no signed-in user at all", async () => {
    setPending([task()]);

    await render(undefined);

    expect(apiMock).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  // The flag and the list are answered by two different queries against a moving table. A task
  // completed between them leaves the flag true and the list empty, and an empty modal is worse than
  // no modal.
  it("stays closed when the flag is true but the list comes back empty", async () => {
    setPending([], 0);

    await render(true);

    expect(apiMock).toHaveBeenCalledWith("/tasks/pending-acknowledgement");
    expect(dialog()).toBeNull();
  });

  it("shows an 'and N more' line only when the total exceeds what it rendered", async () => {
    setPending([task({ id: "t1" }), task({ id: "t2" })], 7);

    await render(true);

    expect(dialog()!.textContent).toContain("5 more");
  });

  it("omits the 'and N more' line when everything fits", async () => {
    setPending([task({ id: "t1" }), task({ id: "t2" })], 2);

    await render(true);

    expect(dialog()!.textContent).not.toContain("more");
  });

  it("fetches once, not once per render", async () => {
    setPending([task()]);
    await render(true);

    await act(async () => {
      root?.render(
        <MemoryRouter>
          <TaskAssignmentModal />
        </MemoryRouter>
      );
    });

    expect(apiMock.mock.calls.filter(([p]) => p === "/tasks/pending-acknowledgement")).toHaveLength(1);
  });
});

describe("TaskAssignmentModal — every dismissal acknowledges, exactly once", () => {
  it("acknowledges the shown ids when Close is pressed", async () => {
    setPending([task({ id: "t1" }), task({ id: "t2" })]);
    await render(true);

    await click(buttonLabelled("Close"));

    expect(acknowledgeCalls()).toHaveLength(1);
    expect(acknowledgeCalls()[0]![1]).toMatchObject({
      method: "POST",
      json: { taskIds: ["t1", "t2"] },
    });
    expect(dialog()).toBeNull();
  });

  it("acknowledges on ESCAPE — a dismissal that silently skipped it would re-pop for no reason", async () => {
    setPending([task({ id: "t1" })]);
    await render(true);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();

    expect(acknowledgeCalls()).toHaveLength(1);
    expect(acknowledgeCalls()[0]![1]).toMatchObject({ json: { taskIds: ["t1"] } });
  });

  it("acknowledges AND navigates on View all tasks", async () => {
    setPending([task({ id: "t1" })]);
    await render(true);

    await click(buttonLabelled("View all tasks"));

    expect(navigateMock).toHaveBeenCalledWith("/tasks");
    expect(acknowledgeCalls()).toHaveLength(1);
  });

  // The POST is idempotent server-side via ON CONFLICT DO NOTHING, so a second one is harmless rather
  // than wrong — but three racing POSTs per dismissal is what the single-funnel design exists to avoid,
  // and only a count can tell whether the funnel is really single.
  it("posts exactly one acknowledgement even if close fires more than once", async () => {
    setPending([task({ id: "t1" })]);
    await render(true);

    const close = buttonLabelled("Close");
    await click(close);
    await click(close);

    expect(acknowledgeCalls()).toHaveLength(1);
  });

  it("closes even if the acknowledge POST fails — the modal is not a hostage to the network", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/tasks/pending-acknowledgement") return { tasks: [task({ id: "t1" })], total: 1 };
      throw new Error("network down");
    });
    await render(true);

    await click(buttonLabelled("Close"));

    expect(dialog()).toBeNull();
  });
});

describe("TaskAssignmentModal — accessibility", () => {
  it("is a modal dialog labelled by its own heading", async () => {
    setPending([task({ title: "Walk the Henderson roof" })]);
    await render(true);

    const popup = dialog()!;
    expect(popup.getAttribute("role")).toBe("dialog");
    expect(popup.getAttribute("aria-modal")).toBe("true");

    const labelledBy = popup.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBeTruthy();
  });

  // The stronger half of "modal", and the half aria-modal alone does not deliver: everything outside
  // the popup is removed from the accessibility tree, so a screen reader cannot wander out of an
  // interruption the user never asked for.
  it("hides the rest of the page from assistive technology while it is open", async () => {
    setPending([task()]);
    await render(true);

    const hidden = Array.from(document.body.children).filter(
      (el) => el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert")
    );
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.some((el) => el.contains(dialog()))).toBe(false);
  });

  it("moves focus INTO the dialog on open, and not onto an action button", async () => {
    setPending([task()]);
    await render(true);

    const popup = dialog()!;
    expect(
      popup.contains(document.activeElement),
      `active element was <${document.activeElement?.tagName}> ${(document.activeElement as HTMLElement)?.dataset?.slot ?? ""}`
    ).toBe(true);
    // The dialog was not requested by the user, so landing them on a button they might press by reflex
    // is the wrong default. Focus goes to the dialog itself.
    expect(document.activeElement?.tagName).not.toBe("BUTTON");
  });

  it("RETURNS focus to whatever was focused before it interrupted", async () => {
    const previous = document.createElement("button");
    previous.textContent = "Something the user was doing";
    document.body.appendChild(previous);
    previous.focus();
    expect(document.activeElement).toBe(previous);

    setPending([task()]);
    await render(true);
    expect(document.activeElement).not.toBe(previous);

    await click(buttonLabelled("Close"));

    expect(document.activeElement).toBe(previous);
    previous.remove();
  });

  it("renders through a portal on document.body, not inside the component's own tree", async () => {
    setPending([task()]);
    await render(true);

    expect(container.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(document.body.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
  });
});
