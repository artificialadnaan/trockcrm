import { describe, expect, it, vi } from "vitest";

  const {
    buildSourceLookup,
    buildGapAnalysisReport,
    dedupeSyncHubMappingRows,
    dealExistsInLookup,
    fetchPortfolioProjects,
    fetchHubSpotDeals,
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

  it("deduplicates historical SyncHub mappings by Bid Board ID and project number, keeping latest row", () => {
    const rows = dedupeSyncHubMappingRows([
      {
        id: "1",
        hubspot_deal_id: "old-hs",
        procore_project_number: "DFW-4-11111-aa",
        bidboard_project_id: "900",
        created_at: "2026-05-01T10:00:00.000Z",
      },
      {
        id: "2",
        hubspot_deal_id: "new-hs",
        procore_project_number: "DFW-4-11111-aa",
        bidboard_project_id: "900",
        created_at: "2026-05-02T10:00:00.000Z",
      },
      {
        id: "3",
        hubspot_deal_id: "same-time-higher-id",
        procore_project_number: "DFW-4-22222-aa",
        bidboard_project_id: "901",
        created_at: "2026-05-02T10:00:00.000Z",
      },
      {
        id: "4",
        hubspot_deal_id: "same-time-kept",
        procore_project_number: "DFW-4-22222-aa",
        bidboard_project_id: "901",
        created_at: "2026-05-02T10:00:00.000Z",
      },
    ]);

    expect(rows).toEqual([
      expect.objectContaining({ id: "4", hubspot_deal_id: "same-time-kept" }),
      expect.objectContaining({ id: "2", hubspot_deal_id: "new-hs" }),
    ]);
  });

  it("does not treat name-only matches as source existence", () => {
    const lookup = buildSourceLookup([{ id: "source-1", name: "Same Name", projectNumber: null }]);
    const deal = {
      tenantSchema: "office_dallas",
      id: "crm-same-name",
      name: "Same Name",
      dealNumber: "DFW-1-00126-aa",
      projectNumber: null,
      hubspotDealId: null,
      procoreBidId: null,
      bidBoardProjectNumber: null,
      procoreProjectId: null,
      isActive: true,
    };

    expect(dealExistsInLookup(deal, lookup, null)).toBe(false);
  });

  it("throws for Portfolio fetch when read-only Procore auth is unavailable instead of using mock data", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });

    await expect(
      fetchPortfolioProjects(10, {
        env: {
          PROCORE_COMPANY_ID: "company-1",
          PROCORE_CLIENT_ID: "client-1",
          PROCORE_CLIENT_SECRET: "secret-1",
        },
        tokenClient: { query },
        decryptToken: (value: string) => value,
        fetchImpl: vi.fn(),
      })
    ).rejects.toThrow("Procore OAuth token not found");

    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM public.procore_oauth_tokens"), [1]);
  });

  it("marks truncated source snapshots and downgrades stored-id misses against truncated sources", () => {
    const report = buildGapAnalysisReport({
      generatedAt: "2026-05-18T12:00:00.000Z",
      mode: "full-report",
      scope: { tenantSchemas: ["office_dallas"], source: "hubspot" },
      crmDeals: [
        {
          tenantSchema: "office_dallas",
          id: "crm-truncated",
          name: "Stored ID Outside Page",
          dealNumber: "DFW-1-00126-aa",
          projectNumber: null,
          hubspotDealId: "hs-outside-snapshot",
          procoreBidId: null,
          bidBoardProjectNumber: null,
          procoreProjectId: null,
          isActive: true,
        },
      ],
      hubspotDeals: [{ id: "hs-first-page", name: "First Page", projectNumber: null }],
      bidBoardProjects: [],
      portfolioProjects: [],
      includeRows: true,
      districtSearch: "District at Pointon",
      sourceStates: {
        hubspot: { truncated: true, fetchedCount: 1, maxRecords: 1 },
        bidboard: { truncated: false, fetchedCount: 0, maxRecords: 1 },
        portfolio: { truncated: false, fetchedCount: 0, maxRecords: 1 },
      },
    });

    expect(report.partialSnapshotWarning).toContain("PARTIAL SNAPSHOT WARNING");
    expect(report.sections.crmMissingOrIncorrectSourceIds.rows).toContainEqual(
      expect.objectContaining({
        field: "hubspotDealId",
        issue: "stored_id_not_in_partial_snapshot",
      })
    );
    expect(renderTextReport(report)).toContain("PARTIAL SNAPSHOT WARNING");
  });

  it("uses read-only Portfolio token access and does not write to procore_oauth_tokens", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          access_token: "encrypted-access-token",
          token_expires_at: new Date("2026-05-18T13:00:00.000Z"),
          status: "active",
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => "",
    });

    await fetchPortfolioProjects(10, {
      env: {
        PROCORE_COMPANY_ID: "company-1",
        PROCORE_CLIENT_ID: "client-1",
        PROCORE_CLIENT_SECRET: "secret-1",
      },
      now: () => new Date("2026-05-18T12:00:00.000Z"),
      tokenClient: { query },
      decryptToken: (value: string) => `decrypted:${value}`,
      fetchImpl,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/^SELECT\b/i);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/rest/v1.0/companies/company-1/projects?page=1&per_page=100"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer decrypted:encrypted-access-token",
          "Procore-Company-Id": "company-1",
        }),
      })
    );
  });

  it("does not mark Portfolio truncated when the complete snapshot exactly equals maxRecords", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          access_token: "encrypted-access-token",
          token_expires_at: new Date("2026-05-18T13:00:00.000Z"),
          status: "active",
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { id: 101, name: "One", project_number: "DFW-1" },
        { id: 102, name: "Two", project_number: "DFW-2" },
      ],
      text: async () => "",
    });

    const result = await fetchPortfolioProjects(2, {
      env: {
        PROCORE_COMPANY_ID: "company-1",
        PROCORE_CLIENT_ID: "client-1",
        PROCORE_CLIENT_SECRET: "secret-1",
      },
      now: () => new Date("2026-05-18T12:00:00.000Z"),
      tokenClient: { query },
      decryptToken: (value: string) => `decrypted:${value}`,
      fetchImpl,
    });

    expect(result.records).toHaveLength(2);
    expect(result.state).toEqual({ truncated: false, fetchedCount: 2, maxRecords: 2 });
  });

  it("marks Portfolio truncated when maxRecords lands on a page boundary with a next-page indicator", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          access_token: "encrypted-access-token",
          token_expires_at: new Date("2026-05-18T13:00:00.000Z"),
          status: "active",
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        Link: '<https://api.procore.com/rest/v1.0/companies/company-1/projects?page=2&per_page=100>; rel="next"',
      }),
      json: async () => Array.from({ length: 100 }, (_, index) => ({
        id: 1000 + index,
        name: `Project ${index}`,
        project_number: `DFW-${index}`,
      })),
      text: async () => "",
    });

    const result = await fetchPortfolioProjects(100, {
      env: {
        PROCORE_COMPANY_ID: "company-1",
        PROCORE_CLIENT_ID: "client-1",
        PROCORE_CLIENT_SECRET: "secret-1",
      },
      now: () => new Date("2026-05-18T12:00:00.000Z"),
      tokenClient: { query },
      decryptToken: (value: string) => `decrypted:${value}`,
      fetchImpl,
    });

    expect(result.records).toHaveLength(100);
    expect(result.state).toEqual({ truncated: true, fetchedCount: 100, maxRecords: 100 });
  });

  it("does not mark Portfolio truncated for a partial page without a next-page indicator", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          access_token: "encrypted-access-token",
          token_expires_at: new Date("2026-05-18T13:00:00.000Z"),
          status: "active",
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => [
        { id: 101, name: "One", project_number: "DFW-1" },
        { id: 102, name: "Two", project_number: "DFW-2" },
      ],
      text: async () => "",
    });

    const result = await fetchPortfolioProjects(10, {
      env: {
        PROCORE_COMPANY_ID: "company-1",
        PROCORE_CLIENT_ID: "client-1",
        PROCORE_CLIENT_SECRET: "secret-1",
      },
      now: () => new Date("2026-05-18T12:00:00.000Z"),
      tokenClient: { query },
      decryptToken: (value: string) => `decrypted:${value}`,
      fetchImpl,
    });

    expect(result.records).toHaveLength(2);
    expect(result.state).toEqual({ truncated: false, fetchedCount: 2, maxRecords: 10 });
  });

  it("retries a read-only Portfolio 429 using Retry-After and succeeds on the second attempt", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          access_token: "encrypted-access-token",
          token_expires_at: new Date("2026-05-18T13:00:00.000Z"),
          status: "active",
        },
      ],
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "3" }),
        text: async () => "rate limited",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [{ id: 101, name: "Recovered", project_number: "DFW-1" }],
        text: async () => "",
      });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await fetchPortfolioProjects(10, {
        env: {
          PROCORE_COMPANY_ID: "company-1",
          PROCORE_CLIENT_ID: "client-1",
          PROCORE_CLIENT_SECRET: "secret-1",
        },
        now: () => new Date("2026-05-18T12:00:00.000Z"),
        tokenClient: { query },
        decryptToken: (value: string) => `decrypted:${value}`,
        fetchImpl,
        sleep,
      });

      expect(result.records).toEqual([expect.objectContaining({ id: "101", name: "Recovered" })]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(3000);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("retrying in 3000ms"));
    } finally {
      warn.mockRestore();
    }
  });

  it("retries a read-only Portfolio 503 three times then fails clearly", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          access_token: "encrypted-access-token",
          token_expires_at: new Date("2026-05-18T13:00:00.000Z"),
          status: "active",
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers(),
      text: async () => "service unavailable",
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(
        fetchPortfolioProjects(10, {
          env: {
            PROCORE_COMPANY_ID: "company-1",
            PROCORE_CLIENT_ID: "client-1",
            PROCORE_CLIENT_SECRET: "secret-1",
          },
          now: () => new Date("2026-05-18T12:00:00.000Z"),
          tokenClient: { query },
          decryptToken: (value: string) => `decrypted:${value}`,
          fetchImpl,
          sleep,
        })
      ).rejects.toThrow("Procore read-only portfolio fetch failed after 4 attempts: 503 service unavailable");

      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(sleep).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenNthCalledWith(1, 1000);
      expect(sleep).toHaveBeenNthCalledWith(2, 2000);
      expect(sleep).toHaveBeenNthCalledWith(3, 4000);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("fails a read-only Portfolio 401 immediately with a token-invalid message", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          access_token: "encrypted-access-token",
          token_expires_at: new Date("2026-05-18T13:00:00.000Z"),
          status: "active",
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => "unauthorized",
    });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      fetchPortfolioProjects(10, {
        env: {
          PROCORE_COMPANY_ID: "company-1",
          PROCORE_CLIENT_ID: "client-1",
          PROCORE_CLIENT_SECRET: "secret-1",
        },
        now: () => new Date("2026-05-18T12:00:00.000Z"),
        tokenClient: { query },
        decryptToken: (value: string) => `decrypted:${value}`,
        fetchImpl,
        sleep,
      })
    ).rejects.toThrow("Procore token invalid or expired: 401 unauthorized");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails a read-only Portfolio 400 immediately without retrying", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          access_token: "encrypted-access-token",
          token_expires_at: new Date("2026-05-18T13:00:00.000Z"),
          status: "active",
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () => "bad request",
    });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      fetchPortfolioProjects(10, {
        env: {
          PROCORE_COMPANY_ID: "company-1",
          PROCORE_CLIENT_ID: "client-1",
          PROCORE_CLIENT_SECRET: "secret-1",
        },
        now: () => new Date("2026-05-18T12:00:00.000Z"),
        tokenClient: { query },
        decryptToken: (value: string) => `decrypted:${value}`,
        fetchImpl,
        sleep,
      })
    ).rejects.toThrow("Procore read-only portfolio fetch failed: 400 bad request");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("marks HubSpot truncated when maxRecords cuts through a later page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: Array.from({ length: 100 }, (_, index) => ({
            id: `hs-page-1-${index}`,
            properties: { dealname: `Page 1 ${index}`, project_number: null },
          })),
          paging: { next: { after: "page-2" } },
        }),
        text: async () => "",
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: Array.from({ length: 75 }, (_, index) => ({
            id: `hs-page-2-${index}`,
            properties: { dealname: `Page 2 ${index}`, project_number: null },
          })),
        }),
        text: async () => "",
        headers: new Headers(),
      });

    const result = await fetchHubSpotDeals(150, {
      env: { HUBSPOT_PRIVATE_APP_TOKEN: "token" },
      fetchImpl,
    });

    expect(result.records).toHaveLength(150);
    expect(result.state).toEqual({ truncated: true, fetchedCount: 150, maxRecords: 150 });
  });
});
