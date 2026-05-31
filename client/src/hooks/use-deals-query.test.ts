import { describe, expect, it } from "vitest";
import { buildDealsQueryParams, type DealFilters } from "./use-deals";

const get = (filters: DealFilters) => buildDealsQueryParams(filters);

describe("buildDealsQueryParams (DealFilters -> GET /api/deals query string)", () => {
  it("serializes the existing list params unchanged (no regression)", () => {
    const p = get({
      search: "acme",
      stageIds: ["a", "b"],
      inactiveStageIds: ["x"],
      assignedRepId: "rep-1",
      projectTypeId: "type-1",
      regionId: "region-1",
      source: "hubspot",
      createdFrom: "2026-01-01",
      createdTo: "2026-02-01",
      updatedFrom: "2026-03-01",
      updatedTo: "2026-04-01",
      isActive: "pipeline",
      sortBy: "created_at",
      sortDir: "desc",
      page: 2,
      limit: 25,
      scope: "team",
    });
    expect(p.get("search")).toBe("acme");
    expect(p.get("stageIds")).toBe("a,b");
    expect(p.get("inactiveStageIds")).toBe("x");
    expect(p.get("assignedRepId")).toBe("rep-1");
    expect(p.get("projectTypeId")).toBe("type-1");
    expect(p.get("regionId")).toBe("region-1");
    expect(p.get("source")).toBe("hubspot");
    expect(p.get("createdFrom")).toBe("2026-01-01");
    expect(p.get("updatedTo")).toBe("2026-04-01");
    expect(p.get("isActive")).toBe("pipeline");
    expect(p.get("sortBy")).toBe("created_at");
    expect(p.get("sortDir")).toBe("desc");
    expect(p.get("page")).toBe("2");
    expect(p.get("limit")).toBe("25");
    expect(p.get("scope")).toBe("team");
  });

  it("serializes the new FilterBar dimensions under the contract names", () => {
    const p = get({
      dateFrom: "2026-05-01",
      dateTo: "2026-05-27",
      status: "on_hold",
      workflowRoute: "service",
      valueMin: 1000,
      valueMax: 50000,
      minAgeDays: 30,
      maxAgeDays: 90,
    });
    expect(p.get("dateFrom")).toBe("2026-05-01");
    expect(p.get("dateTo")).toBe("2026-05-27");
    expect(p.get("status")).toBe("on_hold");
    expect(p.get("workflowRoute")).toBe("service");
    expect(p.get("valueMin")).toBe("1000");
    expect(p.get("valueMax")).toBe("50000");
    expect(p.get("minAgeDays")).toBe("30");
    expect(p.get("maxAgeDays")).toBe("90");
  });

  it("omits the 'any' status (the no-filter state)", () => {
    expect(get({ status: "any" }).has("status")).toBe(false);
  });

  it("serializes zero-valued numeric params (0 is a real bound, not 'unset')", () => {
    const p = get({ valueMin: 0, valueMax: 0, minAgeDays: 0, maxAgeDays: 0 });
    expect(p.get("valueMin")).toBe("0");
    expect(p.get("valueMax")).toBe("0");
    expect(p.get("minAgeDays")).toBe("0");
    expect(p.get("maxAgeDays")).toBe("0");
  });

  it("suppresses the legacy isActive when a real status is sent (contract §5: send one or the other)", () => {
    const p = get({ status: "active", isActive: "pipeline" });
    expect(p.get("status")).toBe("active");
    expect(p.has("isActive")).toBe(false);
  });

  it("still sends isActive when no status is present (legacy callers unaffected)", () => {
    const p = get({ isActive: false });
    expect(p.get("isActive")).toBe("false");
    expect(p.has("status")).toBe(false);
  });

  it("omits undefined fields and empty arrays", () => {
    const p = get({ stageIds: [], inactiveStageIds: [] });
    expect(p.has("stageIds")).toBe(false);
    expect(p.has("inactiveStageIds")).toBe(false);
    expect(p.toString()).toBe("");
  });
});
