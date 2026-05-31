import { describe, expect, it, vi } from "vitest";
import {
  buildFilterBarCsvRows,
  fetchAllDealsForFilters,
  MAX_EXPORT_PAGES,
} from "./deals-list-section";
import type { Deal, DealFilters } from "@/hooks/use-deals";

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: "deal-1",
    dealNumber: "HS-1",
    projectNumber: "DFW-1",
    name: "Palm Villas",
    stageId: "stage-opportunity",
    stageName: "Opportunity",
    stageSlug: "opportunity",
    workflowRoute: "normal",
    assignedRepId: "rep-1",
    assignedRepName: "Brett Jones",
    companyId: "company-1",
    companyName: "Acme Construction",
    propertyId: null,
    sourceLeadId: null,
    primaryContactId: null,
    ddEstimate: "180000",
    bidEstimate: null,
    awardedAmount: null,
    changeOrderTotal: null,
    description: null,
    propertyAddress: null,
    propertyCity: "Dallas",
    propertyState: "TX",
    propertyZip: null,
    projectTypeId: null,
    regionId: null,
    source: null,
    winProbability: null,
    procoreProjectId: null,
    procoreBidId: null,
    procoreLastSyncedAt: null,
    isBidBoardOwned: false,
    bidBoardStageSlug: null,
    readOnlySyncedAt: null,
    lostReasonId: null,
    lostNotes: null,
    lostCompetitor: null,
    lostAt: null,
    expectedCloseDate: null,
    actualCloseDate: null,
    displayDate: null,
    lastActivityAt: "2026-04-21T10:00:00.000Z",
    stageEnteredAt: "2026-04-10T10:00:00.000Z",
    isActive: true,
    hubspotDealId: null,
    createdAt: "2026-04-09T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    ...overrides,
  } as Deal;
}

const noMaps = () => ({ stageNameById: new Map<string, string>(), assigneeNameById: new Map<string, string>() });

describe("fetchAllDealsForFilters (FilterBar-aware CSV export — canonical #546 axis)", () => {
  it("queries /deals with the FilterBar contract params (status suppresses isActive), not the legacy created/updated axis", async () => {
    const urls: string[] = [];
    const apiClient = vi.fn(async (url: string) => {
      urls.push(url);
      return { deals: [], pagination: { totalPages: 1 } };
    });
    const filters: DealFilters = {
      status: "on_hold",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
      assignedRepId: "__unassigned__",
      valueMin: 1000,
      stageIds: ["s1"],
      isActive: "pipeline",
      inactiveStageIds: ["t1"],
      scope: "mine",
      sortBy: "created_at",
      sortDir: "desc",
      page: 4, // a list page that export must override
      limit: 25,
    };
    await fetchAllDealsForFilters({ filters, apiClient: apiClient as never });
    const first = urls[0];
    expect(first).toContain("status=on_hold");
    expect(first).toContain("dateFrom=2026-05-01");
    expect(first).toContain("dateTo=2026-05-31");
    expect(first).toContain("assignedRepId=__unassigned__"); // sentinel forwarded verbatim
    expect(first).toContain("valueMin=1000");
    expect(first).toContain("inactiveStageIds=t1");
    expect(first).toContain("page=1"); // export starts at page 1, not the list's page 4
    expect(first).toContain("limit=500"); // EXPORT_PAGE_SIZE, not the list's 25
    expect(first).not.toContain("isActive="); // status owns is_active/on_hold (#546 §5)
    expect(first).not.toContain("createdFrom"); // not the legacy axis
    expect(first).not.toContain("updatedFrom");
  });

  it("paginates across all pages and flattens the rows in order", async () => {
    const apiClient = vi.fn(async (url: string) => {
      const page = Number(new URLSearchParams(url.split("?")[1]).get("page"));
      return { deals: [makeDeal({ id: `d${page}` })], pagination: { totalPages: 3 } };
    });
    const result = await fetchAllDealsForFilters({ filters: {}, apiClient: apiClient as never });
    expect(result.deals.map((d) => d.id)).toEqual(["d1", "d2", "d3"]);
    expect(result.truncated).toBe(false);
    expect(apiClient).toHaveBeenCalledTimes(3);
  });

  it("caps at MAX_EXPORT_PAGES and flags truncation", async () => {
    const apiClient = vi.fn(async () => ({ deals: [makeDeal()], pagination: { totalPages: 200 } }));
    const result = await fetchAllDealsForFilters({ filters: {}, apiClient: apiClient as never });
    expect(result.truncated).toBe(true);
    expect(result.pagesFetched).toBe(MAX_EXPORT_PAGES);
    expect(apiClient).toHaveBeenCalledTimes(MAX_EXPORT_PAGES);
  });
});

describe("buildFilterBarCsvRows (export uses the canonical outcome-aware date axis)", () => {
  it("uses the server displayDate for the Date column (filter-axis == display-axis), not the close date", () => {
    const rows = buildFilterBarCsvRows(
      [makeDeal({ displayDate: "2026-05-20", actualCloseDate: "2026-08-15" })],
      noMaps()
    );
    expect(rows[0]).toEqual(["Deal", "Project Number", "Owner", "Stage", "Days", "Value", "Date"]);
    expect(rows[1][6]).toBe("2026-05-20"); // displayDate wins over the close date
  });

  it("falls back to the close date when displayDate is absent, and empty when there is no date", () => {
    const fallback = buildFilterBarCsvRows([makeDeal({ displayDate: null, actualCloseDate: "2026-03-03" })], noMaps());
    expect(fallback[1][6]).toBe("2026-03-03");
    const none = buildFilterBarCsvRows(
      [makeDeal({ displayDate: null, actualCloseDate: null, expectedCloseDate: null })],
      noMaps()
    );
    expect(none[1][6]).toBe("");
  });

  it("resolves owner/stage names from the maps when the row omits them", () => {
    const rows = buildFilterBarCsvRows(
      [makeDeal({ assignedRepName: null, assignedRepId: "rep-9", stageName: null, stageId: "stage-9" })],
      { stageNameById: new Map([["stage-9", "Estimating"]]), assigneeNameById: new Map([["rep-9", "Dana"]]) }
    );
    expect(rows[1][2]).toBe("Dana");
    expect(rows[1][3]).toBe("Estimating");
  });
});
