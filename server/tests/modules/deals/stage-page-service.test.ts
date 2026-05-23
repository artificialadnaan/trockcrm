import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  responses: [] as any[][],
}));

function createChainableMock() {
  const chain: any = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((resolve: (value: any[]) => unknown) => resolve(dbState.responses.shift() ?? [])),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);

  return chain;
}

vi.mock("../../../src/db.js", () => ({
  db: createChainableMock(),
  pool: {},
}));

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
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return Object.values(value as Record<string, unknown>).map(extractSqlText).join("");
}

function createOfficeScopeSelectMock(rows: any[] = [{ id: "rep-1" }]) {
  return vi.fn(() => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  }));
}

describe("listDealStagePage", () => {
  beforeEach(() => {
    dbState.responses = [];
  });

  it("returns paginated deal rows for one stage with normalized sort", async () => {
    dbState.responses = [
      [{ id: "stage-estimating", slug: "estimating", name: "Estimating", displayOrder: 4, isTerminal: false }],
    ];

    const tenantDb = {
      select: createOfficeScopeSelectMock(),
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total_count: "26", active_count: "21", total_value: "400000" }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: "deal-26",
              deal_number: "TR-2026-0026",
              name: "North Campus",
              stage_id: "stage-estimating",
              on_hold: false,
              office_id: "office-1",
              awarded_amount: "15000",
              bid_estimate: "15000",
              dd_estimate: null,
              updated_at: "2026-04-21T10:00:00.000Z",
              stage_entered_at: "2026-04-18T10:00:00.000Z",
            },
          ],
        }),
    } as any;

    const { listDealStagePage } = await import("../../../src/modules/deals/service.js");
    const result = await listDealStagePage(tenantDb, {
      role: "admin",
      userId: "admin-1",
      activeOfficeId: "office-1",
      scope: "all",
      stageId: "stage-estimating",
      page: 2,
      pageSize: 25,
      sort: "newest",
    } as any);

    expect(result.pagination).toMatchObject({ page: 2, pageSize: 25, total: 26, totalPages: 2 });
    expect(result.rows[0]).toMatchObject({ id: "deal-26", stageId: "stage-estimating" });
    expect(result.summary).toMatchObject({ count: 21, activeCount: 21, totalCount: 26, totalValue: 400000 });
  });

  it("hydrates stage-page At Risk age from Bid Board stage-entered timestamp for Bid Board-owned rows", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));
      dbState.responses = [
        [{ id: "stage-estimating", slug: "estimating", name: "Estimating", displayOrder: 4, isTerminal: false }],
      ];

      const tenantDb = {
        select: createOfficeScopeSelectMock(),
        execute: vi.fn()
          .mockResolvedValueOnce({ rows: [{ total_count: "1", active_count: "1", total_value: "400000" }] })
          .mockResolvedValueOnce({
            rows: [
              {
                id: "deal-bid-board",
                deal_number: "TR-2026-BB",
                project_number: "ATL-1-11726-ab",
                name: "Bid Board Deal",
                stage_id: "stage-estimating",
                workflow_route: "normal",
                assigned_rep_id: "rep-1",
                assigned_rep_name: "Brett Jones",
                region_id: null,
                source: null,
                property_city: null,
                property_state: null,
                updated_at: "2026-05-10T00:00:00.000Z",
                stage_entered_at: "2026-05-10T00:00:00.000Z",
                is_bid_board_owned: true,
                bid_board_stage_slug: "estimating",
                bid_board_stage_entered_at: "2026-05-01T00:00:00.000Z",
                on_hold: false,
                on_hold_started_at: null,
                on_hold_accumulated_seconds: 0,
                on_hold_accumulated_seconds_at_stage_entry: 0,
                awarded_amount: null,
                bid_estimate: "15000",
                dd_estimate: null,
                days_in_stage: 0,
              },
            ],
          }),
      } as any;

      const { listDealStagePage } = await import("../../../src/modules/deals/service.js");
      const result = await listDealStagePage(tenantDb, {
        role: "admin",
        userId: "admin-1",
        activeOfficeId: "office-1",
        scope: "all",
        stageId: "stage-estimating",
        page: 1,
        pageSize: 25,
      } as any);

      expect(result.rows[0]?.atRisk).toMatchObject({
        effectiveStageAgeDays: 9,
        thresholdDays: 14,
        reason: "within_sla",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("orders stage rows by newest-first with a deterministic id tiebreaker by default", async () => {
    dbState.responses = [
      [{ id: "stage-estimating", slug: "estimating", name: "Estimating", displayOrder: 4, isTerminal: false }],
    ];

    const tenantDb = {
      select: createOfficeScopeSelectMock(),
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total_count: "0", active_count: "0", total_value: "0" }] })
        .mockResolvedValueOnce({ rows: [] }),
    } as any;

    const { listDealStagePage } = await import("../../../src/modules/deals/service.js");
    await listDealStagePage(tenantDb, {
      role: "admin",
      userId: "admin-1",
      activeOfficeId: "office-1",
      scope: "all",
      stageId: "stage-estimating",
      page: 1,
      pageSize: 25,
      sort: "newest",
    } as any);

    const rowsQueryText = extractSqlText(tenantDb.execute.mock.calls[1][0]).toLowerCase();
    expect(rowsQueryText).toContain("order by");
    expect(rowsQueryText).toContain("created_at");
    expect(rowsQueryText).toContain("desc");
    expect(rowsQueryText).toContain("d.id desc");
  });

  it("honors oldest sort instead of silently ignoring the query", async () => {
    dbState.responses = [
      [{ id: "stage-estimating", slug: "estimating", name: "Estimating", displayOrder: 4, isTerminal: false }],
    ];

    const tenantDb = {
      select: createOfficeScopeSelectMock(),
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total: "0", total_value: "0" }] })
        .mockResolvedValueOnce({ rows: [] }),
    } as any;

    const { listDealStagePage } = await import("../../../src/modules/deals/service.js");
    await listDealStagePage(tenantDb, {
      role: "admin",
      userId: "admin-1",
      activeOfficeId: "office-1",
      scope: "all",
      stageId: "stage-estimating",
      page: 1,
      pageSize: 25,
      sort: "oldest",
    } as any);

    const rowsQueryText = extractSqlText(tenantDb.execute.mock.calls[1][0]).toLowerCase();
    expect(rowsQueryText).toContain("created_at");
    expect(rowsQueryText).toContain("asc");
    expect(rowsQueryText).toContain("d.id asc");
  });

  it("preserves the legacy age_desc token as oldest-in-stage first", async () => {
    dbState.responses = [
      [{ id: "stage-estimating", slug: "estimating", name: "Estimating", displayOrder: 4, isTerminal: false }],
    ];

    const tenantDb = {
      select: createOfficeScopeSelectMock(),
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total: "0", total_value: "0" }] })
        .mockResolvedValueOnce({ rows: [] }),
    } as any;

    const { listDealStagePage } = await import("../../../src/modules/deals/service.js");
    await listDealStagePage(tenantDb, {
      role: "admin",
      userId: "admin-1",
      activeOfficeId: "office-1",
      scope: "all",
      stageId: "stage-estimating",
      page: 1,
      pageSize: 25,
      sort: "age_desc",
    } as any);

    const rowsQueryText = extractSqlText(tenantDb.execute.mock.calls[1][0]).toLowerCase();
    expect(rowsQueryText).toContain("stage_entered_at asc");
    expect(rowsQueryText).toContain("d.id asc");
  });

  it("relaxes active-only scope for date-filtered terminal stage drill-downs", async () => {
    dbState.responses = [
      [{ id: "stage-won", slug: "won", name: "Won", displayOrder: 7, isTerminal: true }],
    ];

    const tenantDb = {
      select: createOfficeScopeSelectMock(),
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total: "2", total_value: "400000" }] })
        .mockResolvedValueOnce({ rows: [] }),
    } as any;

    const { listDealStagePage } = await import("../../../src/modules/deals/service.js");
    await listDealStagePage(tenantDb, {
      role: "admin",
      userId: "admin-1",
      activeOfficeId: "office-1",
      scope: "all",
      stageId: "stage-won",
      page: 1,
      pageSize: 25,
      wonSince: "2026-04-01",
      wonUntil: "2026-04-30",
    } as any);

    const countQueryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(countQueryText).not.toContain("d.is_active = true");
    expect(countQueryText).toContain("contract_signed_at");
    expect(countQueryText).toContain("contract_signed_date");
    expect(countQueryText).toContain(">=");
    expect(countQueryText).toContain("<");
  });

  it("keeps terminal scope active-state relaxed for all-time terminal stage drill-downs", async () => {
    dbState.responses = [
      [{ id: "stage-won", slug: "won", name: "Won", displayOrder: 7, isTerminal: true }],
    ];

    const tenantDb = {
      select: createOfficeScopeSelectMock(),
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total: "2", total_value: "400000" }] })
        .mockResolvedValueOnce({ rows: [] }),
    } as any;

    const { listDealStagePage } = await import("../../../src/modules/deals/service.js");
    await listDealStagePage(tenantDb, {
      role: "admin",
      userId: "admin-1",
      activeOfficeId: "office-1",
      scope: "all",
      stageId: "stage-won",
      page: 1,
      pageSize: 25,
      wonAllTime: true,
    } as any);

    const countQueryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(countQueryText).not.toContain("d.is_active = true");
    expect(countQueryText).toContain("d.stage_id in");
  });

  it("uses direct active reports in the active office for team-scoped stage drill-downs", async () => {
    dbState.responses = [
      [{ id: "stage-estimating", slug: "estimating", name: "Estimating", displayOrder: 4, isTerminal: false }],
    ];

    const teamRows = [{ id: "rep-team-1" }, { id: "rep-team-2" }];
    const teamQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(teamRows),
    };
    const tenantDb = {
      select: vi.fn().mockReturnValue(teamQuery),
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total: "0", total_value: "0" }] })
        .mockResolvedValueOnce({ rows: [] }),
    } as any;

    const { listDealStagePage } = await import("../../../src/modules/deals/service.js");
    await listDealStagePage(tenantDb, {
      role: "director",
      userId: "director-1",
      activeOfficeId: "office-1",
      scope: "team",
      stageId: "stage-estimating",
      page: 1,
      pageSize: 25,
    } as any);

    expect(tenantDb.select).toHaveBeenCalledWith(expect.objectContaining({ id: expect.anything() }));
    const countQueryText = extractSqlText(tenantDb.execute.mock.calls[0][0]);
    expect(countQueryText).toContain("assigned_rep_id");
    expect(countQueryText).toContain("rep-team-1");
    expect(countQueryText).toContain("rep-team-2");
  });

  it("layers Estimate Sent filters and zeroes on-hold deals in stage summaries", async () => {
    dbState.responses = [
      [{ id: "stage-sent", slug: "estimate_sent_to_client", name: "Estimate Sent to Client", displayOrder: 5, isTerminal: false }],
    ];

    const tenantDb = {
      select: createOfficeScopeSelectMock(),
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ total: "1", total_value: "0" }] })
        .mockResolvedValueOnce({ rows: [] }),
    } as any;

    const { listDealStagePage } = await import("../../../src/modules/deals/service.js");
    await listDealStagePage(tenantDb, {
      role: "admin",
      userId: "admin-1",
      activeOfficeId: "office-1",
      scope: "all",
      stageId: "stage-sent",
      page: 1,
      pageSize: 25,
      assignedRepId: "rep-1",
      estimateSentFrom: "2026-04-01",
      estimateSentTo: "2026-04-30",
    } as any);

    const countQueryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(countQueryText).toContain("assigned_rep_id");
    expect(countQueryText).toContain("rep-1");
    expect(countQueryText).toContain("estimate_sent_history_stage");
    expect(countQueryText).toContain("estimate_sent_to_client");
    expect(countQueryText).toContain("service_estimate_sent_to_client");
    expect(countQueryText).toContain("stage_entered_at");
    expect(countQueryText).toContain("on_hold");
    expect(countQueryText).toContain("case");
  });

  it("keeps mine-scope stage drill-downs accessible for unassigned legacy deals", async () => {
    dbState.responses = [
      [{ id: "stage-estimating", slug: "estimating", name: "Estimating", displayOrder: 4, isTerminal: false }],
    ];

    let businessQueryIndex = 0;
    const tenantDb = {
      select: createOfficeScopeSelectMock(),
      execute: vi.fn().mockImplementation((query?: unknown) => {
        const text = extractSqlText(query).toLowerCase();
        if (text.includes("to_regclass(current_schema()")) {
          return Promise.resolve({ rows: [{ relation_name: null }] });
        }
        if (text.includes("information_schema.columns")) {
          return Promise.resolve({ rows: [{ column_exists: false }] });
        }
        businessQueryIndex += 1;
        if (businessQueryIndex === 1) {
          return Promise.resolve({ rows: [{ total: "1", total_value: "1000" }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    } as any;

    const { listDealStagePage } = await import("../../../src/modules/deals/service.js");
    await listDealStagePage(tenantDb, {
      role: "admin",
      userId: "admin-1",
      activeOfficeId: "office-1",
      scope: "mine",
      stageId: "stage-estimating",
      page: 1,
      pageSize: 25,
    } as any);

    const businessQueries = tenantDb.execute.mock.calls
      .map(([query]: [unknown]) => extractSqlText(query).toLowerCase())
      .filter((text: string) => !text.includes("to_regclass(current_schema()") && !text.includes("information_schema.columns"));
    const countQueryText = businessQueries[0] ?? "";
    const rowsQueryText = businessQueries[1] ?? "";
    expect(countQueryText).toContain("left join users u");
    expect(rowsQueryText).toContain("left join users u");
  });
});
