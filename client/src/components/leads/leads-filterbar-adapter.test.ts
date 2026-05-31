import { describe, expect, it } from "vitest";
import {
  filterBarValueToLeadFilters,
  getLeadDisplayDate,
  LEAD_LIST_SORT_OPTIONS,
  LEAD_STATUS_OPTIONS,
} from "./leads-filterbar-adapter";
import type { FilterBarValue } from "@/components/filters/filterbar-params";

describe("filterBarValueToLeadFilters (FilterBar URL value -> useLeads LeadFilters)", () => {
  it("maps an empty value to an empty filter object", () => {
    expect(filterBarValueToLeadFilters({})).toEqual({});
  });

  it("passes the lead dimensions through under the LeadFilters names", () => {
    const value: FilterBarValue = {
      search: "acme",
      stageIds: ["s-a", "s-b"],
      assignedRepId: "rep-1",
      projectTypeId: "pt-1",
      status: "converted",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
      sortBy: "created_at",
      sortDir: "asc",
      scope: "all",
    };
    expect(filterBarValueToLeadFilters(value)).toEqual({
      search: "acme",
      stageIds: ["s-a", "s-b"],
      assignedRepId: "rep-1",
      projectTypeId: "pt-1",
      status: "converted",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
      sortBy: "created_at",
      sortDir: "asc",
      scope: "all",
    });
  });

  it("forwards the __unassigned__ rep sentinel verbatim (backend maps it to IS NULL)", () => {
    expect(filterBarValueToLeadFilters({ assignedRepId: "__unassigned__" })).toEqual({ assignedRepId: "__unassigned__" });
  });

  it("accepts only LEAD statuses (open/converted/disqualified) — drops a deal status or 'any'", () => {
    expect(filterBarValueToLeadFilters({ status: "open" }).status).toBe("open");
    expect(filterBarValueToLeadFilters({ status: "disqualified" }).status).toBe("disqualified");
    expect("status" in filterBarValueToLeadFilters({ status: "active" })).toBe(false); // deal status — not a lead
    expect("status" in filterBarValueToLeadFilters({ status: "any" })).toBe(false);
  });

  it("accepts only LEAD sort keys (created_at/updated_at) — drops a deal sort key", () => {
    expect(filterBarValueToLeadFilters({ sortBy: "updated_at", sortDir: "desc" })).toMatchObject({
      sortBy: "updated_at",
      sortDir: "desc",
    });
    expect("sortBy" in filterBarValueToLeadFilters({ sortBy: "awarded_amount" })).toBe(false);
  });

  it("OMITS deal-only dimensions leads have no field for (value/workflow/region/age) and pagination", () => {
    const result = filterBarValueToLeadFilters({
      valueMin: 1000,
      valueMax: 5000,
      workflowRoute: "service",
      regionId: "r-1",
      minAgeDays: 30,
      maxAgeDays: 90,
      page: 3,
      datePreset: "mtd",
      search: "x",
    } as FilterBarValue);
    expect(result).toEqual({ search: "x" });
  });

  it("omits an empty stage selection rather than sending an empty array", () => {
    expect("stageIds" in filterBarValueToLeadFilters({ stageIds: [] })).toBe(false);
  });
});

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    displayDate: null,
    convertedAt: null,
    stageEnteredAt: "2026-04-10T10:00:00.000Z",
    createdAt: "2026-03-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("getLeadDisplayDate (filter-axis == display-axis for leads)", () => {
  it("prefers the server outcome-aware displayDate when present", () => {
    expect(getLeadDisplayDate(makeLead({ displayDate: "2026-05-20", convertedAt: "2026-01-01" }))).toBe("2026-05-20");
  });

  it("falls back to convertedAt, then stage-entry, then created (pre-backend lead chain)", () => {
    expect(getLeadDisplayDate(makeLead({ convertedAt: "2026-02-02" }))).toBe("2026-02-02");
    expect(getLeadDisplayDate(makeLead({ convertedAt: null, stageEnteredAt: "2026-03-03T00:00:00Z" }))).toBe(
      "2026-03-03T00:00:00Z"
    );
    expect(
      getLeadDisplayDate(makeLead({ convertedAt: null, stageEnteredAt: null as unknown as string, createdAt: "2026-01-09T00:00:00Z" }))
    ).toBe("2026-01-09T00:00:00Z");
  });
});

describe("lead option sets", () => {
  it("LEAD_STATUS_OPTIONS are the lead lifecycle values", () => {
    expect(LEAD_STATUS_OPTIONS.map((o) => o.value)).toEqual(["open", "converted", "disqualified"]);
  });
  it("LEAD_LIST_SORT_OPTIONS only use lead sort keys (created_at/updated_at)", () => {
    for (const opt of LEAD_LIST_SORT_OPTIONS) {
      expect(["created_at", "updated_at"]).toContain(opt.sortBy);
    }
  });
});
