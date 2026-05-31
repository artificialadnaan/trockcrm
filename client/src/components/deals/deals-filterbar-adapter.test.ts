import { describe, expect, it } from "vitest";
import { filterBarValueToDealFilters, getDealDisplayDate } from "./deals-filterbar-adapter";
import type { FilterBarValue } from "@/components/filters/filterbar-params";

describe("filterBarValueToDealFilters (FilterBar URL value -> useDeals DealFilters)", () => {
  it("maps an empty value to an empty filter object (no stray keys)", () => {
    expect(filterBarValueToDealFilters({})).toEqual({});
  });

  it("passes the simple dimensions through under the contract field names", () => {
    const value: FilterBarValue = {
      search: "acme",
      stageIds: ["stage-a", "stage-b"],
      assignedRepId: "rep-1",
      regionId: "region-1",
      projectTypeId: "type-1",
      workflowRoute: "service",
      sortBy: "awarded_amount",
      sortDir: "desc",
      scope: "team",
    };
    expect(filterBarValueToDealFilters(value)).toEqual({
      search: "acme",
      stageIds: ["stage-a", "stage-b"],
      assignedRepId: "rep-1",
      regionId: "region-1",
      projectTypeId: "type-1",
      workflowRoute: "service",
      sortBy: "awarded_amount",
      sortDir: "desc",
      scope: "team",
    });
  });

  it("emits the outcome-aware date window (dateFrom/dateTo) and DROPS the client-only datePreset", () => {
    const result = filterBarValueToDealFilters({ datePreset: "mtd", dateFrom: "2026-05-01", dateTo: "2026-05-27" });
    expect(result).toEqual({ dateFrom: "2026-05-01", dateTo: "2026-05-27" });
    expect("datePreset" in result).toBe(false);
  });

  it("forwards the Unassigned sentinel verbatim (backend maps __unassigned__ -> IS NULL)", () => {
    expect(filterBarValueToDealFilters({ assignedRepId: "__unassigned__", regionId: "__unassigned__" })).toEqual({
      assignedRepId: "__unassigned__",
      regionId: "__unassigned__",
    });
  });

  it("forwards a real status but OMITS 'any' (the no-filter state)", () => {
    expect(filterBarValueToDealFilters({ status: "on_hold" })).toEqual({ status: "on_hold" });
    const any = filterBarValueToDealFilters({ status: "any" });
    expect("status" in any).toBe(false);
  });

  it("forwards numeric value + stalled-age ranges", () => {
    expect(
      filterBarValueToDealFilters({ valueMin: 1000, valueMax: 50000, minAgeDays: 30, maxAgeDays: 90 })
    ).toEqual({ valueMin: 1000, valueMax: 50000, minAgeDays: 30, maxAgeDays: 90 });
  });

  it("does NOT carry pagination (page) — the list section owns page/limit, not the filter map", () => {
    const result = filterBarValueToDealFilters({ page: 3, search: "x" });
    expect("page" in result).toBe(false);
    expect(result).toEqual({ search: "x" });
  });

  it("omits empty stageIds rather than sending an empty array", () => {
    const result = filterBarValueToDealFilters({ stageIds: [] });
    expect("stageIds" in result).toBe(false);
  });

  it("preserves zero-valued numeric ranges (0 is a real bound, distinct from 'unset')", () => {
    expect(filterBarValueToDealFilters({ valueMin: 0, valueMax: 0, minAgeDays: 0, maxAgeDays: 0 })).toEqual({
      valueMin: 0,
      valueMax: 0,
      minAgeDays: 0,
      maxAgeDays: 0,
    });
  });

  it("never emits the legacy isActive — Status owns is_active/on_hold (contract §5)", () => {
    const result = filterBarValueToDealFilters({ status: "inactive" });
    expect("isActive" in result).toBe(false);
    expect(result).toEqual({ status: "inactive" });
  });
});

describe("getDealDisplayDate (filter-axis == display-axis: prefer the server's outcome-aware displayDate)", () => {
  it("returns the backend-provided displayDate when present, even if close dates also exist", () => {
    expect(
      getDealDisplayDate({ displayDate: "2026-05-20", actualCloseDate: "2026-01-01", expectedCloseDate: "2026-02-02" })
    ).toBe("2026-05-20");
  });

  it("falls back to actualCloseDate when displayDate is absent (pre-P0 behavior preserved)", () => {
    expect(getDealDisplayDate({ actualCloseDate: "2026-03-03", expectedCloseDate: "2026-04-04" })).toBe("2026-03-03");
  });

  it("falls back to expectedCloseDate when neither displayDate nor actualCloseDate is set", () => {
    expect(getDealDisplayDate({ displayDate: null, actualCloseDate: null, expectedCloseDate: "2026-04-04" })).toBe(
      "2026-04-04"
    );
  });

  it("returns null when no date axis is available", () => {
    expect(getDealDisplayDate({ displayDate: null, actualCloseDate: null, expectedCloseDate: null })).toBeNull();
    expect(getDealDisplayDate({})).toBeNull();
  });
});
