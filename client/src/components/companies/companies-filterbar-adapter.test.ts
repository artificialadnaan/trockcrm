import { describe, expect, it } from "vitest";
import {
  COMPANY_LIST_SORT_OPTIONS,
  filterBarValueToCompanyFilters,
  getCompanyDisplayDate,
} from "./companies-filterbar-adapter";
import type { FilterBarValue } from "@/components/filters/filterbar-params";

describe("filterBarValueToCompanyFilters (FilterBar URL value -> useCompanies CompanyFilters)", () => {
  it("maps an empty value to an empty filter object (no stray keys)", () => {
    expect(filterBarValueToCompanyFilters({})).toEqual({});
  });

  it("passes the companies dimensions through under the contract field names", () => {
    const value: FilterBarValue = {
      search: "acme",
      assignedRepId: "owner-1",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-27",
      sortBy: "last_activity_at",
      sortDir: "desc",
    };
    expect(filterBarValueToCompanyFilters(value)).toEqual({
      search: "acme",
      assignedRepId: "owner-1",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-27",
      sortBy: "last_activity_at",
      sortDir: "desc",
    });
  });

  it("forwards the Unassigned sentinel verbatim for the owner (backend maps __unassigned__ -> owner_id IS NULL)", () => {
    expect(filterBarValueToCompanyFilters({ assignedRepId: "__unassigned__" })).toEqual({
      assignedRepId: "__unassigned__",
    });
  });

  it("maps scope 'mine' -> ownerScope 'mine' (page-inherited; endpoint reads ownerScope, not scope)", () => {
    expect(filterBarValueToCompanyFilters({ scope: "mine" })).toEqual({ ownerScope: "mine" });
  });

  it("omits ownerScope for 'all'/'team' (the companies endpoint has no team scope; all = unscoped)", () => {
    expect("ownerScope" in filterBarValueToCompanyFilters({ scope: "all" })).toBe(false);
    expect("ownerScope" in filterBarValueToCompanyFilters({ scope: "team" })).toBe(false);
  });

  it("validates sortBy against the company allow-list — a stale deal sortBy is dropped (with its dir)", () => {
    const result = filterBarValueToCompanyFilters({ sortBy: "awarded_amount", sortDir: "desc" });
    expect("sortBy" in result).toBe(false);
    expect("sortDir" in result).toBe(false);
  });

  it("accepts every allow-listed sort key", () => {
    for (const key of ["last_activity_at", "created_at", "name"] as const) {
      expect(filterBarValueToCompanyFilters({ sortBy: key, sortDir: "asc" })).toEqual({ sortBy: key, sortDir: "asc" });
    }
  });

  it("drops the deal-only dimensions by construction (no CompanyFilters field)", () => {
    const value: FilterBarValue = {
      stageIds: ["s-1"],
      regionId: "region-1",
      projectTypeId: "type-1",
      workflowRoute: "service",
      valueMin: 1000,
      valueMax: 50000,
      minAgeDays: 30,
      maxAgeDays: 90,
      search: "keep",
    };
    expect(filterBarValueToCompanyFilters(value)).toEqual({ search: "keep" });
  });

  it("drops the client-only datePreset (the server reads only dateFrom/dateTo)", () => {
    const result = filterBarValueToCompanyFilters({ datePreset: "mtd", dateFrom: "2026-05-01", dateTo: "2026-05-27" });
    expect("datePreset" in result).toBe(false);
    expect(result).toEqual({ dateFrom: "2026-05-01", dateTo: "2026-05-27" });
  });

  it("does NOT carry pagination (page) — the list section owns page/limit, not the filter map", () => {
    const result = filterBarValueToCompanyFilters({ page: 3, search: "x" });
    expect("page" in result).toBe(false);
    expect(result).toEqual({ search: "x" });
  });

  it("never emits a status param — the verification Status dimension was dropped (product)", () => {
    expect("status" in filterBarValueToCompanyFilters({ status: "verified" })).toBe(false);
    expect("status" in filterBarValueToCompanyFilters({ status: "on_hold" })).toBe(false);
  });
});

describe("COMPANY_LIST_SORT_OPTIONS (contract allow-list)", () => {
  it("every sort option's sortBy is in the company allow-list", () => {
    const allowed = new Set(["last_activity_at", "created_at", "name"]);
    for (const option of COMPANY_LIST_SORT_OPTIONS) {
      expect(allowed.has(option.sortBy)).toBe(true);
    }
  });
});

describe("getCompanyDisplayDate (filter-axis == display-axis: prefer the server's displayDate)", () => {
  it("returns the backend-provided displayDate when present, even if other dates also exist", () => {
    expect(
      getCompanyDisplayDate({ displayDate: "2026-05-20", lastActivityAt: "2026-01-01", createdAt: "2025-01-01" })
    ).toBe("2026-05-20");
  });

  it("falls back to lastActivityAt when displayDate is absent", () => {
    expect(getCompanyDisplayDate({ lastActivityAt: "2026-03-03", createdAt: "2025-01-01" })).toBe("2026-03-03");
  });

  it("falls back to createdAt when neither displayDate nor lastActivityAt is set", () => {
    expect(getCompanyDisplayDate({ displayDate: null, lastActivityAt: null, createdAt: "2025-04-04" })).toBe(
      "2025-04-04"
    );
  });

  it("returns null when no date axis is available", () => {
    expect(getCompanyDisplayDate({ displayDate: null, lastActivityAt: null })).toBeNull();
    expect(getCompanyDisplayDate({})).toBeNull();
  });
});
