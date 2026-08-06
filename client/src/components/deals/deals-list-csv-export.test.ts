import { describe, expect, it, vi } from "vitest";
import {
  buildFilterBarCsvRows,
  escapeCsvCell,
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

describe("escapeCsvCell (CSV-injection hardening + RFC-4180 quoting)", () => {
  it("neutralizes a string cell that begins with a spreadsheet-formula trigger (= + - @) by prefixing '", () => {
    expect(escapeCsvCell("=1+2")).toBe("'=1+2");
    expect(escapeCsvCell("+1")).toBe("'+1");
    expect(escapeCsvCell("-cmd")).toBe("'-cmd");
    expect(escapeCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("quotes a neutralized cell that ALSO contains a comma/quote/newline", () => {
    expect(escapeCsvCell("=HYPERLINK(\"x\"),y")).toBe('"\'=HYPERLINK(""x""),y"');
  });

  it("leaves numeric cells untouched (numbers are not an injection vector — negatives stay numeric)", () => {
    expect(escapeCsvCell(-5)).toBe("-5");
    expect(escapeCsvCell(1000)).toBe("1000");
    expect(escapeCsvCell(0)).toBe("0");
  });

  it("leaves a safe string unchanged and still quotes commas/newlines", () => {
    expect(escapeCsvCell("Palm Villas")).toBe("Palm Villas");
    expect(escapeCsvCell("Acme, Inc")).toBe('"Acme, Inc"');
    expect(escapeCsvCell(null)).toBe("");
  });
});

/**
 * Read a cell BY HEADER NAME rather than by position.
 *
 * Adding the Scope Title column shifted every index in this block by one, which is exactly the churn a
 * positional assertion guarantees on any future column. The header row is asserted verbatim once below,
 * so resolving through it is no weaker — a renamed or dropped column still fails, loudly, right here.
 */
function cell(rows: (string | number)[][], header: string, rowIndex = 1) {
  const columnIndex = rows[0].indexOf(header);
  if (columnIndex === -1) throw new Error(`No "${header}" column in ${JSON.stringify(rows[0])}`);
  return rows[rowIndex][columnIndex];
}

describe("buildFilterBarCsvRows (export uses the canonical outcome-aware date axis)", () => {
  it("uses the server displayDate for the Date column (filter-axis == display-axis), not the close date", () => {
    const rows = buildFilterBarCsvRows(
      [makeDeal({ displayDate: "2026-05-20", actualCloseDate: "2026-08-15" })],
      noMaps()
    );
    expect(rows[0]).toEqual([
      "Deal",
      "Scope Title",
      "Project Number",
      "Owner",
      "Stage",
      "Days",
      "Value",
      "Date",
    ]);
    expect(cell(rows, "Date")).toBe("2026-05-20"); // displayDate wins over the close date
  });

  it("falls back to the close date when displayDate is absent, and empty when there is no date", () => {
    const fallback = buildFilterBarCsvRows([makeDeal({ displayDate: null, actualCloseDate: "2026-03-03" })], noMaps());
    expect(cell(fallback, "Date")).toBe("2026-03-03");
    const none = buildFilterBarCsvRows(
      [makeDeal({ displayDate: null, actualCloseDate: null, expectedCloseDate: null })],
      noMaps()
    );
    expect(cell(none, "Date")).toBe("");
  });

  it("resolves owner/stage names from the maps when the row omits them", () => {
    const rows = buildFilterBarCsvRows(
      [makeDeal({ assignedRepName: null, assignedRepId: "rep-9", stageName: null, stageId: "stage-9" })],
      { stageNameById: new Map([["stage-9", "Estimating"]]), assigneeNameById: new Map([["rep-9", "Dana"]]) }
    );
    expect(cell(rows, "Owner")).toBe("Dana");
    expect(cell(rows, "Stage")).toBe("Estimating");
  });

  // Accounting keys the scope title into QuickBooks off this export. Without the column the field is
  // half-shipped: readable on one deal at a time in the browser, and absent from the one artifact that
  // leaves the CRM.
  it("exports the scope title, in the column next to the deal name", () => {
    const rows = buildFilterBarCsvRows([makeDeal({ scopeTitle: "Balcony Repair" })], noMaps());

    expect(cell(rows, "Scope Title")).toBe("Balcony Repair");
    expect(rows[0].indexOf("Scope Title")).toBe(rows[0].indexOf("Deal") + 1);
  });

  it("exports an EMPTY cell for a deal with no scope title, not a placeholder glyph", () => {
    // A CSV cell is data on its way into another system. "--" would have to be stripped again there.
    const missing = buildFilterBarCsvRows([makeDeal({ scopeTitle: null })], noMaps());
    expect(cell(missing, "Scope Title")).toBe("");

    const absent = buildFilterBarCsvRows([makeDeal({ scopeTitle: undefined })], noMaps());
    expect(cell(absent, "Scope Title")).toBe("");
  });

  it("exports a change-order child's OWN scope title — the export and the detail card read one column", () => {
    // A CO child is a real deal row and appears in this list like any other, so the column it exports is
    // the same `deal.scopeTitle` the Stage & Status card renders. That is what keeps the two surfaces from
    // disagreeing: there is no derived-at-read title anywhere, in either place.
    const rows = buildFilterBarCsvRows(
      [
        makeDeal({ id: "parent", name: "Tides at Highland Meadows", scopeTitle: "Exterior Renovation" }),
        makeDeal({
          id: "child",
          name: "Tides at Highland Meadows — Change Order 1",
          isChangeOrder: true,
          parentDealId: "parent",
          scopeTitle: "Building 5 Sheathing Replacement",
        }),
      ],
      noMaps()
    );

    expect(cell(rows, "Scope Title", 1)).toBe("Exterior Renovation");
    expect(cell(rows, "Scope Title", 2)).toBe("Building 5 Sheathing Replacement");
  });

  it("neutralizes a scope title that would execute as a spreadsheet formula", () => {
    // escapeCsvCell already guards this class of value; the assertion is that the NEW column goes
    // through it rather than being concatenated in raw somewhere else.
    const rows = buildFilterBarCsvRows([makeDeal({ scopeTitle: "=cmd|'/c calc'!A1" })], noMaps());
    expect(cell(rows, "Scope Title")).toBe("=cmd|'/c calc'!A1"); // the builder emits the raw value…
    expect(escapeCsvCell(cell(rows, "Scope Title"))).toBe("'=cmd|'/c calc'!A1"); // …serialization guards it
    // A title with a comma still has to survive as ONE cell.
    expect(escapeCsvCell("Balcony Repair, Building C")).toBe('"Balcony Repair, Building C"');
  });
});
