import { describe, expect, it } from "vitest";

  const {
    buildGapAnalysisReport,
    parseCliArgs,
    resolveTenantSchemas,
    summarizeTenantDeals,
    limitSourceRows,
    renderTextReport,
  } = await import("../../../scripts/bid-board-sync-gap-analysis.js");

describe("bid-board-sync-gap-analysis", () => {
  const crmDeals = [
    {
      tenantSchema: "office_dallas",
      id: "crm-1",
      name: "Linked Everywhere",
      dealNumber: "DFW-1-00126-aa",
      projectNumber: "DFW-1-00126-aa",
      hubspotDealId: "hs-1",
      procoreBidId: "1001",
      bidBoardProjectNumber: "DFW-1-00126-aa",
      procoreProjectId: "9001",
      isActive: true,
    },
    {
      tenantSchema: "office_dallas",
      id: "crm-2",
      name: "Bad HubSpot Link",
      dealNumber: "DFW-1-00226-aa",
      projectNumber: null,
      hubspotDealId: "hs-deleted",
      procoreBidId: null,
      bidBoardProjectNumber: null,
      procoreProjectId: null,
      isActive: true,
    },
    {
      tenantSchema: "office_dallas",
      id: "crm-3",
      name: "Orphaned CRM Deal",
      dealNumber: "DFW-1-00326-aa",
      projectNumber: null,
      hubspotDealId: null,
      procoreBidId: null,
      bidBoardProjectNumber: null,
      procoreProjectId: null,
      isActive: true,
    },
    {
      tenantSchema: "office_atlanta",
      id: "crm-4",
      name: "Portfolio Only Linked",
      dealNumber: "ATL-1-00426-aa",
      projectNumber: null,
      hubspotDealId: null,
      procoreBidId: null,
      bidBoardProjectNumber: null,
      procoreProjectId: "9004",
      isActive: true,
    },
  ];

  it("classifies source-only, broken-link, and orphaned CRM rows", () => {
    const report = buildGapAnalysisReport({
      generatedAt: "2026-05-18T12:00:00.000Z",
      mode: "dry-run",
      scope: { tenantSchemas: ["office_dallas", "office_atlanta"], source: "all" },
      crmDeals,
      hubspotDeals: [
        { id: "hs-1", name: "Linked Everywhere", projectNumber: "DFW-1-00126-aa" },
        { id: "hs-source-only", name: "HubSpot Missing From CRM", projectNumber: "DFW-1-99926-aa" },
      ],
      bidBoardProjects: [
        { id: "1001", name: "Linked Everywhere", projectNumber: "DFW-1-00126-aa" },
        { id: "1002", name: "Bid Board Missing From CRM", projectNumber: "DFW-1-88826-aa" },
      ],
      portfolioProjects: [
        { id: "9001", name: "Linked Everywhere", projectNumber: "DFW-1-00126-aa", active: true },
        { id: "9002", name: "Portfolio Missing From CRM", projectNumber: "DFW-1-77726-aa", active: true },
        { id: "9004", name: "Portfolio Only Linked", projectNumber: null, active: true },
      ],
      includeRows: true,
      districtSearch: "District at Pointon",
    });

    expect(report.summary).toMatchObject({
      crmDeals: 4,
      hubspotDeals: 2,
      bidBoardProjects: 2,
      portfolioProjects: 3,
      hubspotMissingFromCrm: 1,
      bidBoardMissingFromCrm: 1,
      portfolioMissingFromCrm: 1,
      crmBrokenHubspotLinks: 1,
      crmBrokenBidBoardLinks: 0,
      crmBrokenPortfolioLinks: 0,
      crmOrphanedDeals: 1,
      districtAtPointonMatches: 0,
    });
    expect(report.sections.hubspotMissingFromCrm.rows).toEqual([
      expect.objectContaining({ sourceId: "hs-source-only", name: "HubSpot Missing From CRM" }),
    ]);
    expect(report.sections.crmMissingOrIncorrectSourceIds.rows).toContainEqual(
      expect.objectContaining({
        tenantSchema: "office_dallas",
        dealId: "crm-2",
        field: "hubspotDealId",
        storedValue: "hs-deleted",
        issue: "stored_id_not_found_in_source",
      })
    );
    expect(report.sections.crmOrphanedDeals.rows).toEqual([
      expect.objectContaining({ tenantSchema: "office_dallas", dealId: "crm-3" }),
    ]);
  });

  it("treats a deal linked in two sources but missing the third as actionable linkage gap", () => {
    const report = buildGapAnalysisReport({
      generatedAt: "2026-05-18T12:00:00.000Z",
      mode: "full-report",
      scope: { tenantSchemas: ["office_dallas"], source: "all" },
      crmDeals: [
        {
          tenantSchema: "office_dallas",
          id: "crm-partial",
          name: "Partial Link",
          dealNumber: "DFW-1-01026-aa",
          projectNumber: null,
          hubspotDealId: "hs-partial",
          procoreBidId: "700",
          bidBoardProjectNumber: "DFW-1-01026-aa",
          procoreProjectId: null,
          isActive: true,
        },
      ],
      hubspotDeals: [{ id: "hs-partial", name: "Partial Link", projectNumber: "DFW-1-01026-aa" }],
      bidBoardProjects: [{ id: "700", name: "Partial Link", projectNumber: "DFW-1-01026-aa" }],
      portfolioProjects: [{ id: "9900", name: "Partial Link", projectNumber: "DFW-1-01026-aa", active: true }],
      includeRows: true,
      districtSearch: "District at Pointon",
    });

    expect(report.summary.portfolioMissingFromCrm).toBe(1);
    expect(report.sections.portfolioMissingFromCrm.rows).toEqual([
      expect.objectContaining({
        sourceId: "9900",
        name: "Partial Link",
        projectNumber: "DFW-1-01026-aa",
        likelyCrmMatches: [expect.objectContaining({ dealId: "crm-partial", matchReason: "project_number" })],
      }),
    ]);
  });

  it("keeps dry-run output count-only while full-report includes rows", () => {
    const dryRun = buildGapAnalysisReport({
      generatedAt: "2026-05-18T12:00:00.000Z",
      mode: "dry-run",
      scope: { tenantSchemas: ["office_dallas"], source: "hubspot" },
      crmDeals,
      hubspotDeals: [{ id: "hs-source-only", name: "HubSpot Missing From CRM", projectNumber: null }],
      bidBoardProjects: [],
      portfolioProjects: [],
      includeRows: false,
      districtSearch: "District at Pointon",
    });

    expect(dryRun.sections.hubspotMissingFromCrm.rows).toBeUndefined();
    expect(dryRun.sections.hubspotMissingFromCrm.count).toBe(1);
  });

  it("summarizes tenant deal ID coverage including all-three-null orphans", () => {
    expect(summarizeTenantDeals(crmDeals)).toEqual({
      total: 4,
      hubspotPopulated: 2,
      hubspotNull: 2,
      bidBoardPopulated: 1,
      bidBoardNull: 3,
      portfolioPopulated: 2,
      portfolioNull: 2,
      allThreeNull: 1,
    });
  });

  it("resolves --all tenant schemas with the office escaped LIKE query rows", () => {
    const rows = [
      { schema_name: "office_dallas" },
      { schema_name: "office_atlanta" },
      { schema_name: "public" },
    ];

    expect(resolveTenantSchemas({ all: true, office: null }, rows)).toEqual([
      "office_atlanta",
      "office_dallas",
    ]);
  });

  it("parses the supported CLI flags", () => {
    expect(
      parseCliArgs([
        "--office=office_dallas",
        "--dry-run",
        "--source=bidboard",
      ])
    ).toMatchObject({
      office: "office_dallas",
      all: false,
      mode: "dry-run",
      source: "bidboard",
    });
    expect(parseCliArgs(["--all", "--full-report"])).toMatchObject({
      office: null,
      all: true,
      mode: "full-report",
      source: "all",
    });
  });

  it("rejects invalid DIAGNOSTIC_MAX_SOURCE_RECORDS values", () => {
    const previous = process.env.DIAGNOSTIC_MAX_SOURCE_RECORDS;
    process.env.DIAGNOSTIC_MAX_SOURCE_RECORDS = "abc";
    try {
      expect(() => parseCliArgs(["--office=office_dallas"])).toThrow(
        "DIAGNOSTIC_MAX_SOURCE_RECORDS must be a positive integer"
      );
    } finally {
      if (previous === undefined) delete process.env.DIAGNOSTIC_MAX_SOURCE_RECORDS;
      else process.env.DIAGNOSTIC_MAX_SOURCE_RECORDS = previous;
    }
  });

  it("applies source row limits to exported Bid Board payload rows", () => {
    expect(
      limitSourceRows(
        [
          { id: "1", name: "One", projectNumber: "DFW-1" },
          { id: "2", name: "Two", projectNumber: "DFW-2" },
        ],
        1
      )
    ).toEqual([{ id: "1", name: "One", projectNumber: "DFW-1" }]);
  });

  it("includes source assumptions and notes in leadership text output", () => {
    const report = buildGapAnalysisReport({
      generatedAt: "2026-05-18T12:00:00.000Z",
      mode: "dry-run",
      scope: { tenantSchemas: ["office_dallas"], source: "all" },
      crmDeals: [],
      hubspotDeals: [],
      bidBoardProjects: [],
      portfolioProjects: [],
      includeRows: false,
      districtSearch: "District at Pointon",
      sourceNotes: ["Bid Board source rows came from SyncHub sync_mappings."],
    });

    const text = renderTextReport(report);

    expect(text).toContain("Assumptions");
    expect(text).toContain("Source Notes");
    expect(text).toContain("SyncHub sync_mappings");
  });

  it("builds a positive District at Pointon case study across CRM and all sources", () => {
    const report = buildGapAnalysisReport({
      generatedAt: "2026-05-18T12:00:00.000Z",
      mode: "full-report",
      scope: { tenantSchemas: ["office_dallas"], source: "all" },
      crmDeals: [
        {
          tenantSchema: "office_dallas",
          id: "district-crm",
          name: "District at Pointon",
          dealNumber: "DFW-2-12326-aa",
          projectNumber: null,
          hubspotDealId: null,
          procoreBidId: "456789",
          bidBoardProjectNumber: "DFW-2-12326-aa",
          procoreProjectId: null,
          isActive: true,
        },
      ],
      hubspotDeals: [{ id: "hs-district", name: "District at Pointon", projectNumber: "DFW-2-12326-aa" }],
      bidBoardProjects: [{ id: "456789", name: null, projectNumber: "DFW-2-12326-aa" }],
      portfolioProjects: [{ id: "987654", name: "District at Pointon", projectNumber: "DFW-2-12326-aa", active: true }],
      includeRows: true,
      districtSearch: "District at Pointon",
    });

    const district = report.sections.districtAtPointon.rows?.[0];

    expect(report.summary.districtAtPointonMatches).toBe(4);
    expect(district?.crmMatches).toHaveLength(1);
    expect(district?.hubspotMatches).toHaveLength(1);
    expect(district?.bidBoardMatches).toHaveLength(1);
    expect(district?.portfolioMatches).toHaveLength(1);
    expect(district?.diagnosis).toContain(
      "office_dallas/district-crm: hubspotDealId=null, procoreBidId=456789, bidBoardProjectNumber=DFW-2-12326-aa, procoreProjectId=null"
    );
  });
});
