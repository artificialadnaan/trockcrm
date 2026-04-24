import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reportRouteMocks = vi.hoisted(() => ({
  requireDirector: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock("../../../src/middleware/rbac.js", () => ({
  requireRole: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  requireDirector: reportRouteMocks.requireDirector,
}));

vi.mock("../../../src/db.js", () => ({
  db: createChainableMock([]),
}));

const { reportRoutes } = await import("../../../src/modules/reports/routes.js");

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

function createMockTenantDb(rows: any[] = []) {
  const queue = Array.isArray(rows[0]) ? [...(rows as any[][])] : [rows];
  return {
    execute: vi.fn().mockImplementation(async () => ({ rows: queue.shift() ?? [] })),
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
        lead_count: "4",
        deal_count: "10",
        active_deals: "5",
        won_deals: "3",
        lost_deals: "2",
        active_pipeline_value: "500000",
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
    expect(queryText).toContain("count(distinct dsi.id)::int as lead_count");
    expect(queryText).toContain("count(distinct d.id)::int as deal_count");
    expect(result[0]).toMatchObject({
      source: "Trade Show",
      leadCount: 4,
      dealCount: 10,
      activeDeals: 5,
      wonDeals: 3,
      lostDeals: 2,
      activePipelineValue: 500000,
      wonValue: 300000,
    });
  });

  it("maps the canonical lead source ROI payload with source counts and unknown normalization", async () => {
    const { getLeadSourceROI } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createMockTenantDb([
      {
        source: "Trade Show",
        lead_count: "4",
        deal_count: "3",
        active_deals: "2",
        won_deals: "1",
        lost_deals: "1",
        active_pipeline_value: "250000",
        won_value: "100000",
      },
      {
        source: "Unknown",
        lead_count: "2",
        deal_count: "1",
        active_deals: "1",
        won_deals: "0",
        lost_deals: "0",
        active_pipeline_value: "50000",
        won_value: "0",
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

    expect(result[0]).toMatchObject({
      source: "Trade Show",
      leadCount: 4,
      dealCount: 3,
      activeDeals: 2,
      wonDeals: 1,
      lostDeals: 1,
      activePipelineValue: 250000,
      wonValue: 100000,
      winRate: 50,
    });
    expect(result.some((row) => row.source === "Unknown")).toBe(true);
  });

  it("returns non-overlapping data mining buckets for untouched contacts and dormant companies", async () => {
    const { getDataMiningOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createMockTenantDb([
      [
        {
          untouched_contact_30_count: "4",
          untouched_contact_60_count: "2",
          untouched_contact_90_count: "1",
        },
      ],
      [
        {
          contact_id: "contact-1",
          contact_name: "Jordan Client",
          company_name: "Acme Roofing",
          last_touch_at: "2026-02-01T00:00:00.000Z",
          days_since_touch: "63",
        },
      ],
      [
        {
          dormant_company_90_count: "3",
        },
      ],
      [
        {
          company_id: "company-1",
          company_name: "Acme Roofing",
          last_touch_at: "2025-12-01T00:00:00.000Z",
          days_since_activity: "137",
          active_deal_count: "0",
        },
      ],
    ]);

    const result = await getDataMiningOverview(tenantDb, {
      from: "2026-01-01",
      to: "2026-12-31",
      officeId: "office-1",
      regionId: "region-1",
      repId: "rep-1",
      source: "Trade Show",
    });

    const firstQueryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    const secondQueryText = extractSqlText(tenantDb.execute.mock.calls[1][0]).toLowerCase();
    const thirdQueryText = extractSqlText(tenantDb.execute.mock.calls[2][0]).toLowerCase();
    const firstCompanyContextIndex = firstQueryText.indexOf("office_company_context as");
    const firstOfficeActivityIndex = firstQueryText.indexOf("office_office_activity_scope as");
    const secondCompanyContextIndex = secondQueryText.indexOf("office_company_context as");
    const secondOfficeActivityIndex = secondQueryText.indexOf("office_office_activity_scope as");

    expect(firstQueryText).toContain("from contacts c");
    expect(firstQueryText).toContain("office_deals as");
    expect(firstQueryText).toContain("office_contact_context");
    expect(thirdQueryText).toContain("office_company_context");
    expect(firstCompanyContextIndex).toBeGreaterThanOrEqual(0);
    expect(firstOfficeActivityIndex).toBeGreaterThanOrEqual(0);
    expect(firstCompanyContextIndex).toBeLessThan(firstOfficeActivityIndex);
    expect(secondCompanyContextIndex).toBeGreaterThanOrEqual(0);
    expect(secondOfficeActivityIndex).toBeGreaterThanOrEqual(0);
    expect(secondCompanyContextIndex).toBeLessThan(secondOfficeActivityIndex);
    expect(firstQueryText).not.toContain("workflow_overview");
    expect(firstQueryText).not.toContain("stale_deals");

    expect(result.summary).toMatchObject({
      untouchedContact30Count: 4,
      untouchedContact60Count: 2,
      untouchedContact90Count: 1,
      dormantCompany90Count: 3,
    });
    expect(result.untouchedContacts).toHaveLength(1);
    expect(result.untouchedContacts[0]).toMatchObject({
      contactId: "contact-1",
      contactName: "Jordan Client",
      companyName: "Acme Roofing",
      daysSinceTouch: 63,
    });
    expect(result.dormantCompanies).toHaveLength(1);
    expect(result.dormantCompanies[0]).toMatchObject({
      companyId: "company-1",
      companyName: "Acme Roofing",
      daysSinceActivity: 137,
      activeDealCount: 0,
    });
  });

  it("counts office company activity even without a contact association", async () => {
    const { getDataMiningOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = createMockTenantDb([
      [{ untouched_contact_30_count: "1", untouched_contact_60_count: "1", untouched_contact_90_count: "0" }],
      [
        {
          contact_id: "contact-1",
          contact_name: "Jordan Client",
          company_name: "Acme Roofing",
          last_touch_at: "2026-03-01T00:00:00.000Z",
          days_since_touch: "48",
        },
      ],
      [{ dormant_company_90_count: "1" }],
      [
        {
          company_id: "company-1",
          company_name: "Acme Roofing",
          last_touch_at: "2026-03-01T00:00:00.000Z",
          days_since_activity: "140",
          active_deal_count: "0",
        },
      ],
    ]);

    const result = await getDataMiningOverview(tenantDb, {
      from: "2026-01-01",
      to: "2026-12-31",
      officeId: "office-1",
    });

    expect(result.summary).toMatchObject({
      untouchedContact30Count: 1,
      untouchedContact60Count: 1,
      untouchedContact90Count: 0,
      dormantCompany90Count: 1,
    });
    expect(result.untouchedContacts[0]).toMatchObject({
      contactId: "contact-1",
      contactName: "Jordan Client",
      companyName: "Acme Roofing",
      daysSinceTouch: 48,
      lastTouchedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(result.dormantCompanies[0]).toMatchObject({
      companyId: "company-1",
      companyName: "Acme Roofing",
      daysSinceActivity: 140,
      lastActivityAt: "2026-03-01T00:00:00.000Z",
      activeDealCount: 0,
    });
  });

  it("returns office-scoped regional and rep ownership rollups without replacing cross-office reporting", async () => {
    const { getRegionalOwnershipOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          rows: [
            {
              region_id: "region-1",
              region_name: "North Texas",
              deal_count: "4",
              pipeline_value: "240000",
              stale_deal_count: "1",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              rep_id: "rep-1",
              rep_name: "Jordan",
              deal_count: "3",
              pipeline_value: "180000",
              stale_deal_count: "0",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              rep_id: "rep-1",
              rep_name: "Jordan",
              activity_count: "12",
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            { gap_type: "missing_assigned_rep", count: "2" },
            { gap_type: "missing_region", count: "1" },
          ],
        }),
    } as any;

    const result = await getRegionalOwnershipOverview(tenantDb, {
      officeId: "office-1",
      from: "2026-01-01",
      to: "2026-12-31",
    });

    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(queryText).toContain("dsi.office_id =");
    expect(queryText).toContain("d.created_at");
    expect(result.regionRollups[0]).toMatchObject({
      regionName: "North Texas",
      dealCount: 4,
      pipelineValue: 240000,
    });
    expect(result.repRollups[0]).toMatchObject({
      repName: "Jordan",
      dealCount: 3,
      pipelineValue: 180000,
      activityCount: 12,
    });
    expect(result.ownershipGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gapType: "missing_assigned_rep", count: 2 }),
      ])
    );
  });

  it("passes the current office into the regional ownership route", async () => {
    const reportsService = await import("../../../src/modules/reports/service.js");
    const ownershipSpy = vi.spyOn(reportsService, "getRegionalOwnershipOverview").mockResolvedValue({
      regionRollups: [],
      repRollups: [],
      ownershipGaps: [],
    });

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = {
        id: "director-1",
        role: "director",
        officeId: "office-1",
        activeOfficeId: "office-2",
      };
      req.tenantDb = {};
      req.commitTransaction = vi.fn().mockResolvedValue(undefined);
      next();
    });
    app.use("/api/reports", reportRoutes);

    const response = await request(app).get("/api/reports/regional-ownership?from=2026-01-01&to=2026-12-31");

    expect(response.status).toBe(200);
    expect(ownershipSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        officeId: "office-2",
        from: "2026-01-01",
        to: "2026-12-31",
      })
    );
  });
});
