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

  it("DROPS the __unassigned__ sentinel for leads (leads.assignedRepId is non-null — no unassigned bucket, the backend would error/no-match)", () => {
    expect("assignedRepId" in filterBarValueToLeadFilters({ assignedRepId: "__unassigned__" })).toBe(false);
    // a real rep id still forwards
    expect(filterBarValueToLeadFilters({ assignedRepId: "rep-1" })).toEqual({ assignedRepId: "rep-1" });
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
  // displayDate is deliberately ABSENT by default — the legacy date chain only applies when the backend
  // does not SELECT the field. A row with the field PRESENT (even null) is the outcome-aware axis.
  return {
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

  it("honors an explicit displayDate:null as NO date — it does NOT fall through to a different date so the shown date always matches the filtered axis (Codex #577 P2)", () => {
    // The row's outcome-aware axis is genuinely null; falling back to stageEnteredAt/createdAt would show
    // a date the Date filter never windowed on (filter-axis != display-axis).
    expect(getLeadDisplayDate(makeLead({ displayDate: null, convertedAt: "2026-01-01", stageEnteredAt: "2026-02-02" }))).toBeNull();
  });

  it("falls back to convertedAt, then stage-entry, then created ONLY when displayDate is ABSENT (pre-backend lead chain)", () => {
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
