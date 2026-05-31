import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Batch A (server) — D-11: the kanban board's OPEN columns must honor a board-wide
 * dashboard period on the entered-current-stage axis, not silently ignore it
 * ("Open-stage deals for MTD" showing every open deal). Canonical adoption per the
 * platform date model (§6 Phase 4): flag-gated on ENABLE_STAGE_ENTRY_DATE_FILTER
 * (reliable stage_entered_at, post-#535). When ON, a dashboard period
 * (won_period_from/to) also bounds open-stage cards by stage_entered_at; when OFF
 * the open columns stay current-state (byte-identical SQL) and the drill-down's
 * honest "(now)" label reflects that. The Won/Lost columns are unaffected (they
 * already window on won_closed_date / lost_at).
 */

const dbState = vi.hoisted(() => ({ stages: [] as any[] }));

function createChainableMock() {
  const chain: any = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    leftJoin: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((resolve: (value: any[]) => unknown) => resolve(dbState.stages)),
  };
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
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
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return Object.values(value as Record<string, unknown>).map(extractSqlText).join("");
}

function containsValue(value: unknown, expected: string, seen = new Set<unknown>()): boolean {
  if (value === expected) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsValue(item, expected, seen));
  return Object.values(value as Record<string, unknown>).some((item) => containsValue(item, expected, seen));
}

vi.mock("../../../src/db.js", () => ({ db: createChainableMock(), pool: {} }));

// One open (non-terminal, active-pipeline) stage is all we need to exercise the
// open ELSE branch.
const OPEN_STAGES = [
  { id: "stage-opportunity", slug: "opportunity", name: "Opportunity", displayOrder: 1, isTerminal: false, isActivePipeline: true },
];

function runBoardCapturingOpenStageSql() {
  const tenantChains: any[] = [];
  const tenantDb = {
    select: vi.fn(() => {
      const chain = createChainableMock();
      chain.then.mockImplementation((resolve: (value: any[]) => unknown) => resolve([]));
      tenantChains.push(chain);
      return chain;
    }),
  } as any;
  return { tenantDb, tenantChains };
}

const openStageWhereText = (tenantChains: any[]) => {
  const openChain = tenantChains.find((chain) =>
    containsValue(chain.where.mock.calls[0]?.[0], "stage-opportunity")
  );
  return extractSqlText(openChain?.where.mock.calls[0]?.[0]).toLowerCase();
};

describe("getDealsForPipeline — open-column stage_entered_at window (D-11)", () => {
  beforeEach(() => {
    dbState.stages = OPEN_STAGES;
  });

  it("bounds open columns by stage_entered_at when the flag is ON and a dashboard period is present", async () => {
    const prev = process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
    process.env.ENABLE_STAGE_ENTRY_DATE_FILTER = "true";
    try {
      const { tenantDb, tenantChains } = runBoardCapturingOpenStageSql();
      const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");

      await getDealsForPipeline(tenantDb, "director", "director-1", {
        scope: "all",
        activeOfficeId: null,
        wonPeriodFrom: "2026-05-01",
        wonPeriodTo: "2026-05-31",
      });

      const sql = openStageWhereText(tenantChains);
      expect(sql).toContain("stage_entered_at");
    } finally {
      if (prev === undefined) delete process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
      else process.env.ENABLE_STAGE_ENTRY_DATE_FILTER = prev;
    }
  });

  it("leaves open columns current-state (no stage_entered_at predicate) when the flag is OFF", async () => {
    const prev = process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
    delete process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
    try {
      const { tenantDb, tenantChains } = runBoardCapturingOpenStageSql();
      const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");

      await getDealsForPipeline(tenantDb, "director", "director-1", {
        scope: "all",
        activeOfficeId: null,
        wonPeriodFrom: "2026-05-01",
        wonPeriodTo: "2026-05-31",
      });

      const sql = openStageWhereText(tenantChains);
      expect(sql).not.toContain("stage_entered_at");
    } finally {
      if (prev === undefined) delete process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
      else process.env.ENABLE_STAGE_ENTRY_DATE_FILTER = prev;
    }
  });

  it("does not window open columns when the flag is ON but no dashboard period is sent (main kanban = all-time)", async () => {
    const prev = process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
    process.env.ENABLE_STAGE_ENTRY_DATE_FILTER = "true";
    try {
      const { tenantDb, tenantChains } = runBoardCapturingOpenStageSql();
      const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");

      await getDealsForPipeline(tenantDb, "director", "director-1", {
        scope: "all",
        activeOfficeId: null,
        wonAllTime: true,
        lostAllTime: true,
      });

      const sql = openStageWhereText(tenantChains);
      expect(sql).not.toContain("stage_entered_at");
    } finally {
      if (prev === undefined) delete process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
      else process.env.ENABLE_STAGE_ENTRY_DATE_FILTER = prev;
    }
  });
});
