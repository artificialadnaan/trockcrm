// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWeeklyReportProject: vi.fn(),
  updateWeeklyReportProject: vi.fn(),
  useWeeklyReportAssignableUsers: vi.fn(),
  useWeeklyReportEligibleDeals: vi.fn(),
}));

vi.mock("@/hooks/use-weekly-reports", () => ({
  createWeeklyReportProject: mocks.createWeeklyReportProject,
  updateWeeklyReportProject: mocks.updateWeeklyReportProject,
  deleteWeeklyReportProject: vi.fn(),
  useWeeklyReportAssignableUsers: mocks.useWeeklyReportAssignableUsers,
  useWeeklyReportEligibleDeals: mocks.useWeeklyReportEligibleDeals,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { WeeklyReportProjectDialog } from "./weekly-report-project-dialog";

let container: HTMLDivElement;
let root: Root;

/**
 * The roster the pickers are fed from, shaped like the live one: a PM whose CRM login is a `rep`
 * (Adam Sherwood — the person this whole change exists for), and a superintendent with no login at all.
 */
const ROSTER = [
  { id: "fr-pm", name: "Adam Sherwood", email: "asherwood@trockgc.com", role: "project_manager" as const, hasLogin: true },
  { id: "fr-pm2", name: "Nick Cheatam", email: "ncheatam@trockgc.com", role: "project_manager" as const, hasLogin: false },
  { id: "fr-sup", name: "Steve Sanchez", email: "ssanchez@trockgc.com", role: "superintendent" as const, hasLogin: true },
];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.useWeeklyReportAssignableUsers.mockReset();
  mocks.useWeeklyReportAssignableUsers.mockReturnValue({
    users: [],
    responders: ROSTER,
    loading: false,
    error: null,
  });
  mocks.useWeeklyReportEligibleDeals.mockReset();
  mocks.useWeeklyReportEligibleDeals.mockReturnValue({ deals: [], loading: false });
  mocks.createWeeklyReportProject.mockReset();
  mocks.updateWeeklyReportProject.mockReset();
});

afterEach(() => {
  // Unconditional, because the useFakeTimers/useRealTimers pairs below live INSIDE test bodies: an
  // assertion that throws between them leaves fake timers installed for every later test in this file,
  // and the async "closing mid-save" test then awaits a promise that never settles.
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
});

function renderNew() {
  act(() => {
    root.render(<WeeklyReportProjectDialog project={null} onClose={vi.fn()} onSaved={vi.fn()} />);
  });
}

function selectByLabel(label: string): HTMLSelectElement {
  // The dialog renders through a portal, so it lives on document.body rather than inside `container`.
  const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(select, `no select labelled ${label}`).not.toBeNull();
  return select!;
}

function optionLabels(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((option) => option.textContent ?? "");
}

/** Type into a controlled input the way React will actually observe. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the PM and superintendent pickers", () => {
  it("offer the field-team roster, including a PM whose CRM login is a plain rep", () => {
    // The bug this replaces: the picker listed public.users filtered to four broad roles, so Adam
    // Sherwood — a `rep` login who is genuinely a PM on the roster — could not be selected at all.
    // Nine of fifteen roster people were unofferable for that reason or for having no login.
    renderNew();
    expect(optionLabels(selectByLabel("T-Rock project manager")).join("|")).toContain("Adam Sherwood");
  });

  it("filters each picker to the roster role that slot expects", () => {
    // The server checks the roster row's own role, so offering a superintendent in the PM picker would
    // produce a 400 on save for no reason the user could see.
    renderNew();
    const pm = optionLabels(selectByLabel("T-Rock project manager")).join("|");
    const superintendent = optionLabels(selectByLabel("T-Rock superintendent")).join("|");

    expect(pm).toContain("Adam Sherwood");
    expect(pm).not.toContain("Steve Sanchez");
    expect(superintendent).toContain("Steve Sanchez");
    expect(superintendent).not.toContain("Adam Sherwood");
  });

  it("marks a roster person who has no CRM login, in the option itself", () => {
    // They can hold the slot and print on the report, but they cannot approve or send — the option has
    // to say so at the point of choosing, not on the Thursday a report needs approving.
    renderNew();
    const labels = optionLabels(selectByLabel("T-Rock project manager"));
    expect(labels.find((label) => label.includes("Nick Cheatam"))).toContain("no app login");
    expect(labels.find((label) => label.includes("Adam Sherwood"))).not.toContain("no app login");
  });

  it("submits the ROSTER id, and no user id at all", () => {
    // The server derives trock_pm_user_id from the roster row's email. A payload carrying a user id
    // would be a caller nominating an arbitrary account into the slot that decides who may approve and
    // send — so the ABSENCE of that key is as much the assertion as the presence of the roster one.
    //
    // Edit mode, so a deal is already attached and the submit actually reaches the request. Asserting on
    // the control's own value instead would pass no matter what the form went on to send.
    act(() => {
      root.render(
        <WeeklyReportProjectDialog project={existingProject()} onClose={vi.fn()} onSaved={vi.fn()} />,
      );
    });

    const select = selectByLabel("T-Rock project manager");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "fr-pm");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    mocks.updateWeeklyReportProject.mockResolvedValue({});
    act(() => {
      document
        .querySelector<HTMLFormElement>("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.updateWeeklyReportProject).toHaveBeenCalledTimes(1);
    const payload = mocks.updateWeeklyReportProject.mock.calls[0][1];
    expect(payload).toMatchObject({ trockPmResponderId: "fr-pm" });
    expect(payload).not.toHaveProperty("trockPmUserId");
    expect(payload).not.toHaveProperty("trockSuperUserId");
  });

  it("keeps a person who has left the roster selected instead of silently reading as Unassigned", () => {
    // A controlled select whose value isn't among its options renders blank while still holding the id,
    // so the form would look Unassigned and re-save as such — quietly dropping whoever was approving.
    const project = existingProject({ trockPmResponderId: "fr-gone", trockPmName: "Departed PM" });
    act(() => {
      root.render(<WeeklyReportProjectDialog project={project} onClose={vi.fn()} onSaved={vi.fn()} />);
    });

    const select = selectByLabel("T-Rock project manager");
    expect(select.value).toBe("fr-gone");
    expect(optionLabels(select).join("|")).toContain("Departed PM");
  });
});

describe("the dialog's own width", () => {
  it("overrides the primitive's sm:max-w-sm instead of sitting alongside it", () => {
    // THE BUG THIS PINS: DialogContent's base class list contains `sm:max-w-sm`, and `cn()` is
    // tailwind-merge — which treats an UNPREFIXED `max-w-5xl` from a caller as a different key from the
    // `sm:`-prefixed base and keeps BOTH. At every desktop width the 384px base then wins, so a dialog
    // asking for 5xl rendered at roughly a third of it. Seventeen dialogs across this app are still
    // written the unprefixed way; these two are not.
    //
    // Asserted on the CLASS rather than a measured width because jsdom applies no stylesheet, so a
    // getBoundingClientRect assertion here would read 0 for every variant and prove nothing.
    renderNew();
    const content = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
    expect(content).not.toBeNull();
    expect(content.className).toContain("sm:!max-w-");
    expect(content.className).not.toMatch(/(?<!!)\bmax-w-\dxl\b/);
  });
});

describe("the project picker", () => {
  it("does not query until the search term is worth a round trip", () => {
    renderNew();
    // (search, enabled) — enabled false while the box is empty.
    expect(mocks.useWeeklyReportEligibleDeals).toHaveBeenLastCalledWith("", false);
  });

  it("searches the Won-only feed once the term is long enough", () => {
    renderNew();
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search for a project"]')!;
    vi.useFakeTimers();
    typeInto(search, "Cedar");
    act(() => {
      vi.advanceTimersByTime(300); // the box is debounced by 250ms
    });
    vi.useRealTimers();

    expect(mocks.useWeeklyReportEligibleDeals).toHaveBeenLastCalledWith("Cedar", true);
  });
});

describe("picking a job", () => {
  function pickTheOnlyResult() {
    renderNew();
    mocks.useWeeklyReportEligibleDeals.mockReturnValue({
      deals: [
        {
          id: "d-1",
          name: "4123 Cedar Springs",
          dealNumber: "DFW-10432",
          projectNumber: "DFW-10432",
          clientName: "Mack Real Estate Group",
          contractSignedDate: "2026-07-08",
        },
      ],
      loading: false,
    });

    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search for a project"]')!;
    vi.useFakeTimers();
    typeInto(search, "Cedar");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    vi.useRealTimers();

    const option = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("4123 Cedar Springs"),
    )!;
    expect(option, "the searched job was not offered").toBeTruthy();
    act(() => {
      option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("fills in the client company and the contract date from the job", () => {
    // Both were retyped by hand on every setup, from data the deal already carries.
    pickTheOnlyResult();

    const client = document.querySelector<HTMLInputElement>('input[placeholder="Mack Real Estate Group"]')!;
    const contract = document.querySelector<HTMLInputElement>('input[aria-label="Contract date date"]')!;
    expect(client.value).toBe("Mack Real Estate Group");
    expect(contract.value).toBe("2026-07-08");
  });

  it("fills in the property name from the job", () => {
    pickTheOnlyResult();
    const property = document.querySelector<HTMLInputElement>('input[placeholder="4123 Cedar Springs"]')!;
    expect(property.value).toBe("4123 Cedar Springs");
  });
});

function existingProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    dealId: "d1",
    dealName: "4123 Cedar Springs",
    dealNumber: "DFW-10432",
    projectNumber: "DFW-10432",
    propertyDisplayName: "4123 Cedar Springs",
    clientName: "Mack Real Estate Group",
    clientTeam: {
      doc: { name: null, email: null },
      pm: { name: null, email: null },
      rm: { name: null, email: null },
      cm: { name: null, email: null },
    },
    trockPmResponderId: null,
    trockPmUserId: null,
    trockPmName: null,
    trockSuperResponderId: null,
    trockSuperUserId: null,
    trockSuperName: null,
    contractDate: null,
    contractDateNote: null,
    projectStartDate: null,
    projectStartDateNote: null,
    projectCompletionDate: null,
    projectCompletionDateNote: null,
    projectedDurationWeeks: null,
    cadenceWeekday: 4,
    cadenceStartDate: "2026-07-27",
    cadenceEndDate: null,
    status: "active" as const,
    createdAt: "2026-07-27T00:00:00Z",
    updatedAt: "2026-07-27T00:00:00Z",
    ...overrides,
  };
}

describe("closing mid-save", () => {
  function submitForm() {
    const form = document.querySelector<HTMLFormElement>("form")!;
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  function clickCloseControl() {
    const close = document.querySelector<HTMLElement>('[data-slot="dialog-close"]')!;
    act(() => {
      close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("ignores the close control while a save is in flight", async () => {
    // The footer buttons are disabled during a save, but the close control, Escape and the backdrop are
    // not. Closing here does not merely lose the edit: the in-flight request still resolves into
    // `onSaved`, which clears the page's shared creating/editing state — closing whichever dialog the
    // user has opened in the meantime.
    let settle: (value: unknown) => void = () => {};
    mocks.updateWeeklyReportProject.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const onClose = vi.fn();
    const onSaved = vi.fn();

    act(() => {
      root.render(
        <WeeklyReportProjectDialog project={existingProject()} onClose={onClose} onSaved={onSaved} />,
      );
    });

    submitForm();
    expect(mocks.updateWeeklyReportProject).toHaveBeenCalledTimes(1);

    clickCloseControl();
    expect(onClose).not.toHaveBeenCalled();

    // …and once the request lands the dialog is closable again, so a failed save is not a trap.
    await act(async () => {
      settle({});
    });
    clickCloseControl();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("still closes on the close control when nothing is saving", () => {
    // The control case: without this, the assertion above would pass for a dialog whose close control
    // never worked at all.
    const onClose = vi.fn();
    act(() => {
      root.render(
        <WeeklyReportProjectDialog project={existingProject()} onClose={onClose} onSaved={vi.fn()} />,
      );
    });

    clickCloseControl();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
