import { beforeEach, describe, expect, it, vi } from "vitest";
import { deals, users } from "@trock-crm/shared/schema";

const dbState = vi.hoisted(() => ({
  stages: [
    {
      id: "stage-estimating",
      slug: "estimating",
      name: "Estimating",
      displayOrder: 1,
      isTerminal: false,
      isActivePipeline: true,
    },
  ],
}));

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/types", async () => import("../../../../shared/src/types/index.js"));
vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      then: vi.fn((resolve: (value: unknown[]) => unknown) => resolve(dbState.stages)),
    })),
  },
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
  return "";
}

function containsValue(value: unknown, expected: string, seen = new Set<unknown>()): boolean {
  if (value === expected) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsValue(item, expected, seen));
  return Object.values(value as Record<string, unknown>).some((item) => containsValue(item, expected, seen));
}

describe("getDealsForPipeline team scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses direct active reports in the active office for team-scoped board queries", async () => {
    const teamQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ id: "rep-team-1" }, { id: "rep-team-2" }]),
    };
    const dealQuery = {
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    const tenantDb = {
      select: vi.fn((fields?: Record<string, unknown>) => ({
        from: vi.fn((table: unknown) => {
          if (table === users) return teamQuery;
          if (table === deals) return dealQuery;
          return dealQuery;
        }),
      })),
    } as any;

    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    await getDealsForPipeline(tenantDb, "director", "director-1", {
      scope: "team",
      activeOfficeId: "office-1",
      includeDd: true,
    });

    expect(tenantDb.select).toHaveBeenCalledWith(expect.objectContaining({ id: expect.anything() }));
    const queryText = extractSqlText(dealQuery.where.mock.calls[0][0]);
    expect(queryText).toContain("assigned_rep_id");
    expect(containsValue(dealQuery.where.mock.calls[0][0], "rep-team-1")).toBe(true);
    expect(containsValue(dealQuery.where.mock.calls[0][0], "rep-team-2")).toBe(true);
  });
});
