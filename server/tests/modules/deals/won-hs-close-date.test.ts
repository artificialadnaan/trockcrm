import { beforeEach, describe, expect, it, vi } from "vitest";

// Won-period reporting basis = the app-owned deals.won_closed_date column (flipped
// in step D of the expand/migrate/contract; migration 0141 + dual-write + backfill).
// Before the flip the helpers gated on the HubSpot JSON close-won date
// (hubspot_extra_properties->>'hs_closed_won_date' via public.try_parse_hs_close_date);
// that parse now survives only in the backfill/reseed path. These tests assert the
// *generated SQL* reads won_closed_date, applies the on-hold and usable-date guards
// on period queries, and that the old HubSpot-JSON / try_parse read and the §6.8
// bid_board_last_updated_at carve-out are gone from the read path. (Mocked tenantDb;
// row-level correctness is covered by the PR's read-only parity verification SQL.)

const dbState = vi.hoisted(() => ({ responses: [] as any[][] }));

function createChainableMock() {
  const chain: any = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    leftJoin: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    offset: vi.fn(),
    then: vi.fn((resolve: (value: any[]) => unknown) => resolve(dbState.responses.shift() ?? [])),
  };
  for (const key of ["select", "from", "where", "leftJoin", "orderBy", "limit", "offset"]) {
    chain[key].mockReturnValue(chain);
  }
  return chain;
}

function extractSqlText(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);
  const node = value as Record<string, unknown>;
  if (Array.isArray((node as { queryChunks?: unknown[] }).queryChunks)) {
    return (node.queryChunks as unknown[]).map((c) => extractSqlText(c, seen)).join("");
  }
  if ("value" in node) {
    const v = node.value;
    if (Array.isArray(v)) return v.map((c) => extractSqlText(c, seen)).join("");
    if (typeof v === "string") return v;
  }
  if (typeof node.name === "string") return node.name as string;
  return Object.values(node).map((c) => extractSqlText(c, seen)).join("");
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

const WON_STAGES = [
  { id: "stage-open", slug: "opportunity", name: "Opportunity", displayOrder: 1, isTerminal: false, isActivePipeline: true },
  { id: "stage-won", slug: "won", name: "Won", displayOrder: 2, isTerminal: true, isActivePipeline: true },
  { id: "stage-closed-won", slug: "closed_won", name: "Closed Won", displayOrder: 3, isTerminal: true, isActivePipeline: false },
];

function buildPipelineTenantDb() {
  const chains: any[] = [];
  const tenantDb = {
    select: vi.fn((...selectArgs: unknown[]) => {
      const chain = createChainableMock();
      chain._selectArgs = selectArgs;
      chains.push(chain);
      chain.then.mockImplementation((resolve: (value: any[]) => unknown) => {
        const isCards = chain.leftJoin.mock.calls.length > 0;
        if (isCards) return resolve([]);
        return resolve([{ totalCount: 0, activeCount: 0, totalValue: 0 }]);
      });
      return chain;
    }),
  } as any;
  return { tenantDb, chains };
}

// The Won summary query is the one whose WHERE references the won stage id and
// has no leftJoin (the aggregate, not the cards select).
function wonSummaryWhereSql(chains: any[]): string {
  const chain = chains.find(
    (c) => c.leftJoin.mock.calls.length === 0 && containsValue(c.where.mock.calls[0]?.[0], "stage-won")
  );
  return extractSqlText(chain?.where.mock.calls[0]?.[0]).toLowerCase();
}

