import { beforeEach, describe, expect, it, vi } from "vitest";

// Stage-1 YTD reporting fix: Won-period membership is gated on the true HubSpot
// close-won date (hubspot_extra_properties->>'hs_closed_won_date'), never on the
// reseed-contaminated actual_close_date or on contract_signed_at (commissions-only).
// These tests assert the *generated SQL* uses the new date, applies the on-hold
// and usable-date guards on period queries, and that the §6.8 carve-out's brittle
// bid_board_last_updated_at clause is gone. (Mocked tenantDb — same harness as
// board-service.test.ts. Row-level number correctness is covered by the PR's
// production verification SQL.)

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

describe("won-period hs_closed_won_date SQL helpers", () => {
  it("aliasedWonHsClosedWonDateSql extracts and casts the hs_closed_won_date JSON key with NULLIF guards", async () => {
    const { aliasedWonHsClosedWonDateSql } = await import("../../../src/modules/deals/service.js");
    const text = extractSqlText(aliasedWonHsClosedWonDateSql("d")).toLowerCase();
    expect(text).toContain("hubspot_extra_properties");
    expect(text).toContain("hs_closed_won_date");
    expect(text).toContain("nullif");
    expect(text).toContain("::date");
    // Empty-string and the HubSpot "0" unset sentinel are both stripped.
    expect(text).toContain("''");
    expect(text).toContain("'0'");
    // Never falls back to the reseed-contaminated / commissions-only fields.
    expect(text).not.toContain("actual_close_date");
    expect(text).not.toContain("contract_signed");
    expect(text).not.toContain("updated_at");
  });

  it("aliasedHasUsableWonDateSql guards on a non-null hs close date", async () => {
    const { aliasedHasUsableWonDateSql } = await import("../../../src/modules/deals/service.js");
    const text = extractSqlText(aliasedHasUsableWonDateSql("d")).toLowerCase();
    expect(text).toContain("hs_closed_won_date");
    expect(text).toContain("is not null");
  });

  it("validates the calendar date (days-in-month + leap year) so a value like 2026-02-31 is rejected without throwing (Codex finding 1)", async () => {
    const { aliasedWonHsClosedWonDateSql } = await import("../../../src/modules/deals/service.js");
    const text = extractSqlText(aliasedWonHsClosedWonDateSql("d")).toLowerCase();
    // The day is checked against the month's actual length before any cast: a
    // YYYY-MM-DD + bounded-month/day regex alone still admits 2026-02-31 / 2026-04-31
    // / 2026-02-29-in-a-non-leap-year, all of which `::date` THROWS on (and so does
    // to_date — the round-trip approach is not viable). Behavioural proof
    // (2026-02-31 & 2025-13-45 -> NULL, 2024-02-29 & ISO -> date) is in the PR's
    // read-only SELECT-from-VALUES verification; here we assert the guard is wired.
    expect(text).toContain("substr");
    expect(text).toContain("when 2 then"); // February branch of the month-length CASE
    expect(text).toContain("% 4"); // leap-year divisibility test
    expect(text).toContain("% 400"); // leap-year century rule
  });

  it("guards casts behind a nested regex CASE so malformed text never reaches ::int or ::date", async () => {
    const { aliasedWonHsClosedWonDateSql } = await import("../../../src/modules/deals/service.js");
    const text = extractSqlText(aliasedWonHsClosedWonDateSql("d")).toLowerCase();
    const regexIndex = text.indexOf("~ '^[0-9]{4}");
    const nestedCaseIndex = text.indexOf("then case", regexIndex);
    const firstIntCastIndex = text.indexOf("::int");
    const dateCastIndex = text.indexOf("::date");

    expect(regexIndex).toBeGreaterThanOrEqual(0);
    expect(nestedCaseIndex).toBeGreaterThan(regexIndex);
    expect(firstIntCastIndex).toBeGreaterThan(nestedCaseIndex);
    expect(dateCastIndex).toBeGreaterThan(nestedCaseIndex);
  });

  it("rejects year zero before casting so 0000-01-01 yields NULL instead of a PostgreSQL cast error", async () => {
    const { aliasedWonHsClosedWonDateSql } = await import("../../../src/modules/deals/service.js");
    const text = extractSqlText(aliasedWonHsClosedWonDateSql("d")).toLowerCase();
    expect(text).toContain("substr");
    expect(text).toContain("1, 4");
    expect(text).toContain(">= 1");
    expect(text).toContain("::date");
  });
});

