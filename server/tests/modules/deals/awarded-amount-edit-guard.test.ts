import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => {
  const mockSelect = vi.fn();
  const mockInsert = vi.fn(() => ({ values: vi.fn(async () => ({})) }));
  return { db: { select: mockSelect, insert: mockInsert }, pool: {} };
});

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageById: vi.fn(async () => ({
    id: "stage-opportunity",
    slug: "opportunity",
    isTerminal: false,
    displayOrder: 1,
    workflowFamily: "standard_deal",
  })),
  getStageBySlug: vi.fn(async () => ({
    id: "stage-opportunity",
    slug: "opportunity",
    isTerminal: false,
    displayOrder: 1,
    workflowFamily: "standard_deal",
  })),
  getActiveProjectTypes: vi.fn(async () => [
    { id: "type-3", name: "Roofing", slug: "roofing", code: "3" },
  ]),
  resolveActiveProjectTypeValue: vi.fn(async (value: string) =>
    value.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " "),
  ),
}));

vi.mock("../../../src/modules/assignment-tasks/service.js", () => ({
  createAssignmentTaskIfNeeded: vi.fn(),
}));
vi.mock("../../../src/modules/audit/audit-logger.js", () => ({
  logActivity: vi.fn(),
}));

const { createDeal, updateDeal } = await import("../../../src/modules/deals/service.js");

// --- updateDeal harness -------------------------------------------------------
// Minimal tenantDb double: the locked-row SELECT resolves the existing deal, and
// the UPDATE chain echoes the merged row so the function can return cleanly.
function createUpdateDb(existing: Record<string, unknown>) {
  const updatedRows: Record<string, unknown>[] = [];

  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve([existing]).then(resolve),
        limit: vi.fn(async () => [existing]),
      })),
    })),
  }));

  const update = vi.fn(() => ({
    set: vi.fn((updates: Record<string, unknown>) => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => {
          const merged = { ...existing, ...updates };
          updatedRows.push(merged);
          return [merged];
        }),
      })),
    })),
  }));

  const insert = vi.fn(() => ({
    values: vi.fn(async () => []),
  }));

  return { select, update, insert, updatedRows };
}

const baseExisting = {
  id: "deal-1",
  name: "Awarded Guard Deal",
  assignedRepId: "rep-1",
  sourceLeadId: null,
  companyId: "company-1",
  propertyId: "property-1",
  primaryContactId: null,
  stageId: "stage-won",
  workflowRoute: "normal",
  officeCode: "dfw",
  isChangeOrder: false,
  isBidBoardOwned: false,
  onHold: false,
  awardedAmount: "1000.00",
  createdAt: new Date("2026-04-01T00:00:00.000Z"),
  updatedAt: new Date("2026-04-20T00:00:00.000Z"),
};

describe("awarded_amount edit authorization (updateDeal)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks a rep from CHANGING the awarded amount", async () => {
    const tenantDb = createUpdateDb({ ...baseExisting });

    await expect(
      updateDeal(
        tenantDb as never,
        "deal-1",
        { awardedAmount: "5000.00" },
        "rep",
        "rep-1", // owns the deal, so the own-deal gate passes
        "office-1"
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "AWARDED_AMOUNT_RESTRICTED",
    });
    expect(tenantDb.update).not.toHaveBeenCalled();
  });

  it("allows an admin to change the awarded amount", async () => {
    const tenantDb = createUpdateDb({ ...baseExisting });

    const result = await updateDeal(
      tenantDb as never,
      "deal-1",
      { awardedAmount: "5000.00" },
      "admin",
      "admin-1",
      "office-1"
    );

    expect(tenantDb.update).toHaveBeenCalled();
    expect(result.awardedAmount).toBe("5000.00");
  });

  it("allows a director to change the awarded amount", async () => {
    const tenantDb = createUpdateDb({ ...baseExisting });

    const result = await updateDeal(
      tenantDb as never,
      "deal-1",
      { awardedAmount: "5000.00" },
      "director",
      "director-1",
      "office-1"
    );

    expect(tenantDb.update).toHaveBeenCalled();
    expect(result.awardedAmount).toBe("5000.00");
  });

  it("does NOT block a rep re-submitting the SAME awarded amount (partial-save safety)", async () => {
    const tenantDb = createUpdateDb({ ...baseExisting });

    const result = await updateDeal(
      tenantDb as never,
      "deal-1",
      { awardedAmount: "1000.00" }, // unchanged
      "rep",
      "rep-1",
      "office-1"
    );

    expect(result.awardedAmount).toBe("1000.00");
  });
});

// --- createDeal harness -------------------------------------------------------
// Mirrors the minimal double used by the deal-number tests in service.test.ts.
function createCreateDb() {
  const state = { insertedDeal: null as Record<string, unknown> | null, executeCalls: 0 };
  const tenantDb = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve([{ id: "rep-1", isActive: true, officeId: "office-1" }]);
                },
              };
            },
          };
        },
      };
    },
    execute() {
      state.executeCalls += 1;
      if (state.executeCalls === 1) return Promise.resolve({ rows: [{ deal_number: "dfw-3-11826-aa" }] });
      if (state.executeCalls === 3) return Promise.resolve({ rows: [{ last_suffix: "aa" }] });
      return Promise.resolve({ rows: [] });
    },
    insert() {
      return {
        values(values: Record<string, unknown>) {
          state.insertedDeal = { id: "deal-1", bidBoardProjectNumber: null, ...values };
          return {
            returning() {
              return Promise.resolve([state.insertedDeal]);
            },
          };
        },
      };
    },
  };
  return { tenantDb, state };
}

const baseCreateInput = {
  name: "Direct Deal",
  stageId: "stage-dd",
  assignedRepId: "rep-1",
  officeId: "office-1",
  migrationMode: true,
  officeCode: "dfw",
  projectType: "roofing",
};

describe("awarded_amount set authorization (createDeal)", () => {
  it("blocks a rep from creating a deal WITH a non-blank awarded amount", async () => {
    const { tenantDb } = createCreateDb();

    await expect(
      createDeal(tenantDb as never, {
        ...baseCreateInput,
        awardedAmount: "5000.00",
        actorRole: "rep",
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "AWARDED_AMOUNT_RESTRICTED",
    });
  });

  it("allows an admin to create a deal with an awarded amount", async () => {
    const { tenantDb } = createCreateDb();

    const deal = await createDeal(tenantDb as never, {
      ...baseCreateInput,
      awardedAmount: "5000.00",
      actorRole: "admin",
    });

    expect(deal.awardedAmount).toBe("5000.00");
  });

  it("allows a rep to create a deal with NO awarded amount", async () => {
    const { tenantDb } = createCreateDb();

    const deal = await createDeal(tenantDb as never, {
      ...baseCreateInput,
      actorRole: "rep",
    });

    expect(deal.id).toBe("deal-1");
  });
});
