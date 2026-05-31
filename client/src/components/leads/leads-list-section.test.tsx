// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { LeadsListSection, LEADS_LIST_PAGE_SIZE } from "./leads-list-section";
import { LEAD_LIST_SORT_OPTIONS, LEAD_STATUS_OPTIONS } from "./leads-filterbar-adapter";
import type { FilterDimension, FilterBarOptions } from "@/components/filters/filter-bar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ useLeadsMock: vi.fn() }));
vi.mock("@/hooks/use-leads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-leads")>();
  return { ...actual, useLeads: mocks.useLeadsMock };
});

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    id: "lead-1",
    name: "Palm Villas Re-roof",
    companyName: "Acme Property Mgmt",
    stageId: "stage-qualified",
    assignedRepId: "rep-1",
    assignedRepName: "Brett Jones",
    status: "open",
    displayDate: null,
    convertedAt: null,
    stageEnteredAt: "2026-04-10T10:00:00.000Z",
    createdAt: "2026-03-01T10:00:00.000Z",
    ...overrides,
  };
}

const DIMENSIONS: FilterDimension[] = ["search", "date", "stage", "rep", "status", "projectType", "sort"];
const OPTIONS: FilterBarOptions = {
  reps: [{ value: "rep-1", label: "Brett Jones" }],
  projectTypes: [{ value: "pt-1", label: "Re-roof" }],
  stages: [{ value: "stage-qualified", label: "Qualified" }],
  sortOptions: LEAD_LIST_SORT_OPTIONS,
  statusOptions: LEAD_STATUS_OPTIONS,
};

const lastLeadsCall = () => mocks.useLeadsMock.mock.calls[mocks.useLeadsMock.mock.calls.length - 1][0];

let container: HTMLDivElement;
let root: Root | null;

async function render(
  url: string,
  overrides?: { dimensions?: FilterDimension[]; scope?: "mine" | "team" | "all" }
) {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <LeadsListSection
          scope={overrides?.scope ?? "all"}
          filterBar={{ dimensions: overrides?.dimensions ?? DIMENSIONS, options: OPTIONS }}
        />
      </MemoryRouter>
    );
  });
}

describe("LeadsListSection — shared FilterBar on the leads list (Wave 1)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    mocks.useLeadsMock.mockReset();
    mocks.useLeadsMock.mockReturnValue({ leads: [makeLead()], loading: false, error: null });
  });
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders the shared FilterBar with the LEAD status options (open/converted/disqualified)", async () => {
    await render("/leads");
    expect(container.querySelector('[role="group"][aria-label="Filters"]')).not.toBeNull();
    // the Status control offers the lead lifecycle, not the deal statuses
    expect(container.textContent).toContain("Status");
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.find((b) => b.textContent?.trim() === "Active")).toBeUndefined(); // deal status absent
  });

  it("maps the NAMESPACED (ll_*) URL filters to useLeads via the lead adapter, inheriting page scope; ignores bare board params", async () => {
    // ll_* = the list's own namespace; a bare `search` is the BOARD's and must NOT reach the list.
    await render("/leads?ll_status=converted&ll_dateFrom=2026-05-01&ll_dateTo=2026-05-31&ll_assignedRepId=rep-1&ll_sortBy=created_at&ll_sortDir=desc&search=board");
    const call = lastLeadsCall();
    expect(call).toMatchObject({
      status: "converted",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
      assignedRepId: "rep-1",
      sortBy: "created_at",
      sortDir: "desc",
      scope: "all", // inherited from the page (bar doesn't own scope here)
    });
    expect(call.search).toBeUndefined(); // the board's bare ?search is NOT read by the namespaced list
  });

  it("DROPS a stale namespaced rep filter when the Rep dimension is NOT rendered (Codex #577 P2)", async () => {
    // When scope hides Rep (scope=mine, or a non-admin), a leftover ll_assignedRepId in the URL must
    // NOT silently narrow the list: the server ANDs assignedRepId with scope=mine, so an invisible
    // filter would empty/narrow the list with no control to clear it.
    await render("/leads?ll_assignedRepId=rep-1", {
      dimensions: DIMENSIONS.filter((d) => d !== "rep"),
      scope: "mine",
    });
    expect(lastLeadsCall().assignedRepId).toBeUndefined();
  });

  it("KEEPS the rep filter when the Rep dimension IS rendered", async () => {
    await render("/leads?ll_assignedRepId=rep-1", { dimensions: DIMENSIONS, scope: "all" });
    expect(lastLeadsCall().assignedRepId).toBe("rep-1");
  });

  it("renders the outcome-aware displayDate in the Date column (filter-axis == display-axis)", async () => {
    mocks.useLeadsMock.mockReturnValue({
      leads: [makeLead({ displayDate: "2026-05-20", convertedAt: "2026-01-01" })],
      loading: false,
      error: null,
    });
    await render("/leads");
    expect(container.textContent).toContain("May 20");
    expect(container.textContent).not.toContain("Jan 1");
  });

  it("shows an empty state when no leads match", async () => {
    mocks.useLeadsMock.mockReturnValue({ leads: [], loading: false, error: null });
    await render("/leads");
    expect(container.textContent).toContain("No leads match these filters");
  });

  it("renders the server stageName for an ALIAS-stage lead whose id is not among the canonical board options (Codex #577 P2)", async () => {
    // The bar's stage OPTIONS only carry canonical board ids; a lead returned in an alias stage would
    // render "—" against an options-only map. The row's authoritative stageName resolves it.
    mocks.useLeadsMock.mockReturnValue({
      leads: [makeLead({ stageId: "alias-stage-not-in-options", stageName: "Estimate Under Review (Service)" })],
      loading: false,
      error: null,
    });
    await render("/leads");
    expect(container.textContent).toContain("Estimate Under Review (Service)");
  });

  it("bounds the leads query with a page-size limit so the list is never an unbounded fetch (Codex #577 P2)", async () => {
    await render("/leads");
    expect(lastLeadsCall().limit).toBe(LEADS_LIST_PAGE_SIZE);
  });

  it("surfaces an honest 'first N' note when the returned set hits the cap (no silent truncation) (Codex #577 P2)", async () => {
    mocks.useLeadsMock.mockReturnValue({
      leads: Array.from({ length: LEADS_LIST_PAGE_SIZE }, (_unused, index) => makeLead({ id: `lead-${index}` })),
      loading: false,
      error: null,
    });
    await render("/leads");
    expect(container.textContent).toContain(`first ${LEADS_LIST_PAGE_SIZE}`);
  });

  it("does NOT show the cap note when the returned set is below the cap", async () => {
    mocks.useLeadsMock.mockReturnValue({
      leads: [makeLead(), makeLead({ id: "lead-2" })],
      loading: false,
      error: null,
    });
    await render("/leads");
    expect(container.textContent).not.toContain("first ");
  });
});
