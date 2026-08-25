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
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useSearchParams } from "react-router-dom";
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

const consumeAssignmentModalSessionResetMock = vi.fn();

import { TaskAssignmentModal, MAX_FETCH_ATTEMPTS as MAX_ATTEMPTS } from "./task-assignment-modal";

type PendingTask = {
  id: string;
  assignmentVersion: string;
  title: string;
  priority: string;
  dueDate: string | null;
  assignedByName: string | null;
  isNew: boolean;
};

function task(overrides: Partial<PendingTask> = {}): PendingTask {
  return {
    id: overrides.id ?? "task-1",
    assignmentVersion: overrides.assignmentVersion ?? "2026-08-25T12:34:56.123456Z",
    title: overrides.title ?? "Walk the Henderson roof",
    priority: overrides.priority ?? "normal",
    dueDate: overrides.dueDate ?? null,
    assignedByName: overrides.assignedByName ?? "Adam Shaw",
    isNew: overrides.isNew ?? true,
    ...overrides,
  };
}

/** A repeat: already acknowledged, returned again because it is urgent/high/overdue. */
function repeat(overrides: Partial<PendingTask> = {}): PendingTask {
  return task({ priority: "urgent", isNew: false, ...overrides });
}

function setPending(tasks: PendingTask[], total = tasks.length, newTotal?: number) {
  const resolvedNewTotal = newTotal ?? tasks.filter((t) => t.isNew).length;
  apiMock.mockImplementation(async (path: string) => {
    if (path === "/tasks/pending-acknowledgement") return { tasks, total, newTotal: resolvedNewTotal };
    if (path === "/tasks/acknowledge") return undefined;
    throw new Error(`unexpected api call: ${path}`);
  });
}

function acknowledgeCalls() {
  return apiMock.mock.calls.filter(([path]) => path === "/tasks/acknowledge");
}

function acknowledgedTaskIds(call: unknown[]) {
  return (call[1] as { json: { assignments: Array<{ taskId: string; assignmentVersion: string }> } })
    .json.assignments
    .map(({ taskId }) => taskId);
}

let container: HTMLDivElement;
let root: Root | null;

/** The user's HOME office — what x-office-id resolves to when the URL carries no ?officeId. */
const HOME_OFFICE = "office-home";

/**
 * Lets a test change ?officeId the way the app does — by navigating inside the SAME router, so the
 * modal stays mounted. Re-rendering with different `initialEntries` would remount it and destroy the
 * very state this is meant to exercise.
 */
let setSearchParams: ((next: URLSearchParams) => void) | null = null;
function SearchParamController() {
  const [, setParams] = useSearchParams();
  setSearchParams = setParams;
  return null;
}

function officeHeaderOf(call: unknown[] | undefined) {
  const options = call?.[1] as { headers?: Record<string, string> } | undefined;
  return options?.headers?.["x-office-id"];
}

function pendingFetches() {
  return apiMock.mock.calls.filter(([path]) => path === "/tasks/pending-acknowledgement");
}

/** The office the last render/navigation put in the URL, so reload() can rebuild the same page. */
let currentOfficeId: string | null = null;

async function render(
  flag: boolean | undefined,
  {
    officeId,
    activeOfficeId,
    userId = "u1",
    assignmentModalSession = 0,
    assignmentModalSessionResetPending = false,
  }: {
    officeId?: string | null;
    activeOfficeId?: string;
    userId?: string;
    assignmentModalSession?: number;
    assignmentModalSessionResetPending?: boolean;
  } = {}
) {
  currentOfficeId = officeId ?? null;
  authMock.mockReturnValue({
    user:
      flag === undefined
        ? null
        : {
            id: userId,
            hasPendingTaskAssignments: flag,
            officeId: HOME_OFFICE,
            // The office the server computed the flag under. authMiddleware promotes x-office-id into
            // activeOfficeId, so a boot on ?officeId=X gets a flag that describes X.
            activeOfficeId: activeOfficeId ?? officeId ?? HOME_OFFICE,
          },
    assignmentModalSession,
    assignmentModalSessionResetPending,
    consumeAssignmentModalSessionReset: consumeAssignmentModalSessionResetMock,
  });
  const entry = officeId ? `/?officeId=${encodeURIComponent(officeId)}` : "/";
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[entry]}>
        <SearchParamController />
        <TaskAssignmentModal />
      </MemoryRouter>
    );
  });
  await settle();
}

/**
 * What a page refresh does to this component: the whole tree is thrown away and rebuilt, so every ref
 * and every piece of state goes with it. sessionStorage does not.
 */