describe("getDealsForPipeline Won branch (CHANGE 2 + 5)", () => {
  beforeEach(() => {
    dbState.responses = [];
  });

  it("gates the period on hs_closed_won_date, requires a usable date, excludes on-hold, and drops the bid_board carve-out", async () => {
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
    expect(where).toContain("hs_closed_won_date");
    expect(where).toContain("is not null"); // usable-date guard (period only)
    expect(where).toContain("on_hold"); // §6.3 on-hold exclusion in the count too
    // Old basis must be gone, and the narrowed carve-out no longer references bblua.
    expect(where).not.toContain("contract_signed");
    expect(where).not.toContain("bid_board_last_updated_at");
  });

  it("composes a VALID multi-bound Won-period WHERE: the date guard is built fresh in every position (eligibility, >=, <=), never one fragment reused across positions (production-500 regression)", async () => {
    // YTD path: BOTH a lower and an upper Won-date bound are set, so the date
    // guard must appear in three positions — IS NOT NULL (eligibility), >= lower,
    // <= upper. The production 500 came from reusing ONE guard fragment object
    // across the >= and <= positions; when the same SQL instance is interpolated
    // more than once the composed SQL is corrupted (the reused instance is dropped
    // on its later occurrence, leaving a comparison with no left-hand operand).
    // extractSqlText models this exactly: its `seen` set renders a repeated SQL
    // instance as "" on the 2nd+ encounter. So a shared fragment yields only TWO
    // fully-rendered guards (eligibility + first bound); a correctly-fresh-per-site
    // composition yields THREE. Prior tests only set a single bound, so they never
    // exercised the reuse — this is the gap they left.
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
    // The full calendar-guard CASE begins with this regex anchor exactly once per
    // fully-rendered guard. Three positions => three anchors. A single shared
    // fragment collapses to two.
    const guardRenders = (where.match(/\^\[0-9\]\{4\}/g) ?? []).length;
    expect(guardRenders).toBe(3);
    // Each date bound's left operand is a COMPLETE guard: the closing `END` of the
    // CASE immediately precedes the comparison operator. A dropped/reused fragment
    // would leave a dangling operator with no `END` before it (e.g. "... and  <= ...").
    // (The harness renders bound params inline, so we don't assert a $n placeholder.)
    expect(where).toMatch(/end\s*>=/);
    expect(where).toMatch(/end\s*<=/);
    // No scrambled/duplicated guard from interleaved reuse.
    expect(where).not.toMatch(/then case\s+then case/);
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
    expect(where).not.toContain("hs_closed_won_date"); // no period gate / guard
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

  it("wonClosedFrom/To filter gates on hs_closed_won_date + usable guard + on-hold exclusion", async () => {
    const { tenantDb, chains } = buildListTenantDb();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(
      tenantDb,
      { scope: "all", wonClosedFrom: "2026-01-01", wonClosedTo: "2026-05-31" },
      "director",
      "director-1"
    );

    const where = rowsWhereSql(chains);
    expect(where).toContain("hs_closed_won_date");
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
    expect(where).toContain("hs_closed_won_date");
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

  it("contractSignedFrom/To stays on contract_signed (commissions surface, §6.5) and does not use hs_closed_won_date", async () => {
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
    expect(where).not.toContain("hs_closed_won_date");
  });
});
