// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useDeals: vi.fn(),
  createWeeklyReportProject: vi.fn(),
  updateWeeklyReportProject: vi.fn(),
  useWeeklyReportAssignableUsers: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({ useDeals: mocks.useDeals }));
vi.mock("@/hooks/use-weekly-reports", () => ({
  createWeeklyReportProject: mocks.createWeeklyReportProject,
  updateWeeklyReportProject: mocks.updateWeeklyReportProject,
  deleteWeeklyReportProject: vi.fn(),
  useWeeklyReportAssignableUsers: mocks.useWeeklyReportAssignableUsers,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { WeeklyReportProjectDialog } from "./weekly-report-project-dialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.useDeals.mockReset();
  mocks.useDeals.mockReturnValue({ deals: [], loading: false, error: null });
  mocks.useWeeklyReportAssignableUsers.mockReset();
  mocks.useWeeklyReportAssignableUsers.mockReturnValue({
    users: [{ id: "u-pm", displayName: "Adam Sherwood", email: "pm@example.com", role: "construction" }],
    loading: false,
    error: null,
  });
  mocks.createWeeklyReportProject.mockReset();
  mocks.updateWeeklyReportProject.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderNew() {
  act(() => {
    root.render(<WeeklyReportProjectDialog project={null} onClose={vi.fn()} onSaved={vi.fn()} />);
  });
}

describe("deal picker scope", () => {
  it("asks for scope=all, so a director can find a project they don't own", () => {
    // GET /deals silently defaults to scope=mine. That default has already shipped as a bug in two
    // other pickers: setting up a superintendent's project would simply find nothing.
    renderNew();
    const calls = mocks.useDeals.mock.calls;
    const filters = calls[calls.length - 1]?.[0];
    expect(filters).toMatchObject({ scope: "all" });
  });

  it("does not query until the search term is worth a round trip", () => {
    renderNew();
    const calls = mocks.useDeals.mock.calls;
    const options = calls[calls.length - 1]?.[1];
    expect(options).toMatchObject({ enabled: false });
  });
});

describe("deals that already have a setup", () => {
  it("are not offered, so the form cannot be filled in for a project the server will refuse", () => {
    // The unique index answers 409 on a second live setup. Offering the deal anyway let someone pick
    // it, complete the whole form, and only then be told no.
    mocks.useDeals.mockReturnValue({
      deals: [
        { id: "d-taken", name: "4123 Cedar Springs", dealNumber: "DFW-10432", projectNumber: "DFW-10432" },
        { id: "d-free", name: "Katy Freeway Shops", dealNumber: "DFW-10433", projectNumber: "DFW-10433" },
      ],
      loading: false,
      error: null,
    });

    act(() => {
      root.render(
        <WeeklyReportProjectDialog
          project={null}
          existingDealIds={["d-taken"]}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
    });
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search for a project"]')!;
    vi.useFakeTimers();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(search, "DFW");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The search is debounced by 250ms; without advancing it the results list never renders and the
    // assertion below would pass for the wrong reason.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    vi.useRealTimers();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Katy Freeway Shops");
    expect(text).not.toContain("4123 Cedar Springs");
  });
});

describe("assignable users", () => {
  it("keeps an assigned-but-inactive person visible instead of silently reading as Unassigned", () => {
    const project = {
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
      // Not in the roster the hook returned — deactivated, or moved office.
      trockPmUserId: "u-gone",
      trockPmName: "Departed PM",
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
    };

    act(() => {
      root.render(<WeeklyReportProjectDialog project={project} onClose={vi.fn()} onSaved={vi.fn()} />);
    });

    // The dialog renders through a portal, so it lives on document.body rather than inside `container`.
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="T-Rock project manager"]');
    expect(select).not.toBeNull();
    // A controlled select whose value isn't among its options renders blank while still holding the id,
    // so the form would look Unassigned and re-save as such.
    expect(select!.value).toBe("u-gone");
    expect(Array.from(select!.options).map((option) => option.value)).toContain("u-gone");
  });
});