async function reload({
  userId,
  assignmentModalSession,
  assignmentModalSessionResetPending,
}: {
  userId?: string;
  assignmentModalSession?: number;
  assignmentModalSessionResetPending?: boolean;
} = {}) {
  const officeId = currentOfficeId;
  if (root) {
    await act(async () => {
      root?.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  container.remove();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await render(true, { officeId, userId, assignmentModalSession, assignmentModalSessionResetPending });
}

async function changeOfficeTo(officeId: string) {
  currentOfficeId = officeId;
  await act(async () => {
    setSearchParams?.(new URLSearchParams({ officeId }));
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
  consumeAssignmentModalSessionResetMock.mockReset();
  container = document.createElement("div");
  document.body.innerHTML = "";
  document.body.appendChild(container);
  root = createRoot(container);
  // The once-per-login guard now lives in sessionStorage, which jsdom shares across tests in a file.
  // Without this, whichever test ran first would silently suppress the modal in all the others.
  window.sessionStorage.clear();
  currentOfficeId = null;
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
  it("opens, and names the task and where it came from", async () => {
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

    expect(pendingFetches()).toHaveLength(1);
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

  // UNDER StrictMode, which is how the app actually runs (main.tsx wraps <App/> in it) and the only
  // thing that can exercise the latch. A plain re-render proves nothing: `hasPending` does not change,
  // so the effect's dependency list already stops it, and the test stays green with the latch deleted.
  // StrictMode deliberately mounts, unmounts and remounts every effect — without the ref, that is two
  // fetches per boot and, worse, a dialog that can re-open after the user has dismissed it.
  it("fetches once per boot even under StrictMode's double-invoke", async () => {
    setPending([task()]);
    authMock.mockReturnValue({
      user: { id: "u1", hasPendingTaskAssignments: true, officeId: HOME_OFFICE, activeOfficeId: HOME_OFFICE },
    });

    await act(async () => {
      root?.render(
        <StrictMode>
          <MemoryRouter>
            <SearchParamController />
            <TaskAssignmentModal />
          </MemoryRouter>
        </StrictMode>
      );
    });
    await settle();

    expect(dialog()).not.toBeNull();
    expect(apiMock.mock.calls.filter(([p]) => p === "/tasks/pending-acknowledgement")).toHaveLength(1);
  });

  it("does not refetch on a re-render", async () => {
    setPending([task()]);
    await render(true);

    // Same tree, re-rendered. A DIFFERENT tree would move the component and remount it, which resets
    // the latch and makes this pass for the wrong reason.
    await render(true);

    expect(pendingFetches()).toHaveLength(1);
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
      json: {
        assignments: [
          { taskId: "t1", assignmentVersion: "2026-08-25T12:34:56.123456Z" },
          { taskId: "t2", assignmentVersion: "2026-08-25T12:34:56.123456Z" },
        ],
      },
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
    expect(acknowledgeCalls()[0]![1]).toMatchObject({
      json: { assignments: [{ taskId: "t1", assignmentVersion: "2026-08-25T12:34:56.123456Z" }] },
    });
  });

  it("acknowledges AND navigates on View all tasks", async () => {
    setPending([task({ id: "t1" })]);
    await render(true);

    await click(buttonLabelled("View all tasks"));

    expect(navigateMock).toHaveBeenCalledWith("/tasks");
    expect(acknowledgeCalls()).toHaveLength(1);
  });

  // TWO DISMISSALS IN ONE TICK, which is the only shape that can actually exercise the latch. Clicking
  // Close twice in sequence proves nothing: the first click unmounts the dialog, so the second finds no
  // button and the test is green with the latch deleted. Both close paths have to fire before React
  // re-renders — the footer button (a plain onClick) and the header X (a Base UI DialogClose) — which
  // is exactly what a double-click, or Escape landing on the same frame as a backdrop click, produces.
  it("posts exactly one acknowledgement when two close paths fire in the same tick", async () => {
    setPending([task({ id: "t1" })]);
    await render(true);

    const footerClose = buttonLabelled("Close");
    const headerClose = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-close"]'))[0];
    expect(footerClose, "footer Close").toBeDefined();
    expect(headerClose, "header X").toBeDefined();

    await act(async () => {
      footerClose?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      headerClose?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    expect(acknowledgeCalls()).toHaveLength(1);
  });

  it("closes even if the acknowledge POST fails — the modal is not a hostage to the network", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/tasks/pending-acknowledgement") return { tasks: [task({ id: "t1" })], total: 1, newTotal: 1 };
      throw new Error("network down");
    });
    await render(true);

    await click(buttonLabelled("Close"));

    expect(dialog()).toBeNull();
  });
});

describe("TaskAssignmentModal — it says what is actually true", () => {
  // A repeat is not a new assignment. The server returns urgent/high/overdue work on EVERY login until
  // it leaves pending, so after the first showing "3 new tasks assigned to you since you were last
  // here" is simply false — and copy that is reliably false is how people learn to dismiss a modal
  // without reading it, which costs exactly the attention the feature was built to buy.

  it("calls new work new", async () => {
    setPending([task({ id: "n1" }), task({ id: "n2" })]);

    await render(true);

    expect(dialog()!.textContent).toContain("2 new tasks");
  });

  it("does NOT call a repeat a new assignment", async () => {
    setPending([repeat({ id: "r1", title: "Chase the Fisher permit" })]);

    await render(true);

    const text = dialog()!.textContent ?? "";
    expect(text).toContain("Chase the Fisher permit");
    expect(text).not.toMatch(/\bnew\b/i);
    expect(text).toContain("Still outstanding");
  });

  it("counts only the new ones in the heading when both kinds are present", async () => {
    setPending([task({ id: "n1" }), repeat({ id: "r1" }), repeat({ id: "r2" })]);

    await render(true);

    const heading = document.querySelector<HTMLElement>('[data-slot="dialog-title"]')!.textContent ?? "";
    expect(heading).toContain("a new task");
    // The three rows on screen are one new assignment and two reminders. A headline of "3" would be
    // counting work the person has already been shown.
    expect(heading).not.toContain("3");
  });

  it("separates the two groups so a repeat is never filed under new", async () => {
    setPending([task({ id: "n1", title: "Brand new thing" }), repeat({ id: "r1", title: "Old urgent thing" })]);

    await render(true);

    const groups = Array.from(document.querySelectorAll<HTMLElement>("[data-assignment-group]"));
    expect(groups.map((g) => g.dataset.assignmentGroup)).toEqual(["new", "outstanding"]);
    expect(groups[0]!.textContent).toContain("Brand new thing");
    expect(groups[0]!.textContent).not.toContain("Old urgent thing");
    expect(groups[1]!.textContent).toContain("Old urgent thing");
  });

  // A "New" label above the only list on screen labels nothing — the dialog title has already said it.
  // Group headings earn their space only when there is a second group to tell them apart from.
  it("renders no group heading at all when everything is new", async () => {
    setPending([task({ id: "n1" })]);

    await render(true);

    const groups = Array.from(document.querySelectorAll<HTMLElement>("[data-assignment-group]"));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.querySelector("h3")).toBeNull();
    expect(dialog()!.textContent).not.toContain("Still outstanding");
  });

  it("attributes a reassigned task to the person who assigned it", async () => {
    setPending([task({ assignedByName: "Carla Diaz" })]);

    await render(true);

    expect(dialog()!.textContent).toContain("Assigned by Carla Diaz");
    expect(dialog()!.textContent).not.toContain("Created by");
  });
});

/**
 * Hand control of WHEN each office's fetch resolves to the test.
 *
 * Overlapping office-scoped requests are the whole subject here, and they cannot be exercised at all
 * while every response resolves in issue order — the interleaving that breaks things is precisely the
 * one a synchronous mock can never produce.
 */
function deferredFetches() {
  const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  const issued: string[] = [];
  const signals = new Map<string, AbortSignal | undefined>();

  apiMock.mockImplementation((
    path: string,
    options?: { headers?: Record<string, string>; signal?: AbortSignal }
  ) => {
    if (path === "/tasks/acknowledge") return Promise.resolve(undefined);
    if (path !== "/tasks/pending-acknowledgement") throw new Error(`unexpected api call: ${path}`);
    const office = options?.headers?.["x-office-id"] ?? "(none)";
    issued.push(office);
    signals.set(office, options?.signal);
    return new Promise((resolve, reject) => waiting.set(office, { resolve, reject }));
  });

  return {
    /** How many times a fetch has been ISSUED for this office — not how many are outstanding. */
    issuedFor: (office: string) => issued.filter((entry) => entry === office).length,
    signalFor: (office: string) => signals.get(office),
    async resolveFor(office: string, tasks: PendingTask[]) {
      const settleFns = waiting.get(office);
      if (!settleFns) throw new Error(`no outstanding fetch for ${office}`);
      waiting.delete(office);
      settleFns.resolve({ tasks, total: tasks.length, newTotal: tasks.filter((t) => t.isNew).length });
      await settle();
    },
    async rejectFor(office: string) {
      const settleFns = waiting.get(office);
      if (!settleFns) throw new Error(`no outstanding fetch for ${office}`);
      waiting.delete(office);
      settleFns.reject(new Error("network is down"));
      await settle();
    },
  };
}

describe("TaskAssignmentModal — overlapping fetches", () => {
  // A LATCH ANSWERS "HAVE I STARTED?"; THIS IS ABOUT "WHICH REQUEST IS THIS THE ANSWER TO?"
  //
  // Keying the latch by office fixed "never refetches on an office change" and left request ORDERING
  // entirely untouched — two different questions, and one variable cannot hold both. When the two
  // office-scoped requests overlap, the abandoned office's response can land last and overwrite the
  // current office's batch. The office-mismatch render guard then hides that stale batch, while the
  // latch already reads as satisfied for the current office, so nothing ever fetches again: the user
  // sees NOTHING for the rest of the session, in the code that exists to show them something.
  //
  // Same underlying error as the StrictMode defect earlier in this branch — two mechanisms each
  // assuming they own the lifecycle. The fix is a request identity carried across the async boundary,
  // with a superseded response discarded without touching ANY state, the latch included.

  it("never lets a late response from an abandoned office replace the current one", async () => {
    const fetches = deferredFetches();
    await render(true, { officeId: "office-a" });
    const abandonedSignal = fetches.signalFor("office-a");
    await changeOfficeTo("office-b");
    expect(abandonedSignal?.aborted, "the abandoned office request kept running").toBe(true);

    // B wins the race and is displayed...
    await fetches.resolveFor("office-b", [task({ id: "b1", title: "Atlanta punch list" })]);
    expect(dialog()!.textContent).toContain("Atlanta punch list");

    // ...then A, long abandoned, finally answers.
    await fetches.resolveFor("office-a", [task({ id: "a1", title: "Dallas roof walk" })]);

    expect(dialog(), "the current office's modal must survive a superseded response").not.toBeNull();
    expect(dialog()!.textContent).toContain("Atlanta punch list");
    expect(dialog()!.textContent).not.toContain("Dallas roof walk");
  });

  it("aborts and ignores a response that settles after the modal unmounts", async () => {
    const fetches = deferredFetches();
    await render(true, { officeId: "office-a" });
    const abandonedSignal = fetches.signalFor("office-a");

    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    root = null;
    expect(abandonedSignal?.aborted, "the unmounted request kept running").toBe(true);

    // Model a transport that delivers a response despite abort. It may not update React state OR the
    // session shown-set: this assignment never reached a committed dialog and has no server ack.
    await fetches.resolveFor("office-a", [task({ id: "a1", title: "Never rendered" })]);
    expect(dialog()).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("lets a later office change fetch again — a superseded response must not poison the latch", async () => {
    const fetches = deferredFetches();
    await render(true, { officeId: "office-a" });
    await changeOfficeTo("office-b");
    await fetches.resolveFor("office-b", [task({ id: "b1" })]);
    await fetches.resolveFor("office-a", [task({ id: "a1" })]);
    expect(fetches.issuedFor("office-a")).toBe(1);

    await changeOfficeTo("office-a");

    // A losing response that "tidied up" by writing the latch would leave this at 1, and office A
    // would be permanently unfetchable for the rest of the session.
    expect(fetches.issuedFor("office-a")).toBe(2);
  });

  // The boot office's auth flag can truthfully say "nothing pending", so visiting it issues no
  // replacement request. If abandoning A leaves A/loading in the state machine, nothing overwrites
  // that latch and a later return to A mistakes an aborted request for one still in flight forever.
  it("refetches an aborted office after visiting a flag-scoped office that needs no fetch", async () => {
    const fetches = deferredFetches();
    await render(false, { officeId: "office-b" });
    expect(fetches.issuedFor("office-b")).toBe(0);

    await changeOfficeTo("office-a");
    const abandonedSignal = fetches.signalFor("office-a");
    expect(fetches.issuedFor("office-a")).toBe(1);

    await changeOfficeTo("office-b");
    expect(abandonedSignal?.aborted, "the abandoned office request kept running").toBe(true);
    expect(fetches.issuedFor("office-b")).toBe(0);

    await changeOfficeTo("office-a");
    expect(fetches.issuedFor("office-a")).toBe(2);
  });

  // A superseded response must leave NOTHING behind, not merely lose the last write. Both of the
  // interleavings above end with the winner's batch in state either way, so neither can tell "the
  // loser was discarded" apart from "the loser was overwritten". This one can: the winner comes back
  // EMPTY, so it writes no batch at all, and then the user returns to the abandoned office. If the
  // loser's response was ever written to state it is still sitting there, and it renders — a modal
  // built from a response the component decided long ago it did not want, shown without a fresh fetch.
  it("leaves nothing behind when a superseded response loses the race", async () => {
    const fetches = deferredFetches();
    await render(true, { officeId: "office-a" });
    await changeOfficeTo("office-b");

    await fetches.resolveFor("office-a", [task({ id: "a1", title: "Dallas roof walk" })]);
    await fetches.resolveFor("office-b", []);
    expect(dialog()).toBeNull();

    await changeOfficeTo("office-a");

    // Back on office A, with A's refetch still in flight. Nothing may be on screen yet.
    expect(dialog(), "a discarded response must not resurface when its office comes back").toBeNull();

    await fetches.resolveFor("office-a", [task({ id: "a2", title: "Fresh Dallas work" })]);
    expect(dialog()!.textContent).toContain("Fresh Dallas work");
    expect(dialog()!.textContent).not.toContain("Dallas roof walk");
  });
});

/**
 * Per-office canned answers, resolving immediately. For tests about WHICH office gets asked and what
 * comes back, where the interleaving is not the subject.
 */
function setPendingByOffice(
  byOffice: Record<string, { tasks: PendingTask[]; total?: number } | "fail">
) {
  apiMock.mockImplementation(async (path: string, options?: { headers?: Record<string, string> }) => {
    if (path === "/tasks/acknowledge") return undefined;
    if (path !== "/tasks/pending-acknowledgement") throw new Error(`unexpected api call: ${path}`);
    const office = options?.headers?.["x-office-id"] ?? "(none)";
    const answer = byOffice[office];
    if (!answer) throw new Error(`no canned answer for ${office}`);
    if (answer === "fail") throw new Error("network is down");
    return {
      tasks: answer.tasks,
      total: answer.total ?? answer.tasks.length,
      newTotal: answer.tasks.filter((t) => t.isNew).length,
    };
  });
}

describe("TaskAssignmentModal — a page refresh is not a new login", () => {
  // A refresh remounts the component and every ref with it, while the auth cookie is long-lived: boot
  // calls /auth/me, the flag comes back true because urgent/high/overdue repeats stay eligible by
  // design, and the same dialog opens again. Not once per login — once per RELOAD, which is the
  // permanent-nag failure this feature has already been rescued from once, arriving by another door.
  //
  // So "already shown" has to outlive the component. sessionStorage is the right lifetime and it is
  // worth being precise about why, because the spec ruled browser storage OUT for acknowledgement:
  // acknowledgement is an accountability record and has to survive a new device, so it belongs in the
  // database. This is the opposite kind of fact — "I have already interrupted you in this browsing
  // session" SHOULD die with the session, and logout() clears both storages, so the guard resets on
  // exactly the event that defines a new login.

  it("does not interrupt again after a reload", async () => {
    setPendingByOffice({ "office-a": { tasks: [repeat({ id: "a1", title: "Dallas roof walk" })] } });
    await render(true, { officeId: "office-a" });
    expect(dialog()!.textContent).toContain("Dallas roof walk");
    await click(buttonLabelled("Close"));

    await reload();

    expect(dialog(), "the same repeat, again, on every F5").toBeNull();
  });

  it("starts fresh when the same person completes a new explicit login", async () => {
    setPendingByOffice({ "office-a": { tasks: [repeat({ id: "a1", title: "Dallas roof walk" })] } });
    await render(true, { officeId: "office-a" });
    await click(buttonLabelled("Close"));

    // Session invalidation can send this person back through the login form without calling logout(),
    // so the old shown-set is still in sessionStorage. An actual successful login is a new session and
    // must clear it; treating every /auth/me boot that way would break the F5 assertion immediately above.
    await reload({ assignmentModalSession: 1, assignmentModalSessionResetPending: true });

    expect(dialog(), "a same-user re-login inherited the previous login's suppression").not.toBeNull();
    expect(dialog()!.textContent).toContain("Dallas roof walk");
    expect(consumeAssignmentModalSessionResetMock).toHaveBeenCalledWith(1);
  });

  it("does interrupt after a reload if something NEW has arrived since", async () => {
    setPendingByOffice({ "office-a": { tasks: [repeat({ id: "a1" })] } });
    await render(true, { officeId: "office-a" });
    await click(buttonLabelled("Close"));

    // Adam assigns something while the tab is open; the person reloads.
    setPendingByOffice({
      "office-a": { tasks: [task({ id: "a2", title: "Brand new work" }), repeat({ id: "a1" })] },
    });
    await reload();

    expect(dialog()!.textContent).toContain("Brand new work");
  });

  it("interrupts again when the same task id arrives as a newer assignment version", async () => {
    // A hand-away-and-back preserves the task id but changes assigned_at. Suppressing only by id would
    // treat this new handoff as the card already shown before the reassignment and hide it for the rest
    // of the session.
    setPendingByOffice({
      "office-a": {
        tasks: [
          repeat({
            id: "a1",
            title: "Dallas roof walk",
            assignmentVersion: "2026-08-25T12:34:56.000001Z",
          }),
        ],
      },
    });
    await render(true, { officeId: "office-a" });
    await click(buttonLabelled("Close"));

    setPendingByOffice({
      "office-a": {
        tasks: [
          task({
            id: "a1",
            title: "Dallas roof walk — reassigned back to you",
            assignmentVersion: "2026-08-25T12:34:56.000002Z",
          }),
        ],
      },
    });
    await reload();

    expect(dialog(), "the newer handoff inherited suppression from its old assignment").not.toBeNull();
    expect(dialog()!.textContent).toContain("reassigned back to you");
  });

  // ⚠️ THE CROWDED-OUT RULE, AGAIN — now for the thing that PERSISTS.
  //
  // The server sends five rows and a total. A sixth eligible task never crossed the wire, so nobody
  // saw it, and it is exactly the kind of row the unseen-first ordering exists to surface. Recording
  // "shown" from the TOTAL rather than from the rendered page would write that sixth task into
  // storage as already seen — and unlike the in-memory version, this one survives the reload, so the
  // task would be suppressed for the rest of the session without a person ever laying eyes on it.
  // Same failure the acknowledgement guard prevents, one layer further out and considerably quieter.
  it("does not record a task that was crowded out of the page it never appeared on", async () => {
    setPendingByOffice({
      "office-a": {
        tasks: [
          task({ id: "a1" }),
          repeat({ id: "a2" }),
          repeat({ id: "a3" }),
          repeat({ id: "a4" }),
          repeat({ id: "a5" }),
        ],
        total: 6,
      },
    });
    await render(true, { officeId: "office-a" });
    expect(dialog()!.textContent).toContain("1 more");
    await click(buttonLabelled("Close"));

    // The five acknowledged ones drop out; the sixth finally has room.
    setPendingByOffice({ "office-a": { tasks: [task({ id: "a6", title: "Was crowded out" })] } });
    await reload();

    expect(dialog(), "the sixth task was recorded as shown without ever being sent").not.toBeNull();
    expect(dialog()!.textContent).toContain("Was crowded out");
  });

  it("starts fresh for a different person signing in on the same tab", async () => {
    setPendingByOffice({ "office-a": { tasks: [repeat({ id: "a1", title: "Dallas roof walk" })] } });
    await render(true, { officeId: "office-a" });
    await click(buttonLabelled("Close"));

    // Not a logout — that clears storage on its own. This is the session-invalidation path, which
    // bounces to /login without clearing, so the key has to be scoped to the person.
    await reload({ userId: "u2" });

    expect(dialog()!.textContent).toContain("Dallas roof walk");
  });

  it("still works when sessionStorage refuses to store anything", async () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    try {
      setPendingByOffice({ "office-a": { tasks: [repeat({ id: "a1", title: "Dallas roof walk" })] } });
      await render(true, { officeId: "office-a" });

      // Private browsing and full quotas both throw here. The dialog is not allowed to die with it.
      expect(dialog()!.textContent).toContain("Dallas roof walk");
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("TaskAssignmentModal — once per office, per login", () => {
  // Urgent, high and overdue assignments stay eligible after acknowledgement — that is the repeat rule
  // and it is correct. But eligibility is a SERVER answer about a task, and "I have already
  // interrupted this person" is a CLIENT fact about this session, so for a cross-office user A -> B ->
  // A re-fetches A, finds the same repeats still eligible, and opens the same dialog a second time in
  // one login. The two facts live in different places for the same reason every other round on this
  // file did: fetchState answers what is being shown NOW, and it is replaced on every office change,
  // which is precisely when "already shown" has to survive.

  it("does not interrupt twice for the same office in one login", async () => {
    setPendingByOffice({
      "office-a": { tasks: [repeat({ id: "a1", title: "Dallas roof walk" })] },
      "office-b": { tasks: [] },
    });
    await render(true, { officeId: "office-a" });
    expect(dialog()!.textContent).toContain("Dallas roof walk");
    await click(buttonLabelled("Close"));

    await changeOfficeTo("office-b");
    await changeOfficeTo("office-a");

    expect(dialog(), "the same repeats, a second time, in one login").toBeNull();
    // Nothing was acknowledged a second time either, because nothing was shown a second time.
    expect(acknowledgeCalls()).toHaveLength(1);
    // Deliberately NO assertion here about whether office A was re-fetched. It is, and that belongs to
    // the refetch-on-office-change property, which has its own test below. Asserting it here as well
    // coupled this test to that guard: breaking the office arm made THIS test red, which reads as
    // "the once-per-login guard is broken" when the truth is that the request was never issued.
  });

  // The other half, kept separate for that reason. What is suppressed is the second INTERRUPTION, not
  // the second question — the answer may have changed, and a new assignment arriving while the person
  // was in office B has to be able to surface, which is why the guard sits on opening the dialog
  // rather than on issuing the request.
  it("still ASKS the office again on return, even though it will not interrupt", async () => {
    setPendingByOffice({
      "office-a": { tasks: [repeat({ id: "a1" })] },
      "office-b": { tasks: [] },
    });
    await render(true, { officeId: "office-a" });
    await click(buttonLabelled("Close"));

    await changeOfficeTo("office-b");
    await changeOfficeTo("office-a");

    expect(pendingFetches().filter((c) => officeHeaderOf(c) === "office-a")).toHaveLength(2);
  });

  it("still interrupts for an office it has NOT shown yet", async () => {
    setPendingByOffice({
      "office-a": { tasks: [repeat({ id: "a1" })] },
      "office-b": { tasks: [task({ id: "b1", title: "Atlanta punch list" })] },
    });
    await render(true, { officeId: "office-a" });
    await click(buttonLabelled("Close"));

    await changeOfficeTo("office-b");

    expect(dialog()!.textContent).toContain("Atlanta punch list");
  });

  // "Shown" must mean the dialog went on screen, not that a response arrived. Each of the next three
  // put nothing in front of anybody, so each office must remain askable.
  it("does not count an office whose list came back EMPTY as shown", async () => {
    setPendingByOffice({ "office-a": { tasks: [] }, "office-b": { tasks: [] } });
    await render(true, { officeId: "office-a" });
    expect(dialog()).toBeNull();

    await changeOfficeTo("office-b");
    setPendingByOffice({
      "office-a": { tasks: [task({ id: "a1", title: "Arrived later" })] },
      "office-b": { tasks: [] },
    });
    await changeOfficeTo("office-a");

    expect(dialog()!.textContent).toContain("Arrived later");
  });

  it("does not count an office whose fetch FAILED as shown", async () => {
    setPendingByOffice({ "office-a": "fail", "office-b": { tasks: [] } });
    await render(true, { officeId: "office-a" });
    expect(dialog()).toBeNull();

    await changeOfficeTo("office-b");
    setPendingByOffice({
      "office-a": { tasks: [task({ id: "a1", title: "Worked this time" })] },
      "office-b": { tasks: [] },
    });
    await changeOfficeTo("office-a");

    expect(dialog()!.textContent).toContain("Worked this time");
  });

  it("does not count a SUPERSEDED response as shown", async () => {
    const fetches = deferredFetches();
    await render(true, { officeId: "office-a" });
    await changeOfficeTo("office-b");
    // Office A answers after it was abandoned: discarded, and it showed nobody anything.
    await fetches.resolveFor("office-a", [task({ id: "a1", title: "Discarded" })]);
    await fetches.resolveFor("office-b", []);

    await changeOfficeTo("office-a");
    await fetches.resolveFor("office-a", [task({ id: "a2", title: "Actually shown" })]);

    expect(dialog()!.textContent).toContain("Actually shown");
  });

  // ⚠️ THE ONE THAT COULD UNDO THE STARVATION FIX FROM BEHIND.
  //
  // The server returns five rows and a total. A sixth ELIGIBLE task was never sent, never rendered and
  // never seen — and it is exactly the kind of row the unseen-first ordering exists to get in front of
  // somebody. If "shown" were ever taken to mean "was in the result set" or, worse, if the client
  // acknowledged anything beyond what it rendered, that sixth task would be marked as dealt with
  // without a person ever laying eyes on it. It would then never appear again, and the P1 this branch
  // fixed would be back through a door nobody was watching.
  it("never acknowledges an eligible task it did not render", async () => {
    const rendered = ["a1", "a2", "a3", "a4", "a5"];
    setPendingByOffice({
      // Five rendered out of six eligible: one unseen at the front, four repeats, one crowded out.
      "office-a": {
        tasks: [
          task({ id: "a1" }),
          repeat({ id: "a2" }),
          repeat({ id: "a3" }),
          repeat({ id: "a4" }),
          repeat({ id: "a5" }),
        ],
        total: 6,
      },
      "office-b": { tasks: [] },
    });
    await render(true, { officeId: "office-a" });
    expect(dialog()!.textContent).toContain("1 more");

    await click(buttonLabelled("Close"));
    await changeOfficeTo("office-b");
    await changeOfficeTo("office-a");

    const acknowledged = acknowledgeCalls().flatMap(acknowledgedTaskIds);
    expect(acknowledged).toEqual(rendered);
    expect(acknowledged, "the crowded-out task was marked seen without being shown").not.toContain("a6");
  });
});

describe("TaskAssignmentModal — a failed fetch is not an answer", () => {
  // ROUND THREE OF THE SAME DEFECT, and the reason the lifecycle is a state machine now rather than a
  // pile of refs. "Not started", "in flight", "failed" and "succeeded" are four outcomes; a boolean
  // latch can hold two. Every round added another ref to express the case the last one could not, and
  // the refs then disagreed with each other — which is exactly how the StrictMode defect happened, a
  // cancelled flag and a latch cancelling out. The state machine knows whether it has an ANSWER, so
  // "failed" is simply not "loaded" and the effect's own condition allows the retry. No latch.

  it("retries once on its own after a failure — a failed request is not an answer", async () => {
    const fetches = deferredFetches();
    await render(true, { officeId: "office-a" });
    expect(fetches.issuedFor("office-a")).toBe(1);

    await fetches.rejectFor("office-a");

    // No trigger from the user, no office change: the failure itself leaves the machine without an
    // answer, so it asks again. Under a latch this stays at 1 forever.
    expect(fetches.issuedFor("office-a")).toBe(2);
  });

  it("stops after the retry instead of hammering a server that is already unhappy", async () => {
    const fetches = deferredFetches();
    await render(true, { officeId: "office-a" });
    await fetches.rejectFor("office-a");
    await fetches.rejectFor("office-a");

    expect(fetches.issuedFor("office-a")).toBe(MAX_ATTEMPTS);
  });

  it("still lets an office change ask again after both attempts failed", async () => {
    const fetches = deferredFetches();
    await render(true, { officeId: "office-a" });
    await fetches.rejectFor("office-a");
    await fetches.rejectFor("office-a");

    await changeOfficeTo("office-b");
    await changeOfficeTo("office-a");

    // A fresh office resets the attempt count — the failure was about a moment, not about the office.
    expect(fetches.issuedFor("office-a")).toBe(MAX_ATTEMPTS + 1);
  });

  // An empty modal and a broken request must never look the same. Rendering "nothing assigned to you"
  // off the back of a failure is a reassuring lie, and the person it reassures is the one who was
  // supposed to be told about the work.
  it("renders nothing at all on failure, never an empty assignment list", async () => {
    const fetches = deferredFetches();
    await render(true, { officeId: "office-a" });

    await fetches.rejectFor("office-a");
    await fetches.rejectFor("office-a");

    expect(dialog(), "a failed check must not present itself as an answer").toBeNull();
    expect(document.body.textContent).not.toMatch(/no (new )?tasks/i);
    expect(document.body.textContent).not.toContain("Still on your plate");
  });

  it("recovers completely — the automatic retry shows the assignments", async () => {
    const fetches = deferredFetches();
    await render(true, { officeId: "office-a" });

    await fetches.rejectFor("office-a");
    await fetches.resolveFor("office-a", [task({ id: "a1", title: "Dallas roof walk" })]);

    expect(dialog()!.textContent).toContain("Dallas roof walk");
  });
});

describe("TaskAssignmentModal — office scope", () => {
  // Office scope is URL-DRIVEN, not user state: api() reads ?officeId out of window.location on every
  // call and turns it into x-office-id, which authMiddleware promotes to activeOfficeId and
  // tenantMiddleware turns into a search_path. So the tenant a request lands in is decided at CALL
  // time, and an authorized cross-office user changes it by navigating -- no remount, no refreshUser.
  //
  // That makes a one-shot fetch latch wrong in two ways at once. The modal never refetches for the new
  // tenant, and -- the half that matters -- an acknowledgement posted after the change lands in the NEW
  // office, where the server's ownership filter finds none of the old office's ids and writes nothing.
  // The user sees a modal close; the database sees no acknowledgement; the tasks return at the next
  // login. It degrades to a no-op rather than a cross-tenant write, which is the server-side ownership
  // re-derivation doing its job, but a no-op the user reads as "I closed it" is still a bug and it is
  // completely silent.

  it("pins the fetch to the scoped office instead of trusting ambient location state", async () => {
    setPending([task({ id: "a1" })]);

    await render(true, { officeId: "office-a" });

    expect(officeHeaderOf(pendingFetches()[0])).toBe("office-a");
  });

  // Explicit even for the home office. api() would otherwise fall back to reading window.location, so
  // an unpinned request is one navigation away from resolving to a different tenant than the caller
  // intended -- and hasOfficeHeader() means an explicit header is what stops that fallback.
  it("pins the fetch to the HOME office when the URL carries no ?officeId", async () => {
    setPending([task({ id: "h1" })]);

    await render(true);

    expect(officeHeaderOf(pendingFetches()[0])).toBe(HOME_OFFICE);
  });

  it("refetches when the office scope changes", async () => {
    setPending([task({ id: "a1" })]);
    await render(true, { officeId: "office-a" });
    expect(pendingFetches()).toHaveLength(1);

    await changeOfficeTo("office-b");

    expect(pendingFetches()).toHaveLength(2);
    expect(officeHeaderOf(pendingFetches()[1])).toBe("office-b");
  });

  // The auth flag describes the office it was computed under and nothing else -- nothing calls
  // refreshUser on an office change, so it still reports the boot office forever. Gating every office
  // on it would mean a cross-office user whose home office is quiet never sees an assignment in any
  // other office. Where the flag cannot speak, ask the server.
  it("fetches for a newly selected office even though the boot flag said false", async () => {
    setPending([task({ id: "b1" })]);
    await render(false, { officeId: "office-a" });
    expect(pendingFetches()).toHaveLength(0);

    await changeOfficeTo("office-b");

    expect(pendingFetches()).toHaveLength(1);
    expect(officeHeaderOf(pendingFetches()[0])).toBe("office-b");
    expect(dialog()).not.toBeNull();
  });

  it("does not refetch when the office scope is unchanged", async () => {
    setPending([task({ id: "a1" })]);
    await render(true, { officeId: "office-a" });

    await changeOfficeTo("office-a");

    expect(pendingFetches()).toHaveLength(1);
  });

  it("stops showing one tenant's assignments the moment the scope moves to another", async () => {
    setPending([task({ id: "a1", title: "Dallas roof walk" })]);
    await render(true, { officeId: "office-a" });
    expect(dialog()!.textContent).toContain("Dallas roof walk");

    apiMock.mockImplementation(async (path: string) => {
      if (path === "/tasks/pending-acknowledgement") return { tasks: [], total: 0, newTotal: 0 };
      if (path === "/tasks/acknowledge") return undefined;
      throw new Error(`unexpected api call: ${path}`);
    });
    await changeOfficeTo("office-b");

    expect(dialog()).toBeNull();
  });

  // THE ONE THE FINDING IS ABOUT. Whatever else happens, no acknowledgement may pair one office's task
  // ids with another office's header -- that request writes nothing and reports success.
  it("never posts one tenant's task ids against another tenant", async () => {
    setPending([task({ id: "a1" }), task({ id: "a2" })]);
    await render(true, { officeId: "office-a" });

    apiMock.mockImplementation(async (path: string) => {
      if (path === "/tasks/pending-acknowledgement") return { tasks: [task({ id: "b1" })], total: 1, newTotal: 1 };
      if (path === "/tasks/acknowledge") return undefined;
      throw new Error(`unexpected api call: ${path}`);
    });
    await changeOfficeTo("office-b");

    // Office B's own modal is what is on screen now, and closing it acknowledges B's task under B.
    await click(buttonLabelled("Close"));

    for (const call of acknowledgeCalls()) {
      const ids = acknowledgedTaskIds(call);
      const office = officeHeaderOf(call);
      const carriesOfficeAIds = ids.some((id) => id === "a1" || id === "a2");
      expect(carriesOfficeAIds && office !== "office-a", `${ids.join(",")} posted to ${office}`).toBe(false);
    }
    expect(acknowledgeCalls()).toHaveLength(1);
    expect(acknowledgedTaskIds(acknowledgeCalls()[0]!)).toEqual(["b1"]);
    expect(officeHeaderOf(acknowledgeCalls()[0])).toBe("office-b");
  });

  it("acknowledges against the office the batch was FETCHED under, not the one in the URL now", async () => {
    setPending([task({ id: "a1" })]);
    await render(true, { officeId: "office-a" });

    await click(buttonLabelled("Close"));

    expect(officeHeaderOf(acknowledgeCalls()[0])).toBe("office-a");
    expect(acknowledgedTaskIds(acknowledgeCalls()[0]!)).toEqual(["a1"]);
  });

  it("carries the office scope through to the tasks page", async () => {
    setPending([task({ id: "a1" })]);
    await render(true, { officeId: "office-a" });

    await click(buttonLabelled("View all tasks"));

    // Dropping ?officeId here would open the HOME office's task list, which does not contain any of
    // the assignments the modal just named.
    expect(navigateMock).toHaveBeenCalledWith("/tasks?officeId=office-a");
  });

  it("acknowledges against the HOME office explicitly when the URL carries no ?officeId", async () => {
    setPending([task({ id: "h1" })]);
    await render(true);

    await click(buttonLabelled("Close"));

    expect(officeHeaderOf(acknowledgeCalls()[0])).toBe(HOME_OFFICE);
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