describe("won-period won_closed_date SQL helpers", () => {
  it("aliasedWonHsClosedWonDateSql reads the app-owned won_closed_date column (flipped off the HubSpot JSON)", async () => {
    const { aliasedWonHsClosedWonDateSql } = await import("../../../src/modules/deals/service.js");
    const text = extractSqlText(aliasedWonHsClosedWonDateSql("d")).toLowerCase();
    // FLIPPED (step D): the helper is now `<alias>.won_closed_date`.
    expect(text).toContain("won_closed_date");
    // No longer reads the HubSpot JSON blob or the migration-0140 parse function
    // (those survive only in the backfill/reseed path).
    expect(text).not.toContain("hubspot_extra_properties");
    expect(text).not.toContain("try_parse_hs_close_date");
    // Never falls back to the reseed-contaminated / commissions-only fields.
    expect(text).not.toContain("actual_close_date");
    expect(text).not.toContain("contract_signed");
    expect(text).not.toContain("updated_at");
  });

  it("aliasedHasUsableWonDateSql guards on a non-null won_closed_date", async () => {
    const { aliasedHasUsableWonDateSql } = await import("../../../src/modules/deals/service.js");
    const text = extractSqlText(aliasedHasUsableWonDateSql("d")).toLowerCase();
    expect(text).toContain("won_closed_date");
    expect(text).toContain("is not null");
    expect(text).not.toContain("try_parse_hs_close_date");
  });

  it("emits the bare app-owned won_closed_date column, NOT a parse call or inline CASE", async () => {
    const { aliasedWonHsClosedWonDateSql } = await import("../../../src/modules/deals/service.js");
    const text = extractSqlText(aliasedWonHsClosedWonDateSql("d")).toLowerCase();
    // Post-flip the read path carries one compact column reference. The HubSpot
    // parse (public.try_parse_hs_close_date) and the old inline calendar CASE are
    // gone from the read path entirely.
    expect(text).toContain("won_closed_date");
    expect(text).not.toContain("public.try_parse_hs_close_date(");
    expect(text).not.toContain("case"); // no inline CASE
    expect(text).not.toContain("substr");
    expect(text).not.toContain("::int");
  });
});

describe("getDealsForPipeline Won branch (CHANGE 2 + 5)", () => {
  beforeEach(() => {
    dbState.responses = [];
  });

  it("gates the period on won_closed_date, requires a usable date, excludes on-hold, and drops the bid_board carve-out", async () => {
    dbState.responses = [WON_STAGES];
    const { tenantDb, chains } = buildPipelineTenantDb();
    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");

    await getDealsForPipeline(tenantDb, "director", "director-1", {
      activeOfficeId: null,
      scope: "all",
      previewLimit: 8,
      wonSince: "2026-01-01",
    });

    const where = wonSummaryWhereSql(chains);
    expect(where).toContain("won_closed_date");
    expect(where).toContain("deals.won_closed_date");
    expect(where).toContain("is not null"); // usable-date guard (period only)
    expect(where).toContain("on_hold"); // §6.3 on-hold exclusion in the count too
    // Old bases must be gone, and the narrowed carve-out no longer references bblua.
    expect(where).not.toContain("hubspot_extra_properties");
    expect(where).not.toContain("contract_signed");
    expect(where).not.toContain("bid_board_last_updated_at");
  });

  it("composes a VALID multi-bound Won-period WHERE: the won_closed_date column appears in every position (eligibility, >=, <=), built fresh per site", async () => {
    // YTD path: BOTH a lower and an upper Won-date bound are set, so the date guard
    // must appear in three positions -- IS NOT NULL (eligibility), >= lower, <= upper.
    // The helper builds a fresh fragment per site; extractSqlText's `seen` set renders
    // a *reused* SQL instance as "" on its 2nd+ encounter, so a shared fragment would
    // collapse to TWO fully-rendered column references while a correctly-fresh-per-site
    // composition yields THREE. Prior single-bound tests never exercised this.
    dbState.responses = [WON_STAGES];
    const { tenantDb, chains } = buildPipelineTenantDb();
    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");

    await getDealsForPipeline(tenantDb, "director", "director-1", {
      activeOfficeId: null,
      scope: "all",
      previewLimit: 8,
      wonSince: "2026-01-01",
      wonUntil: "2026-05-28",
    });

    const where = wonSummaryWhereSql(chains);
    // One fully-rendered guard per position. Three positions => three column refs.
    // A single shared/reused fragment collapses to two under the `seen` dedup.
    const guardRenders = (where.match(/won_closed_date/g) ?? []).length;
    expect(guardRenders).toBe(3);
    expect(where).toContain("deals.won_closed_date");
    // Each date bound's left operand is the column, immediately preceding the
    // comparison operator; a dropped/reused fragment would leave a dangling operator.
    expect(where).toMatch(/won_closed_date\s*>=/);
    expect(where).toMatch(/won_closed_date\s*<=/);
    // The inline calendar CASE and the HubSpot parse are gone entirely.
    expect(where).not.toContain("case");
    expect(where).not.toContain("try_parse_hs_close_date");
    expect(where).toContain("is not null");
  });

  it("all-time (no period window) omits the usable-date guard so null-date Won deals still count, but still excludes on-hold", async () => {
    dbState.responses = [WON_STAGES];
    const { tenantDb, chains } = buildPipelineTenantDb();
    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");

    await getDealsForPipeline(tenantDb, "director", "director-1", {
      activeOfficeId: null,
      scope: "all",
      previewLimit: 8,
      wonAllTime: true, // explicit all-time (the board otherwise defaults to a 30d window)
    });

    const where = wonSummaryWhereSql(chains);
    expect(where).not.toContain("won_closed_date"); // no period gate / guard
    expect(where).toContain("on_hold"); // on-hold still excluded all-time
  });
});

