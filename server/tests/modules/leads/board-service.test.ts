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
  return "";
}

describe("listLeadBoard", () => {
  beforeEach(() => {
    dbState.responses = [];
  });

  it("returns lead board columns grouped by active office stage with ordered cards", async () => {
    dbState.responses = [
      [
        { id: "stage-contacted", slug: "contacted", name: "Contacted", displayOrder: 1, isTerminal: false },
        { id: "stage-qualified", slug: "qualified", name: "Qualified", displayOrder: 2, isTerminal: false },
      ],
      [{ id: "deal-stage-1" }],
    ];

    const tenantDb = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          {
            id: "lead-1",
            name: "Acme HQ",
            stage_id: "stage-contacted",
            office_id: "office-1",
            company_name: "Acme",
            property_city: "Dallas",
            property_state: "TX",
            updated_at: "2026-04-21T10:00:00.000Z",
            stage_entered_at: "2026-04-20T10:00:00.000Z",
          },
          {
            id: "lead-2",
            name: "Beta HQ",
            stage_id: "stage-contacted",
            office_id: "office-1",
            company_name: "Beta",
            property_city: "Austin",
            property_state: "TX",
            updated_at: "2026-04-19T10:00:00.000Z",
            stage_entered_at: "2026-04-18T10:00:00.000Z",
          },
        ],
      }),
    } as any;

    const { listLeadBoard } = await import("../../../src/modules/leads/service.js");
    const result = await listLeadBoard(tenantDb, {
      role: "director",
      userId: "director-1",
      activeOfficeId: "office-1",
      scope: "team",
    });

    expect(result.columns[0]).toMatchObject({
      stage: { slug: "contacted" },
      count: 2,
    });
    expect(result.defaultConversionDealStageId).toBe("deal-stage-1");
  });

  it("scopes board queries to the active office even for admin all scope", async () => {
    dbState.responses = [
      [{ id: "stage-contacted", slug: "contacted", name: "Contacted", displayOrder: 1, isTerminal: false }],
      [{ id: "deal-stage-1" }],
    ];

    const tenantDb = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as any;

    const { listLeadBoard } = await import("../../../src/modules/leads/service.js");
    await listLeadBoard(tenantDb, {
      role: "admin",
      userId: "admin-1",
      activeOfficeId: "office-1",
      scope: "all",
    });

    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(queryText).toContain("join users u on u.id = l.assigned_rep_id");
    expect(queryText).toContain("u.office_id =");
  });
});
