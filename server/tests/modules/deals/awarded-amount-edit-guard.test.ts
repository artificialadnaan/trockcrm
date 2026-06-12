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
    // A genuine admin change marks the value as a permanent manual override.
    expect(result.awardedAmountOverridden).toBe(true);
  });

  it("does NOT mark overridden when an admin re-saves the SAME awarded amount (no-op)", async () => {
    const tenantDb = createUpdateDb({ ...baseExisting }); // stored "1000.00", not overridden

    const result = await updateDeal(
      tenantDb as never,
      "deal-1",
      { awardedAmount: "1000.00" }, // unchanged
      "admin",
      "admin-1",
      "office-1"
    );

    // touchesAwarded is false → the override flag is not set (sync stays unfrozen on a no-op save).
    expect(result.awardedAmountOverridden).not.toBe(true);
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

  it("does NOT block a rep when the awarded amount is numerically equal but differently formatted", async () => {
    const tenantDb = createUpdateDb({ ...baseExisting }); // stored "1000.00"

    // A non-UI API client (e.g. the mobile field app) sends "1000" — same money value, different
    // string form. Change-detection normalizes both to a number, so this is a no-op, not a 403.
    const result = await updateDeal(
      tenantDb as never,
      "deal-1",
      { awardedAmount: "1000" },
      "rep",
      "rep-1",
      "office-1"
    );

    // No 403, and the (numerically-equal) value the rep submitted is accepted.
    expect(tenantDb.update).toHaveBeenCalled();
    expect(result.awardedAmount).toBe("1000");
  });

  it("DOES block a rep sending a non-blank, non-numeric awarded amount on a blank-awarded deal", async () => {
    // A non-numeric value must NOT normalize to null (which would collide with the blank stored value
    // and skip the role check). It is a change attempt → AWARDED_AMOUNT_RESTRICTED for a rep.
    const tenantDb = createUpdateDb({ ...baseExisting, awardedAmount: null });

    await expect(
      updateDeal(
        tenantDb as never,
        "deal-1",
        { awardedAmount: "abc" },
        "rep",
        "rep-1",
        "office-1"
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "AWARDED_AMOUNT_RESTRICTED",
    });
    expect(tenantDb.update).not.toHaveBeenCalled();
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
    // An admin/director hand-setting awarded at creation is a manual override.
    expect(deal.awardedAmountOverridden).toBe(true);
  });

  it("allows a rep to create a deal with NO awarded amount", async () => {
    const { tenantDb } = createCreateDb();

    const deal = await createDeal(tenantDb as never, {
      ...baseCreateInput,
      actorRole: "rep",
    });

    expect(deal.id).toBe("deal-1");
    // No awarded set → not a manual override.
    expect(deal.awardedAmountOverridden).toBe(false);
  });
});
