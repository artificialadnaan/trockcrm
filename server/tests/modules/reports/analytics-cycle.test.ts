import { beforeEach, describe, expect, it, vi } from "vitest";

function createChainableMock(resolveValue: any[] = []) {
  const chain: any = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((resolve: any) => resolve(resolveValue)),
  };
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

vi.mock("../../../src/db.js", () => ({
  db: createChainableMock([]),
}));

function createMockTenantDb(rows: any[] = []) {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
  } as any;
}

function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }

  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }

  return "";
}

describe("analytics cycle shared filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes analytics filters with a default date range and trimmed source", async () => {
    const { normalizeAnalyticsFilters } = await import("../../../src/modules/reports/service.js");

    const result = normalizeAnalyticsFilters({
      officeId: " office-1 ",
      regionId: " region-1 ",
      repId: " rep-1 ",
      source: " Trade Show ",
    });

    expect(result.officeId).toBe("office-1");
    expect(result.regionId).toBe("region-1");
    expect(result.repId).toBe("rep-1");
    expect(result.source).toBe("Trade Show");
    expect(result.from).toMatch(/^\d{4}-01-01$/);
    expect(result.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("parses analytics filters from report query strings", async () => {
    const { parseAnalyticsFilters } = await import("../../../src/modules/reports/routes.js");

    const result = parseAnalyticsFilters({
      from: " 2026-01-01 ",
      to: " 2026-12-31 ",
      officeId: " office-1 ",
      regionId: " region-1 ",
      repId: " rep-1 ",
      source: " Trade Show ",
    });

    expect(result).toMatchObject({
      from: "2026-01-01",
      to: "2026-12-31",
      officeId: "office-1",
      regionId: "region-1",
      repId: "rep-1",
      source: "Trade Show",
    });
  });

  it("threads shared analytics filters into lead source reporting", async () => {
    const { getLeadSourceROI } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createMockTenantDb([
      {
        source: "Trade Show",
        total_deals: "10",
        active_deals: "5",
        won_deals: "3",
        lost_deals: "2",
        pipeline_value: "500000",
        won_value: "300000",
      },
    ]);

    const result = await getLeadSourceROI(tenantDb, {
      from: "2026-01-01",
      to: "2026-12-31",
      officeId: "office-1",
      regionId: "region-1",
      repId: "rep-1",
      source: "Trade Show",
    });

    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(queryText).toContain("left join deal_scoping_intake dsi on dsi.deal_id = d.id");
    expect(queryText).toContain("dsi.office_id");
    expect(queryText).toContain("d.region_id");
    expect(queryText).toContain("d.assigned_rep_id");
    expect(queryText).toContain("coalesce(nullif(trim(d.source), ''), 'unknown')");
    expect(result[0]).toMatchObject({
      source: "Trade Show",
      totalDeals: 10,
      activeDeals: 5,
      wonDeals: 3,
      lostDeals: 2,
      pipelineValue: 500000,
      wonValue: 300000,
    });
  });
});
