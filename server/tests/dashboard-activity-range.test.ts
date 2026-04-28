import { describe, expect, it, vi, beforeEach } from "vitest";

// Companion to dashboard-rep-ytd-mtd.test.ts. Locks in the SQL shape of
// the activity-by-type query for each `range` value plus the silent
// fallback for invalid input. Date-window correctness (does the SQL
// actually count the right rows when run against real Postgres?) is NOT
// validated here — that requires real-DB infra; tracked in TODO.md
// "Dashboard test coverage gaps".

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

function createMockTenantDb() {
  let callIndex = 0;
  return {
    execute: vi.fn().mockImplementation(() => {
      callIndex++;
      return Promise.resolve({ rows: [] });
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

// Find the activity-by-type query (it filters on a.responsible_user_id and
// counts by type). Robust to insertion-order changes in getRepDashboard.
function findActivitySql(executeMock: any): string {
  const all: string[] = executeMock.mock.calls.map((c: any[]) =>
    extractSqlText(c[0]).toLowerCase()
  );
  const match = all.find((s) => s.includes("filter (where type = 'call')") && s.includes("from activities"));
  if (!match) {
    throw new Error(
      "No tenantDb.execute call matched the activity-by-type query — Commit 8 query missing or restructured"
    );
  }
  return match;
}

describe("getRepDashboard activity range parameter (Commit 8)", () => {
  beforeEach(() => {
    getMyCleanupQueueMock.mockReset();
    getMyCleanupQueueMock.mockResolvedValue({ rows: [], byReason: [] });
  });

  it("default (no options): SQL anchors a 7-day-back date in CT, not month or year start", async () => {
    const { getRepDashboard } = await import("../src/modules/dashboard/service.js");
    const tenantDb = createMockTenantDb();
    await getRepDashboard(tenantDb, "rep-1");
    const sql = findActivitySql(tenantDb.execute);

    // POSITIVE: CT-anchored AT TIME ZONE clause must be present for any range.
    expect(sql).toContain("at time zone 'america/chicago'");
    // POSITIVE: a YYYY-MM-DD::date binding is present.
    expect(sql).toMatch(/\d{4}-\d{2}-\d{2}::date/);

    // NEGATIVE: must not anchor to month start (-01) or year start (-01-01)
    // when no range is specified — default is `week`. We assert by checking
    // the embedded date does NOT end with -01 alone (month start) AND does
    // NOT match the YYYY-01-01 year-start pattern.
    const dateMatch = sql.match(/(\d{4}-\d{2}-\d{2})::date at time zone 'america\/chicago'/);
    expect(dateMatch, "expected to find the activity-window date binding").not.toBeNull();
    const date = dateMatch![1]!;
    expect(date).not.toMatch(/-01-01$/); // not Jan 1 (ytd)
    expect(date).not.toMatch(/-01$/); // not first-of-month — caveat: a week-back date that happens to land on the 1st of a month would trigger a false positive. Acceptable risk: only fires on 7 specific calendar boundaries per year and the failure is loud, not silent.
  });

  it("range='month': SQL anchors to first-of-current-month in CT, not week-back or year start", async () => {
    const { getRepDashboard } = await import("../src/modules/dashboard/service.js");
    const tenantDb = createMockTenantDb();
    await getRepDashboard(tenantDb, "rep-1", { range: "month" });
    const sql = findActivitySql(tenantDb.execute);

    expect(sql).toContain("at time zone 'america/chicago'");
    const dateMatch = sql.match(/(\d{4}-\d{2}-\d{2})::date at time zone 'america\/chicago'/);
    expect(dateMatch).not.toBeNull();
    const date = dateMatch![1]!;
    // POSITIVE: must end with -DD where DD is "01" (first of the month).
    expect(date).toMatch(/-01$/);
    // NEGATIVE: must NOT be Jan 1 unless we're actually in January (only
    // valid when the test runs in January; otherwise a Jan 1 binding means
    // the code wrongly used yearStart for month).
    const todayMonth = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Chicago",
    }).slice(5, 7);
    if (todayMonth !== "01") {
      expect(date).not.toMatch(/-01-01$/);
    }
  });

  it("range='ytd': SQL anchors to Jan 1 of current CT year, not week-back or month start", async () => {
    const { getRepDashboard } = await import("../src/modules/dashboard/service.js");
    const tenantDb = createMockTenantDb();
    await getRepDashboard(tenantDb, "rep-1", { range: "ytd" });
    const sql = findActivitySql(tenantDb.execute);

    expect(sql).toContain("at time zone 'america/chicago'");
    const dateMatch = sql.match(/(\d{4}-\d{2}-\d{2})::date at time zone 'america\/chicago'/);
    expect(dateMatch).not.toBeNull();
    const date = dateMatch![1]!;
    // POSITIVE: must be Jan 1 of some year.
    expect(date).toMatch(/^\d{4}-01-01$/);
    // POSITIVE: must be the current CT year (not last year, not next).
    const todayYear = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Chicago",
    }).slice(0, 4);
    expect(date.slice(0, 4)).toBe(todayYear);
  });

  it("range='week': SQL anchors to today-CT minus 7 days, not month or year start", async () => {
    const { getRepDashboard } = await import("../src/modules/dashboard/service.js");
    const tenantDb = createMockTenantDb();
    await getRepDashboard(tenantDb, "rep-1", { range: "week" });
    const sql = findActivitySql(tenantDb.execute);

    expect(sql).toContain("at time zone 'america/chicago'");
    const dateMatch = sql.match(/(\d{4}-\d{2}-\d{2})::date at time zone 'america\/chicago'/);
    expect(dateMatch).not.toBeNull();
    const date = dateMatch![1]!;

    // POSITIVE: matches expected today-CT minus 7 days.
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Chicago",
    });
    const [y, m, d] = today.split("-").map(Number);
    const ref = new Date(Date.UTC(y!, m! - 1, d!) - 7 * 24 * 60 * 60 * 1000);
    const expected = `${ref.getUTCFullYear()}-${String(ref.getUTCMonth() + 1).padStart(2, "0")}-${String(ref.getUTCDate()).padStart(2, "0")}`;
    expect(date).toBe(expected);
  });

  it("invalid range value silently falls back to 'week' (matches house-style query-param handling)", async () => {
    const { getRepDashboard } = await import("../src/modules/dashboard/service.js");
    const tenantDb = createMockTenantDb();
    // Cast through unknown — TS would normally reject this, but route layer
    // passes whatever string it received from req.query.
    await getRepDashboard(tenantDb, "rep-1", { range: "garbage" as unknown as never });
    const sql = findActivitySql(tenantDb.execute);

    const dateMatch = sql.match(/(\d{4}-\d{2}-\d{2})::date at time zone 'america\/chicago'/);
    expect(dateMatch).not.toBeNull();
    const actualDate = dateMatch![1]!;

    // Must equal the same date the explicit week call produces.
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Chicago",
    });
    const [y, m, d] = today.split("-").map(Number);
    const ref = new Date(Date.UTC(y!, m! - 1, d!) - 7 * 24 * 60 * 60 * 1000);
    const expected = `${ref.getUTCFullYear()}-${String(ref.getUTCMonth() + 1).padStart(2, "0")}-${String(ref.getUTCDate()).padStart(2, "0")}`;
    expect(actualDate).toBe(expected);

    // Also must NOT be a YTD or month-start binding.
    expect(actualDate).not.toMatch(/^\d{4}-01-01$/);
  });

  it("response shape: activityThisWeek key remains intact regardless of range (no breaking rename)", async () => {
    const { getRepDashboard } = await import("../src/modules/dashboard/service.js");
    const tenantDb = createMockTenantDb();
    const result = await getRepDashboard(tenantDb, "rep-1", { range: "month" });

    // Key name is `activityThisWeek` for backwards-compat — the JSON shape
    // does NOT rename when the range is non-week. The UI handles the label
    // ambiguity (Commit 8 frontend changes the StatCard title to "Activity").
    expect(result.activityThisWeek).toBeDefined();
    expect(result.activityThisWeek).toMatchObject({
      calls: expect.any(Number),
      emails: expect.any(Number),
      meetings: expect.any(Number),
      notes: expect.any(Number),
      total: expect.any(Number),
    });
  });
});
