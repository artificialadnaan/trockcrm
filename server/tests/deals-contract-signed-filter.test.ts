import { describe, expect, it, vi, beforeEach } from "vitest";

// Verify that the contractSignedFrom/contractSignedTo filters added to
// getDeals materialize as bounded contract_signed_date conditions in the
// generated SQL. Mirrors the SQL-string-assertion pattern established by
// dashboard-rep-ytd-mtd.test.ts (the dashboard YTD/MTD card query).
//
// Strict positive AND negative assertions:
//   - When set, the SQL contains both a >= bound and a <= bound on
//     contract_signed_date, plus the rep scoping condition.
//   - When NOT set, neither bound appears in the SQL.

vi.mock("../src/db.js", () => ({
  db: {} as any,
  pool: {} as any,
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
  return "";
}

function createTenantDbCapturingWhere() {
  const capturedWheres: unknown[] = [];

  const dataChain: any = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation((condition: unknown) => {
      capturedWheres.push(condition);
      return dataChain;
    }),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockResolvedValue([]),
  };

  // Count branch — also resolves the `await tenantDb.select(...).from(...).where(...)`
  // Promise.all leg by being a thenable.
  dataChain.then = vi.fn((resolve: any) => resolve([{ count: 0 }]));

  return {
    db: { select: vi.fn().mockReturnValue(dataChain) } as any,
    capturedWheres,
  };
}

describe("getDeals — contract_signed_date filter (rep dashboard YTD/MTD click-through)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits >= and <= bounds on contract_signed_date plus rep scoping when both set", async () => {
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../src/modules/deals/service.js");

    await getDeals(
      db,
      {
        assignedRepId: "rep-1",
        contractSignedFrom: "2026-01-01",
        contractSignedTo: "2026-04-28",
        sortBy: "contract_signed_date",
        sortDir: "desc",
        limit: 100,
      },
      "rep",
      "rep-1"
    );

    expect(capturedWheres.length).toBeGreaterThan(0);
    const sql = capturedWheres.map(extractSqlText).join("\n");

    expect(sql).toMatch(/contract_signed_date.*>=/);
    expect(sql).toMatch(/contract_signed_date.*<=/);
    expect(sql).toContain("assigned_rep_id");
    // is_active default still applied
    expect(sql).toContain("is_active");
  });

  it("omits contract_signed_date bounds entirely when filter not set", async () => {
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../src/modules/deals/service.js");

    await getDeals(
      db,
      { limit: 25 },
      "director",
      "director-1"
    );

    expect(capturedWheres.length).toBeGreaterThan(0);
    const sql = capturedWheres.map(extractSqlText).join("\n");

    expect(sql).not.toContain("contract_signed_date");
  });
});
