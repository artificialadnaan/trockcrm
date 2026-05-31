import { describe, expect, it } from "vitest";
import { buildLeadsQueryParams, type LeadFilters } from "./use-leads";

describe("buildLeadsQueryParams (LeadFilters -> GET /api/leads query)", () => {
  it("returns no params for an empty filter", () => {
    expect(buildLeadsQueryParams({}).toString()).toBe("");
  });

  it("serializes the legacy lead params", () => {
    const filters: LeadFilters = {
      search: "acme",
      assignedRepId: "rep-1",
      stageIds: ["s-a", "s-b"],
      status: "open",
      createdFrom: "2026-05-01",
      sortBy: "created_at",
      sortDir: "desc",
      scope: "all",
    };
    const p = buildLeadsQueryParams(filters);
    expect(p.get("search")).toBe("acme");
    expect(p.get("assignedRepId")).toBe("rep-1");
    expect(p.get("stageIds")).toBe("s-a,s-b");
    expect(p.get("status")).toBe("open");
    expect(p.get("createdFrom")).toBe("2026-05-01");
    expect(p.get("sortBy")).toBe("created_at");
    expect(p.get("sortDir")).toBe("desc");
    expect(p.get("scope")).toBe("all");
  });

  it("serializes the new FilterBar params (outcome-aware date, projectType, pagination)", () => {
    const p = buildLeadsQueryParams({
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
      projectTypeId: "pt-1",
      status: "converted",
      page: 2,
      limit: 25,
    });
    expect(p.get("dateFrom")).toBe("2026-05-01");
    expect(p.get("dateTo")).toBe("2026-05-31");
    expect(p.get("projectTypeId")).toBe("pt-1");
    expect(p.get("status")).toBe("converted");
    expect(p.get("page")).toBe("2");
    expect(p.get("limit")).toBe("25");
  });

  it("forwards the __unassigned__ rep sentinel verbatim (backend maps it to IS NULL)", () => {
    expect(buildLeadsQueryParams({ assignedRepId: "__unassigned__" }).get("assignedRepId")).toBe("__unassigned__");
  });

  it("maps isActive: 'all' / false to the legacy isActive param, omits it otherwise", () => {
    expect(buildLeadsQueryParams({ isActive: "all" }).get("isActive")).toBe("all");
    expect(buildLeadsQueryParams({ isActive: false }).get("isActive")).toBe("false");
    expect(buildLeadsQueryParams({ isActive: true }).has("isActive")).toBe(false);
  });
});
