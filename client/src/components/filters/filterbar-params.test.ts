import { describe, expect, it } from "vitest";
import {
  serializeFilters,
  deserializeFilters,
  mergeFilterParams,
  clearFilterParams,
  UNASSIGNED,
  type FilterBarValue,
} from "./filterbar-params";

describe("serializeFilters (FilterBar -> URL query, BLUE #546 param names)", () => {
  it("omits undefined, empty, and default values", () => {
    expect(serializeFilters({})).toEqual({});
    expect(serializeFilters({ search: "", stageIds: [], status: "any", page: 1 })).toEqual({});
  });

  it("emits present params with the exact contract names/values", () => {
    expect(
      serializeFilters({
        search: "acme",
        assignedRepId: "rep-1",
        regionId: UNASSIGNED,
        projectTypeId: "pt-1",
        workflowRoute: "service",
        status: "on_hold",
        valueMin: 10000,
        valueMax: 50000,
        minAgeDays: 30,
        maxAgeDays: 90,
        dateFrom: "2026-05-01",
        dateTo: "2026-05-31",
        datePreset: "mtd",
        sortBy: "created_at",
        sortDir: "desc",
        scope: "team",
        page: 3,
      })
    ).toEqual({
      search: "acme",
      assignedRepId: "rep-1",
      regionId: "__unassigned__",
      projectTypeId: "pt-1",
      workflowRoute: "service",
      status: "on_hold",
      valueMin: "10000",
      valueMax: "50000",
      minAgeDays: "30",
      maxAgeDays: "90",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
      datePreset: "mtd",
      sortBy: "created_at",
      sortDir: "desc",
      scope: "team",
      page: "3",
    });
  });

  it("joins stageIds as a CSV and omits an empty selection", () => {
    expect(serializeFilters({ stageIds: ["a", "b"] })).toEqual({ stageIds: "a,b" });
    expect(serializeFilters({ stageIds: [] })).toEqual({});
  });
});

describe("deserializeFilters (URL query -> FilterBar)", () => {
  it("round-trips a populated value", () => {
    const value: FilterBarValue = {
      search: "acme",
      stageIds: ["a", "b"],
      assignedRepId: UNASSIGNED,
      workflowRoute: "service",
      status: "on_hold",
      valueMin: 10000,
      minAgeDays: 30,
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
      datePreset: "mtd",
      sortBy: "created_at",
      sortDir: "desc",
      scope: "team",
      page: 3,
    };
    expect(deserializeFilters(new URLSearchParams(serializeFilters(value)))).toEqual(value);
  });

  it("parses CSV stageIds and numeric params", () => {
    const p = new URLSearchParams("stageIds=a,b&valueMin=10000&minAgeDays=30&page=2");
    expect(deserializeFilters(p)).toEqual({ stageIds: ["a", "b"], valueMin: 10000, minAgeDays: 30, page: 2 });
  });

  it("ignores blank or non-numeric numeric params", () => {
    expect(deserializeFilters(new URLSearchParams("valueMin=&maxAgeDays=abc"))).toEqual({});
  });
});

describe("mergeFilterParams (URL patch: preserve non-FilterBar params + page-reset)", () => {
  it("updates a FilterBar param while preserving unknown (dashboard) params", () => {
    const next = mergeFilterParams(new URLSearchParams("filter=won&period=ytd&search=old"), { search: "new" });
    expect(next.get("filter")).toBe("won");
    expect(next.get("period")).toBe("ytd");
    expect(next.get("search")).toBe("new");
  });
  it("resets page on any non-page change", () => {
    const next = mergeFilterParams(new URLSearchParams("page=3&search=x"), { stageIds: ["a"] });
    expect(next.get("page")).toBeNull();
    expect(next.get("stageIds")).toBe("a");
    expect(next.get("search")).toBe("x");
  });
  it("keeps an explicit page change", () => {
    expect(mergeFilterParams(new URLSearchParams("search=x"), { page: 2 }).get("page")).toBe("2");
  });
  it("clears a dimension whose patch value is a 'clear' (any / empty)", () => {
    const next = mergeFilterParams(new URLSearchParams("status=on_hold&stageIds=a,b"), {
      status: "any",
      stageIds: [],
    });
    expect(next.get("status")).toBeNull();
    expect(next.get("stageIds")).toBeNull();
  });
});

describe("clearFilterParams", () => {
  it("removes FilterBar params but preserves others", () => {
    const next = clearFilterParams(new URLSearchParams("filter=won&search=x&stageIds=a&status=active&page=2"));
    expect(next.get("filter")).toBe("won");
    expect(next.get("search")).toBeNull();
    expect(next.get("stageIds")).toBeNull();
    expect(next.get("status")).toBeNull();
    expect(next.get("page")).toBeNull();
  });
});
