import { describe, expect, it, vi, beforeEach } from "vitest";

// Mirrors the conventions in tests/modules/dashboard/service.test.ts:
// chainable Drizzle mock for the public-schema `db` import + positional
// response array for tenantDb.execute() calls in invocation order.
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

vi.mock("../src/db.js", () => ({
  db: createChainableMock([]),
}));

const getMyCleanupQueueMock = vi.hoisted(() => vi.fn());

vi.mock("../src/modules/admin/cleanup-queue-service.js", () => ({
  getMyCleanupQueue: getMyCleanupQueueMock,
}));

vi.mock("../src/modules/migration/service.js", () => ({
  getMigrationSummary: vi.fn().mockResolvedValue({
    deals: { needs_review: 0 },
    contacts: { needs_review: 0 },
    activities: { needs_review: 0 },
    companies: { needs_review: 0 },
    properties: { needs_review: 0 },
    leads: { needs_review: 0 },
    recentRuns: [],
  }),
}));

function createMockTenantDb(responses: any[][] = []) {
  let callIndex = 0;
  return {
    execute: vi.fn().mockImplementation(() => {
      const rows = responses[callIndex] ?? [];
      callIndex++;
      return Promise.resolve({ rows });
    }),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnValue([]),
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
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return "";
}

// Find a tenantDb.execute() call by SQL content match. Robust to changes in
// the order of queries inside getRepDashboard's Promise.all — relies on the
// `contract_signed_date` column reference, which is unique to the new query.
function findContractsSignedSql(executeMock: any): string {
  const allSqlTexts: string[] = executeMock.mock.calls.map((c: any[]) =>
    extractSqlText(c[0]).toLowerCase()
  );
  const match = allSqlTexts.find((s) => s.includes("contract_signed_date"));
  if (!match) {
    throw new Error(
      "No tenantDb.execute call matched contract_signed_date — Commit 7 query is missing or the column was renamed"
    );
  }
  return match;
}

describe("getRepDashboard contracts-signed YTD/MTD cards (Commit 7)", () => {
  beforeEach(() => {
    getMyCleanupQueueMock.mockReset();
    getMyCleanupQueueMock.mockResolvedValue({ rows: [], byReason: [] });
  });

  it("rep with no signed contracts: both cards return zeros, response shape intact", async () => {
    const { getRepDashboard } = await import("../src/modules/dashboard/service.js");
    // No fixtures provided for the contracts-signed query — createMockTenantDb
    // returns [] for unspecified call indices, which becomes count=0 / value=0
    // after the Number(... ?? 0) coercions in the response builder.
    const tenantDb = createMockTenantDb([]);

    const result = await getRepDashboard(tenantDb, "rep-1");

    expect(result.contractsSignedYtd).toEqual({ count: 0, totalValue: 0 });
    expect(result.contractsSignedMtd).toEqual({ count: 0, totalValue: 0 });
    // Endpoint-equivalent: function resolved (the route handler does nothing
    // beyond res.json(data); a 200 is the natural consequence).
  });

  it("response shape threads csRows fields correctly when query returns data", async () => {
    const { getRepDashboard } = await import("../src/modules/dashboard/service.js");
    // Position the contracts-signed fixture at index 14 — the last execute()
    // call in getRepDashboard's Promise.all body. If insertion order changes
    // upstream this assertion will surface it via wrong values rather than
    // silent failure.
    const responses: any[][] = new Array(14).fill([]);
    responses[14] = [
      { ytd_count: "7", ytd_value: "525000.00", mtd_count: "2", mtd_value: "150000.00" },
    ];
    const tenantDb = createMockTenantDb(responses);

    const result = await getRepDashboard(tenantDb, "rep-1");

    expect(result.contractsSignedYtd).toEqual({ count: 7, totalValue: 525000 });
    expect(result.contractsSignedMtd).toEqual({ count: 2, totalValue: 150000 });
  });

  // Case 4 from the Commit 7 acceptance criteria: a deal with
  // contract_signed_date set but awarded_amount NULL must contribute to count
  // but NOT to totalValue. We can't exercise real Postgres NULL semantics
  // through mocks, so this test locks in the strict-semantics decision at the
  // SQL string level: SUM(awarded_amount) standalone, NEVER COALESCE with
  // estimate fallbacks. A future "fix" that tries to blend bid/dd estimates
  // into the sum would flip these assertions and fail this test.
  it("SQL strict semantics: SUM(awarded_amount) only, never COALESCE with estimate fallbacks", async () => {
    const { getRepDashboard } = await import("../src/modules/dashboard/service.js");
    const tenantDb = createMockTenantDb([]);

    await getRepDashboard(tenantDb, "rep-1");

    const sql = findContractsSignedSql(tenantDb.execute);

    // POSITIVE: standalone SUM(awarded_amount) appears exactly twice — one
    // for ytd_value and one for mtd_value FILTER aggregates. Strict count
    // intentionally: if this changes (e.g. a quarterly window is added, or
    // the two are consolidated via a subquery), update this assertion
    // intentionally — don't silence by bumping the number. A stray third
    // SUM would silently double-count one of the windows.
    expect(sql).toMatch(/sum\(awarded_amount\)/);
    const sumOccurrences = (sql.match(/sum\(awarded_amount\)/g) ?? []).length;
    expect(sumOccurrences).toBe(2);

    // NEGATIVE: must NOT use COALESCE(awarded_amount, ...) anywhere — that
    // would silently blend in bid_estimate / dd_estimate, violating the
    // strict "only signed contract amounts contribute to totalValue" decision.
    expect(sql).not.toMatch(/coalesce\(awarded_amount\s*,/);
    // Belt-and-suspenders: the specific fallback pattern used elsewhere in
    // the dashboard (active deals query) must not have been copy-pasted in.
    expect(sql).not.toContain("coalesce(d.awarded_amount, d.bid_estimate, d.dd_estimate");
    expect(sql).not.toContain("coalesce(awarded_amount, bid_estimate, dd_estimate");
  });

  // Case 5 from the Commit 7 acceptance criteria: a deal with a future-dated
  // contract_signed_date must be excluded from both YTD and MTD windows.
  // Same reason as case 4 — can't exercise the date math through mocks, so
  // we lock in the guard's existence at the SQL level.
  it("SQL future-date guard: contract_signed_date <= today binding present", async () => {
    const { getRepDashboard } = await import("../src/modules/dashboard/service.js");
    const tenantDb = createMockTenantDb([]);

    await getRepDashboard(tenantDb, "rep-1");

    const sql = findContractsSignedSql(tenantDb.execute);

    // POSITIVE: the upper-bound clause is present.
    expect(sql).toContain("contract_signed_date <=");
    // POSITIVE: the bound has a `::date` cast (we bind today as a YYYY-MM-DD
    // string and cast it to ::date in the query — the cast matters because
    // a missing one would treat the bound as text and silently break sort
    // order on some Postgres versions). extractSqlText inlines the parameter
    // value so we match against the rendered shape `<= <something>::date`.
    expect(sql).toMatch(/contract_signed_date\s*<=\s*\S+::date/);

    // POSITIVE: NULL filter is present so we don't try to compare NULL <= date.
    expect(sql).toContain("contract_signed_date is not null");

    // NEGATIVE: a missing upper bound would let future-dated rows leak into
    // both windows. If a future refactor drops the <= clause this assertion
    // (combined with the POSITIVE one above) catches it.
    const lowerBoundOnly = /contract_signed_date\s*>=/.test(sql);
    const upperBoundPresent = /contract_signed_date\s*<=/.test(sql);
    expect(lowerBoundOnly).toBe(true);
    expect(upperBoundPresent).toBe(true);
  });
});
