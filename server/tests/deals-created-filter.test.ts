import { beforeEach, describe, expect, it, vi } from "vitest";

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
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockResolvedValue([]),
  };

  dataChain.then = vi.fn((resolve: any) => resolve([{ count: 0 }]));

  return {
    db: { select: vi.fn().mockReturnValue(dataChain) } as any,
    capturedWheres,
  };
}

describe("getDeals — created-date filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits inclusive created-date bounds plus rep scoping when both are set", async () => {
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../src/modules/deals/service.js");

    await getDeals(
      db,
      {
        assignedRepId: "rep-1",
        createdFrom: "2026-05-01",
        createdTo: "2026-05-21",
        sortBy: "created_at",
        sortDir: "desc",
        limit: 50,
      },
      "director",
      "director-1"
    );

    const sql = capturedWheres.map(extractSqlText).join("\n");
    expect(sql).toContain("created_at");
    expect(sql).toMatch(/created_at.*>=/is);
    expect(sql).toMatch(/created_at.*interval '1 day'/is);
    expect(sql).toContain("assigned_rep_id");
  });

  it("omits created-date bounds when not requested", async () => {
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../src/modules/deals/service.js");

    await getDeals(db, { limit: 25 }, "director", "director-1");

    const sql = capturedWheres.map(extractSqlText).join("\n");
    expect(sql).not.toMatch(/created_at.*interval '1 day'/is);
  });
});
