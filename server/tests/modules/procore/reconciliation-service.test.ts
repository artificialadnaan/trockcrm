import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  classifyProcoreProjects,
  createProcoreReconciliationService,
  normalizeProcoreReconciliationRow,
} from "../../../src/modules/procore/reconciliation-service.js";

describe("procore reconciliation service", () => {
  it("classifies linked, likely-match, procore-only, and crm-only rows while honoring ignore keys", () => {
    const result = classifyProcoreProjects({
      projects: [
        {
          id: 101,
          name: "T Rock HQ Roof Replacement",
          projectNumber: "TR-001",
          city: "Dallas",
          state: "TX",
          address: "100 Main St",
          updatedAt: "2026-04-05T10:00:00.000Z",
        },
        {
          id: 202,
          name: "North Yard Repair",
          projectNumber: "TR-002",
          city: "Fort Worth",
          state: "TX",
          address: "200 Yard Rd",
          updatedAt: "2026-04-05T11:00:00.000Z",
        },
        {
          id: 303,
          name: "Completely Unmatched Project",
          projectNumber: "TR-404",
          city: "Austin",
          state: "TX",
          address: "300 Unknown Ave",
          updatedAt: "2026-04-05T12:00:00.000Z",
        },
      ],
      deals: [
        {
          id: "deal-linked",
          dealNumber: "TR-001",
          name: "T Rock HQ Roof Replacement",
          city: "Dallas",
          state: "TX",
          address: "100 Main St",
          procoreProjectId: 101,
          updatedAt: "2026-04-05T09:00:00.000Z",
        },
        {
          id: "deal-likely",
          dealNumber: "TR-002",
          name: "North Yard Repair",
          city: "Fort Worth",
          state: "TX",
          address: "200 Yard Rd",
          procoreProjectId: null,
          updatedAt: "2026-04-05T08:00:00.000Z",
        },
        {
          id: "deal-crm-only",
          dealNumber: "TR-003",
          name: "CRM Only Deal",
          city: "Houston",
          state: "TX",
          address: "400 CRM St",
          procoreProjectId: null,
          updatedAt: "2026-04-05T07:00:00.000Z",
        },
      ],
      ignoredKeys: new Set(["office-1:303:deal-ignored"]),
      officeId: "office-1",
    });

    expect(result.projects.map((row) => [row.procoreProjectId, row.bucket, row.dealId])).toEqual([
      [101, "linked", "deal-linked"],
      [202, "likely_match", "deal-likely"],
      [303, "procore_only", null],
    ]);

    expect(result.crmOnlyDeals.map((deal) => deal.id)).toEqual(["deal-crm-only"]);
  });

  it("normalizes row data into stable diff-friendly comparison strings", () => {
    expect(
      normalizeProcoreReconciliationRow({
        name: "  T Rock HQ  ",
        projectNumber: "TR-001",
        city: "Dallas",
        state: "tx",
        address: "100 Main St.",
      })
    ).toEqual({
      normalizedName: "t rock hq",
      normalizedProjectNumber: "tr001",
      normalizedCity: "dallas",
      normalizedState: "tx",
      normalizedAddress: "100 main st",
    });
  });

  it("does not reuse the same deal for multiple likely-match projects and honors office-wide ignore keys", () => {
    const result = classifyProcoreProjects({
      projects: [
        {
          id: 501,
          name: "Warehouse South",
          projectNumber: "WS-1",
          city: "Dallas",
          state: "TX",
          address: "10 South St",
          updatedAt: null,
        },
        {
          id: 502,
          name: "Warehouse South",
          projectNumber: "WS-1",
          city: "Dallas",
          state: "TX",
          address: "10 South St",
          updatedAt: null,
        },
        {
          id: 503,
          name: "Ignored Everywhere",
          projectNumber: "IG-1",
          city: "Austin",
          state: "TX",
          address: "50 Ignore St",
          updatedAt: null,
        },
      ],
      deals: [
        {
          id: "deal-one",
          dealNumber: "WS-1",
          name: "Warehouse South",
          city: "Dallas",
          state: "TX",
          address: "10 South St",
          procoreProjectId: null,
          updatedAt: null,
        },
      ],
      ignoredKeys: new Set(["office-1:503:*"]),
      officeId: "office-1",
    });

    expect(result.projects.map((row) => [row.procoreProjectId, row.bucket, row.dealId])).toEqual([
      [501, "likely_match", "deal-one"],
      [502, "procore_only", null],
      [503, "procore_only", null],
    ]);
  });

  it("honors pair-specific ignore keys without suppressing other candidate rows", () => {
    const result = classifyProcoreProjects({
      projects: [
        {
          id: 551,
          name: "Specific Ignore Project",
          projectNumber: "SI-1",
          city: "Dallas",
          state: "TX",
          address: "10 Ignore Pair Way",
          updatedAt: null,
        },
        {
          id: 552,
          name: "Other Match Project",
          projectNumber: "SI-2",
          city: "Dallas",
          state: "TX",
          address: "11 Match Way",
          updatedAt: null,
        },
      ],
      deals: [
        {
          id: "deal-ignore-pair",
          dealNumber: "SI-1",
          name: "Specific Ignore Project",
          city: "Dallas",
          state: "TX",
          address: "10 Ignore Pair Way",
          procoreProjectId: null,
          updatedAt: null,
        },
        {
          id: "deal-other",
          dealNumber: "SI-2",
          name: "Other Match Project",
          city: "Dallas",
          state: "TX",
          address: "11 Match Way",
          procoreProjectId: null,
          updatedAt: null,
        },
      ],
      ignoredKeys: new Set(["office-1:551:deal-ignore-pair"]),
      officeId: "office-1",
    });

    expect(result.projects.map((row) => [row.procoreProjectId, row.bucket, row.dealId])).toEqual([
      [551, "procore_only", null],
      [552, "likely_match", "deal-other"],
    ]);
    expect(result.projects[0]?.ignoreState).toBe("pair");
  });

  it("falls through to the next eligible candidate when the top pair match is ignored", () => {
    const result = classifyProcoreProjects({
      projects: [
        {
          id: 553,
          name: "Fallback Match Project",
          projectNumber: null,
          city: "Dallas",
          state: "TX",
          address: "22 Exact Way",
          updatedAt: null,
        },
      ],
      deals: [
        {
          id: "deal-ignored-top",
          dealNumber: null,
          name: "Fallback Match Project",
          city: "Dallas",
          state: "TX",
          address: "22 Exact Way",
          procoreProjectId: null,
          updatedAt: null,
        },
        {
          id: "deal-fallback",
          dealNumber: null,
          name: "Fallback Match Project",
          city: "Dallas",
          state: "TX",
          address: "99 Other Way",
          procoreProjectId: null,
          updatedAt: null,
        },
      ],
      ignoredKeys: new Set(["office-1:553:deal-ignored-top"]),
      officeId: "office-1",
    });

    expect(result.projects[0]).toMatchObject({
      procoreProjectId: 553,
      bucket: "likely_match",
      dealId: "deal-fallback",
      ignoreState: "none",
    });
  });

  it("uses location fields as a deterministic tie-breaker for likely matches", () => {
    const result = classifyProcoreProjects({
      projects: [
        {
          id: 601,
          name: "Central Plaza",
          projectNumber: null,
          city: "Dallas",
          state: "TX",
          address: "100 Main St",
          updatedAt: null,
        },
      ],
      deals: [
        {
          id: "deal-wrong-city",
          dealNumber: null,
          name: "Central Plaza",
          city: "Houston",
          state: "TX",
          address: "100 Main St",
          procoreProjectId: null,
          updatedAt: null,
        },
        {
          id: "deal-right-city",
          dealNumber: null,
          name: "Central Plaza",
          city: "Dallas",
          state: "TX",
          address: "100 Main St",
          procoreProjectId: null,
          updatedAt: null,
        },
      ],
      ignoredKeys: new Set(),
      officeId: "office-1",
    });

    expect(result.projects[0]).toMatchObject({
      procoreProjectId: 601,
      bucket: "likely_match",
      dealId: "deal-right-city",
    });
  });

  it("prefers city and state alignment over address-only similarity during tie-breaks", () => {
    const result = classifyProcoreProjects({
      projects: [
        {
          id: 701,
          name: "West Annex",
          projectNumber: null,
          city: "Dallas",
          state: "TX",
          address: "900 Shared Address",
          updatedAt: null,
        },
      ],
      deals: [
        {
          id: "deal-same-address-wrong-city",
          dealNumber: null,
          name: "West Annex",
          city: "Austin",
          state: "TX",
          address: "900 Shared Address",
          procoreProjectId: null,
          updatedAt: null,
        },
        {
          id: "deal-right-city-state",
          dealNumber: null,
          name: "West Annex",
          city: "Dallas",
          state: "TX",
          address: "100 Different Address",
          procoreProjectId: null,
          updatedAt: null,
        },
      ],
      ignoredKeys: new Set(),
      officeId: "office-1",
    });

    expect(result.projects[0]).toMatchObject({
      procoreProjectId: 701,
      bucket: "likely_match",
      dealId: "deal-right-city-state",
    });
  });

  it("uses address only as a final tie-break when city and state already align", () => {
    const result = classifyProcoreProjects({
      projects: [
        {
          id: 801,
          name: "South Tower",
          projectNumber: null,
          city: "Dallas",
          state: "TX",
          address: "200 Exact Match Ave",
          updatedAt: null,
        },
      ],
      deals: [
        {
          id: "deal-address-miss",
          dealNumber: null,
          name: "South Tower",
          city: "Dallas",
          state: "TX",
          address: "999 Different Ave",
          procoreProjectId: null,
          updatedAt: null,
        },
        {
          id: "deal-address-hit",
          dealNumber: null,
          name: "South Tower",
          city: "Dallas",
          state: "TX",
          address: "200 Exact Match Ave",
          procoreProjectId: null,
          updatedAt: null,
        },
      ],
      ignoredKeys: new Set(),
      officeId: "office-1",
    });

    expect(result.projects[0]).toMatchObject({
      procoreProjectId: 801,
      bucket: "likely_match",
      dealId: "deal-address-hit",
    });
  });

  it("keeps the migration uniqueness contract for nullable deal ids", () => {
    const migrationPath = fileURLToPath(
      new URL("../../../../migrations/0015_procore_reconciliation_state.sql", import.meta.url)
    );
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain("match_reason text");
    expect(sql).toContain("procore_reconciliation_state_scope_idx");
    expect(sql).toContain("coalesce(deal_id");
  });

  it("coerces unexpected non-string Procore values without crashing normalization", async () => {
    process.env.PROCORE_COMPANY_ID = "company-1";

    const service = createProcoreReconciliationService(
      {
        listProjectsPage: vi.fn().mockResolvedValueOnce([
          {
            id: 1003,
            name: "Typed Project",
            projectNumber: "TR-typed",
            city: 101 as unknown as string,
            state: { code: "TX" } as unknown as string,
            address: ["500", "Main"] as unknown as string,
            updatedAt: "2026-04-05T12:00:00.000Z",
          },
        ]),
        listActiveDeals: vi.fn().mockResolvedValue([]),
        listIgnoredRows: vi.fn().mockResolvedValue([]),
      },
      { pageSize: 100 }
    );

    const result = await service.listProcoreReconciliation({
      tenantDb: {} as never,
      officeId: "office-1",
    });

    expect(result.projects[0]).toMatchObject({
      procoreProjectId: 1003,
      bucket: "procore_only",
    });
  });

  it("pages through all Procore company projects and builds summary buckets", async () => {
    process.env.PROCORE_COMPANY_ID = "company-1";

    const listProjectsPage = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 1001,
          name: "North Yard Repair",
          projectNumber: "TR-002",
          city: "Fort Worth",
          state: "TX",
          address: "200 Yard Rd",
          updatedAt: "2026-04-05T11:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 1002,
          name: "Unlinked Project",
          projectNumber: "TR-404",
          city: "Austin",
          state: "TX",
          address: "300 Unknown Ave",
          updatedAt: "2026-04-05T12:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([]);

    const service = createProcoreReconciliationService(
      {
        listProjectsPage,
        listActiveDeals: vi.fn().mockResolvedValue([
          {
            id: "deal-likely",
            dealNumber: "TR-002",
            name: "North Yard Repair",
            city: "Fort Worth",
            state: "TX",
            address: "200 Yard Rd",
            procoreProjectId: null,
            updatedAt: "2026-04-05T08:00:00.000Z",
          },
          {
            id: "deal-crm-only",
            dealNumber: "TR-003",
            name: "CRM Only Deal",
            city: "Houston",
            state: "TX",
            address: "400 CRM St",
            procoreProjectId: null,
            updatedAt: "2026-04-05T07:00:00.000Z",
          },
        ]),
        listIgnoredRows: vi.fn().mockResolvedValue([]),
      },
      { pageSize: 1 }
    );

    const result = await service.listProcoreReconciliation({
      tenantDb: {} as never,
      officeId: "office-1",
    });

    expect(listProjectsPage).toHaveBeenNthCalledWith(1, "company-1", 1, 1);
    expect(listProjectsPage).toHaveBeenNthCalledWith(2, "company-1", 2, 1);
    expect(listProjectsPage).toHaveBeenNthCalledWith(3, "company-1", 3, 1);
    expect(result.summary).toEqual({
      linked: 0,
      likelyMatch: 1,
      procoreOnly: 1,
      crmOnly: 1,
      totalProjects: 2,
    });
    expect(result.projects[0].diffSummary.map((field) => [field.field, field.matches])).toEqual([
      ["name", true],
      ["projectNumber", true],
      ["city", true],
      ["state", true],
      ["address", true],
      ["updatedAt", false],
    ]);
    expect(result.crmOnlyDeals.map((deal) => deal.id)).toEqual(["deal-crm-only"]);
    expect(result.projects[0]?.ignoreState).toBe("none");
  });

  it("fails loudly instead of returning partial reconciliation results when a project page fetch fails", async () => {
    process.env.PROCORE_COMPANY_ID = "company-1";

    const service = createProcoreReconciliationService(
      {
        listProjectsPage: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 1001,
              name: "North Yard Repair",
              projectNumber: "TR-002",
              city: "Fort Worth",
              state: "TX",
              address: "200 Yard Rd",
              updatedAt: "2026-04-05T11:00:00.000Z",
            },
          ])
          .mockRejectedValueOnce(new Error("page 2 failed")),
        listActiveDeals: vi.fn().mockResolvedValue([]),
        listIgnoredRows: vi.fn().mockResolvedValue([]),
      },
      { pageSize: 1 }
    );

    await expect(
      service.listProcoreReconciliation({
        tenantDb: {} as never,
        officeId: "office-1",
      })
    ).rejects.toThrow("page 2 failed");
  });

  it("rejects link collisions when a project is already linked to a different deal", async () => {
    const lockProjectScope = vi.fn().mockResolvedValue(undefined);
    const lockDealScope = vi.fn().mockResolvedValue(undefined);
    const setDealProjectLink = vi.fn();
    const service = createProcoreReconciliationService({
      findDealById: vi.fn().mockResolvedValue({
        id: "deal-target",
        dealNumber: "TR-100",
        name: "Target Deal",
        city: "Dallas",
        state: "TX",
        address: "100 Main St",
        procoreProjectId: null,
        updatedAt: null,
      }),
      findDealByProjectId: vi.fn().mockResolvedValue({
        id: "deal-other",
        dealNumber: "TR-999",
        name: "Other Deal",
        city: "Dallas",
        state: "TX",
        address: "101 Main St",
        procoreProjectId: 2001,
        updatedAt: null,
      }),
      lockProjectScope,
      lockDealScope,
      setDealProjectLink,
    });

    await expect(
      service.linkProcoreProjectToDeal({
        tenantDb: {} as never,
        officeId: "office-1",
        userId: "user-1",
        procoreProjectId: 2001,
        dealId: "deal-target",
      })
    ).rejects.toThrow("Procore project is already linked to another deal");

    expect(setDealProjectLink).not.toHaveBeenCalled();
  });

  it("rejects link collisions when a deal already points at another project", async () => {
    const lockProjectScope = vi.fn().mockResolvedValue(undefined);
    const lockDealScope = vi.fn().mockResolvedValue(undefined);
    const setDealProjectLink = vi.fn();
    const service = createProcoreReconciliationService({
      findDealById: vi.fn().mockResolvedValue({
        id: "deal-target",
        dealNumber: "TR-100",
        name: "Target Deal",
        city: "Dallas",
        state: "TX",
        address: "100 Main St",
        procoreProjectId: 2000,
        updatedAt: null,
      }),
      findDealByProjectId: vi.fn().mockResolvedValue(null),
      lockProjectScope,
      lockDealScope,
      setDealProjectLink,
    });

    await expect(
      service.linkProcoreProjectToDeal({
        tenantDb: {} as never,
        officeId: "office-1",
        userId: "user-1",
        procoreProjectId: 2001,
        dealId: "deal-target",
      })
    ).rejects.toThrow("Deal is already linked to another Procore project");

    expect(setDealProjectLink).not.toHaveBeenCalled();
  });

  it("links a project, clears matching ignores, and records linked reconciliation metadata", async () => {
    const lockProjectScope = vi.fn().mockResolvedValue(undefined);
    const lockDealScope = vi.fn().mockResolvedValue(undefined);
    const setDealProjectLink = vi.fn().mockResolvedValue(undefined);
    const clearIgnoreRowsForLink = vi.fn().mockResolvedValue(undefined);
    const upsertReconciliationState = vi.fn().mockResolvedValue(undefined);

    const service = createProcoreReconciliationService({
      findDealById: vi.fn().mockResolvedValue({
        id: "deal-target",
        dealNumber: "TR-100",
        name: "Target Deal",
        city: "Dallas",
        state: "TX",
        address: "100 Main St",
        procoreProjectId: null,
        updatedAt: null,
      }),
      findDealByProjectId: vi.fn().mockResolvedValue(null),
      lockProjectScope,
      lockDealScope,
      setDealProjectLink,
      clearIgnoreRowsForLink,
      upsertReconciliationState,
    });

    await service.linkProcoreProjectToDeal({
      tenantDb: {} as never,
      officeId: "office-1",
      userId: "user-1",
      procoreProjectId: 2001,
      dealId: "deal-target",
    });

    expect(lockProjectScope).toHaveBeenCalledWith({} as never, "office-1", 2001);
    expect(lockDealScope).toHaveBeenCalledWith({} as never, "office-1", "deal-target");
    expect(setDealProjectLink).toHaveBeenCalledWith(
      {} as never,
      "deal-target",
      2001,
      expect.any(Date)
    );
    expect(clearIgnoreRowsForLink).toHaveBeenCalledWith(
      {} as never,
      "office-1",
      2001,
      "deal-target"
    );
    expect(upsertReconciliationState).toHaveBeenCalledWith(
      {} as never,
      expect.objectContaining({
        officeId: "office-1",
        procoreProjectId: 2001,
        dealId: "deal-target",
        status: "linked",
        matchReason: "manual_link",
        updatedBy: "user-1",
      })
    );
  });

  it("unlinks only the CRM-side active link and leaves ignore state untouched", async () => {
    const lockProjectScope = vi.fn().mockResolvedValue(undefined);
    const setDealProjectLink = vi.fn().mockResolvedValue(undefined);
    const deleteIgnoredRow = vi.fn().mockResolvedValue(undefined);

    const service = createProcoreReconciliationService({
      lockProjectScope,
      findDealByProjectId: vi.fn().mockResolvedValue({
        id: "deal-target",
        dealNumber: "TR-100",
        name: "Target Deal",
        city: "Dallas",
        state: "TX",
        address: "100 Main St",
        procoreProjectId: 2001,
        updatedAt: null,
      }),
      setDealProjectLink,
      deleteIgnoredRow,
    });

    await service.unlinkProcoreProject({
      tenantDb: {} as never,
      officeId: "office-1",
      procoreProjectId: 2001,
    });

    expect(lockProjectScope).toHaveBeenCalledWith({} as never, "office-1", 2001);
    expect(setDealProjectLink).toHaveBeenCalledWith(
      {} as never,
      "deal-target",
      null,
      null
    );
    expect(deleteIgnoredRow).not.toHaveBeenCalled();
  });

  it("stores and clears exact ignore keys without touching Procore", async () => {
    const lockProjectScope = vi.fn().mockResolvedValue(undefined);
    const upsertReconciliationState = vi.fn().mockResolvedValue(undefined);
    const deleteIgnoredRow = vi.fn().mockResolvedValue(undefined);

    const service = createProcoreReconciliationService({
      lockProjectScope,
      upsertReconciliationState,
      deleteIgnoredRow,
    });

    await service.ignoreProcoreSuggestion({
      tenantDb: {} as never,
      officeId: "office-1",
      userId: "user-1",
      procoreProjectId: 3001,
      dealId: "deal-1",
      reason: "bad historical match",
    });

    await service.clearIgnoredProcoreSuggestion({
      tenantDb: {} as never,
      officeId: "office-1",
      procoreProjectId: 3001,
      dealId: "deal-1",
    });

    expect(upsertReconciliationState).toHaveBeenCalledWith(
      {} as never,
      expect.objectContaining({
        officeId: "office-1",
        procoreProjectId: 3001,
        dealId: "deal-1",
        status: "ignored",
        matchReason: "bad historical match",
      })
    );
    expect(lockProjectScope).toHaveBeenNthCalledWith(1, {} as never, "office-1", 3001);
    expect(lockProjectScope).toHaveBeenNthCalledWith(2, {} as never, "office-1", 3001);
    expect(deleteIgnoredRow).toHaveBeenCalledWith({} as never, "office-1", 3001, "deal-1");
  });
});
