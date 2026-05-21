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

function createTenantDbCapturingLeadQueries() {
  const capturedWheres: unknown[] = [];
  const capturedOrderBy: unknown[] = [];

  const dataChain: any = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation((condition: unknown) => {
      capturedWheres.push(condition);
      return dataChain;
    }),
    orderBy: vi.fn().mockImplementation((...args: unknown[]) => {
      capturedOrderBy.push(args);
      return Promise.resolve([]);
    }),
  };

  return {
    db: { select: vi.fn().mockReturnValue(dataChain) } as any,
    capturedWheres,
    capturedOrderBy,
  };
}

describe("listLeads — created-date and stage filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits created-date, rep, stage, and status filters and sorts newest-first when requested", async () => {
    const { db, capturedWheres, capturedOrderBy } = createTenantDbCapturingLeadQueries();
    const leadService = await import("../src/modules/leads/service.js");

    await leadService.listLeads(
      db,
      {
        assignedRepId: "rep-1",
        stageIds: ["stage-a", "stage-b"],
        status: "open",
        createdFrom: "2026-05-01",
        createdTo: "2026-05-21",
        sortBy: "created_at",
        sortDir: "desc",
      },
      "director",
      "director-1"
    );

    const sql = capturedWheres.map(extractSqlText).join("\n");
    expect(sql).toContain("assigned_rep_id");
    expect(sql).toContain("stage_id");
    expect(sql).toContain("status");
    expect(sql).toMatch(/created_at.*>=/is);
    expect(sql).toMatch(/created_at.*interval '1 day'/is);

    const orderSql = capturedOrderBy.flatMap((args) => args.map(extractSqlText)).join("\n");
    expect(orderSql).toContain("created_at");
  });
});