describe("getDeals won drill-down (CHANGE 3)", () => {
  beforeEach(() => {
    // listDealStages() (used to resolve the Won-stage constraint, finding 2) reads
    // the mocked global db; feed it the stage set.
    dbState.responses = [WON_STAGES];
  });

  function buildListTenantDb() {
    const chains: any[] = [];
    const tenantDb = {
      select: vi.fn((...selectArgs: unknown[]) => {
        const chain = createChainableMock();
        chain._selectArgs = selectArgs;
        chains.push(chain);
        chain.then.mockImplementation((resolve: (value: any[]) => unknown) => {
          const isRows = chain.leftJoin.mock.calls.length > 0;
          return resolve(isRows ? [] : [{ count: 0 }]);
        });
        return chain;
      }),
    } as any;
    return { tenantDb, chains };
  }

  function rowsWhereSql(chains: any[]): string {
    const chain = chains.find((c) => c.leftJoin.mock.calls.length > 0);
    return extractSqlText(chain?.where.mock.calls[0]?.[0]).toLowerCase();
  }

  it("wonClosedFrom/To filter gates on won_closed_date + usable guard + on-hold exclusion", async () => {
    const { tenantDb, chains } = buildListTenantDb();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(
      tenantDb,
      { scope: "all", wonClosedFrom: "2026-01-01", wonClosedTo: "2026-05-31" },
      "director",
      "director-1"
    );

    const where = rowsWhereSql(chains);
    expect(where).toContain("won_closed_date");
    expect(where).toContain("is not null");
    expect(where).toContain("on_hold");
    // Finding 2: the drill-down is constrained to the canonical Won-family stages,
    // so it matches the Won card exactly (a previously-Won deal now in a non-Won
    // active stage is excluded).
    expect(where).toContain("stage-won");
    expect(where).toContain("stage-closed-won");
  });

  it("allows inactive Won-family aliases through pipeline visibility for wonClosedFrom/To", async () => {
    const { tenantDb, chains } = buildListTenantDb();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(
      tenantDb,
      {
        scope: "all",
        isActive: "pipeline",
        inactiveStageIds: ["stage-won"],
        wonClosedFrom: "2026-01-01",
        wonClosedTo: "2026-05-31",
      },
      "director",
      "director-1"
    );

    const where = rowsWhereSql(chains);
    expect(where).toContain("is_active");
    expect(where).toContain("stage-won");
    expect(where).toContain("stage-closed-won");
  });

  it("opts inactive Won-family aliases into wonClosedFrom/To even when isActive defaults to true", async () => {
    const { tenantDb, chains } = buildListTenantDb();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(
      tenantDb,
      {
        scope: "all",
        wonClosedFrom: "2026-01-01",
        wonClosedTo: "2026-05-31",
      },
      "director",
      "director-1"
    );

    const where = rowsWhereSql(chains);
    expect(where).toContain("is_active");
    expect(where).toContain("stage-won");
    expect(where).toContain("stage-closed-won");
    expect(where).toContain("won_closed_date");
  });

  it("constrains the won drill-down to Won stages and intersects with caller-supplied stageIds (Codex finding 2)", async () => {
    const { tenantDb, chains } = buildListTenantDb();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(
      tenantDb,
      { scope: "all", wonClosedFrom: "2026-01-01", stageIds: ["stage-open"] },
      "director",
      "director-1"
    );

    const where = rowsWhereSql(chains);
    // Both the caller's stage filter AND the Won-stage constraint are present (AND-ed),
    // so an explicit non-Won stage + won-period window intersects to no rows.
    expect(where).toContain("stage-open");
    expect(where).toContain("stage-won");
  });

  it("contractSignedFrom/To stays on contract_signed (commissions surface, §6.5) and does not use the won-period column", async () => {
    const { tenantDb, chains } = buildListTenantDb();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(
      tenantDb,
      { scope: "all", contractSignedFrom: "2026-01-01", contractSignedTo: "2026-05-31" },
      "director",
      "director-1"
    );

    const where = rowsWhereSql(chains);
    expect(where).toContain("contract_signed");
    expect(where).not.toContain("won_closed_date");
    expect(where).not.toContain("hs_closed_won_date");
  });
});
