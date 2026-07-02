import { beforeEach, describe, expect, it, vi } from "vitest";

// Runtime coverage for setDealSalesSource (mirror of set-deal-estimator.runtime.test.ts).
// Covers:
//   1. Setting a source mints its sales_source commission row.
//   2. Changing it removes the old source's row and mints the new source's.
//   3. Clearing (null) removes the row without minting.
//   4. Soft-deleted deal returns null — no mutation.
//   5. Change-order child throws 409 CHANGE_ORDER_FIELD_LOCKED.
//
// Commission helpers are mocked so we focus on setDealSalesSource correctness; money
// accuracy is covered by the commissions PGlite runtime tests.
vi.mock("../../../src/modules/commissions/service.js", () => ({
  mintEstimatorCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  mintSalesSourceCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  removeEstimatorCommissionForDeal: vi.fn().mockResolvedValue(1),
  removeSalesSourceCommissionForDeal: vi.fn().mockResolvedValue(1),
  // Other imports from deals/service.ts that need to exist on the mock.
  calculateCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  recalculateCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  removeCommissionForDeal: vi.fn().mockResolvedValue(0),
}));

const commissions = await import("../../../src/modules/commissions/service.js");
import { setDealSalesSource } from "../../../src/modules/deals/service.js";

interface FakeDeal {
  id: string;
  salesSourceUserId: string | null;
  assignedRepId: string | null;
  isActive?: boolean;
  isChangeOrder?: boolean;
  isBidBoardOwned?: boolean;
  officeCode?: string | null;
  [k: string]: unknown;
}

function makeTenantDb(initial: FakeDeal) {
  const state = {
    deal: {
      isChangeOrder: false,
      isBidBoardOwned: false,
      officeCode: null as string | null,
      isActive: true,
      ...initial,
    } as FakeDeal,
    updateCalls: [] as Array<Record<string, unknown>>,
    auditInserts: [] as Array<Record<string, unknown>>,
    lockedSelects: 0,
  };
  const cannedUser = [{ id: "u", isActive: true, officeId: "o1", displayName: "U" }];
  const tenantDb: any = {
    _state: state,
    select() {
      return {
        from(table: any) {
          const tableName: string = (table as any)[Symbol.for("drizzle:Name")] ?? table?._.name ?? "";
          const isDeals = tableName === "deals";
          const rows = () =>
            tableName === "users"
              ? cannedUser
              : tableName === "offices"
                ? [{ id: "o1", slug: "dfw", name: "Dallas" }]
                : state.deal.isActive === false
                  ? []
                  : [{ ...state.deal }];
          return {
            where(_condition: unknown) {
              return {
                limit() {
                  const p = Promise.resolve(rows());
                  return {
                    for() {
                      if (isDeals) state.lockedSelects += 1;
                      return p;
                    },
                    then(onf: (v: unknown[]) => unknown) {
                      return p.then(onf);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          state.updateCalls.push({ ...values });
          return {
            where() {
              Object.assign(state.deal, values);
              return {
                returning() {
                  return Promise.resolve([{ ...state.deal }]);
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(value: Record<string, unknown>) {
          state.auditInserts.push(value);
          return Promise.resolve();
        },
      };
    },
    transaction(cb: (tx: unknown) => unknown) {
      return cb(tenantDb);
    },
  };
  return tenantDb;
}

const OWNER = "owner-1";
const SRC_A = "source-a";
const SRC_B = "source-b";

describe("setDealSalesSource (runtime)", () => {
  beforeEach(() => {
    vi.mocked(commissions.mintSalesSourceCommissionForDeal).mockClear();
    vi.mocked(commissions.removeSalesSourceCommissionForDeal).mockClear();
    vi.mocked(commissions.mintEstimatorCommissionForDeal).mockClear();
    vi.mocked(commissions.removeEstimatorCommissionForDeal).mockClear();
    vi.mocked(commissions.removeCommissionForDeal).mockClear();
  });

  it("sets a sales source: mints the sales_source commission row, updates the deal", async () => {
    const db = makeTenantDb({ id: "d", salesSourceUserId: null, assignedRepId: OWNER });
    const result = await setDealSalesSource(db, "d", SRC_A, OWNER, "o1");
    expect(result).toBeTruthy();
    expect((result as FakeDeal).salesSourceUserId).toBe(SRC_A);
    // DB was updated
    expect(db._state.updateCalls[0]?.salesSourceUserId).toBe(SRC_A);
    // Mint fired with the new source
    expect(commissions.mintSalesSourceCommissionForDeal).toHaveBeenCalledOnce();
    expect(commissions.mintSalesSourceCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", salesSourceUserId: SRC_A }),
    );
    // Remove was NOT called (there was no old source)
    expect(commissions.removeSalesSourceCommissionForDeal).not.toHaveBeenCalled();
  });

  it("changes sales source: removes old source's row first, then mints new source's row", async () => {
    const db = makeTenantDb({ id: "d", salesSourceUserId: SRC_A, assignedRepId: OWNER });
    const result = await setDealSalesSource(db, "d", SRC_B, OWNER, "o1");
    expect(result).toBeTruthy();
    expect((result as FakeDeal).salesSourceUserId).toBe(SRC_B);
    // Remove fired for OLD source
    expect(commissions.removeSalesSourceCommissionForDeal).toHaveBeenCalledOnce();
    expect(commissions.removeSalesSourceCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", salesSourceUserId: SRC_A }),
    );
    // Mint fired for NEW source
    expect(commissions.mintSalesSourceCommissionForDeal).toHaveBeenCalledOnce();
    expect(commissions.mintSalesSourceCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", salesSourceUserId: SRC_B }),
    );
    // Re-attribution order: remove was called before mint
    const removedOrder = vi.mocked(commissions.removeSalesSourceCommissionForDeal).mock.invocationCallOrder[0]!;
    const mintOrder = vi.mocked(commissions.mintSalesSourceCommissionForDeal).mock.invocationCallOrder[0]!;
    expect(removedOrder).toBeLessThan(mintOrder);
  });

  it("clears sales source (null): removes old row, does not mint", async () => {
    const db = makeTenantDb({ id: "d", salesSourceUserId: SRC_A, assignedRepId: OWNER });
    const result = await setDealSalesSource(db, "d", null, OWNER, "o1");
    expect(result).toBeTruthy();
    expect((result as FakeDeal).salesSourceUserId).toBeNull();
    // Remove fired for OLD source
    expect(commissions.removeSalesSourceCommissionForDeal).toHaveBeenCalledOnce();
    expect(commissions.removeSalesSourceCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", salesSourceUserId: SRC_A }),
    );
    // Mint NOT called (no new source)
    expect(commissions.mintSalesSourceCommissionForDeal).not.toHaveBeenCalled();
  });

  it("no-op short-circuit: same source → returns existing deal, no commission mutation", async () => {
    const db = makeTenantDb({ id: "d", salesSourceUserId: SRC_A, assignedRepId: OWNER });
    const result = await setDealSalesSource(db, "d", SRC_A, OWNER, "o1");
    expect(result).toBeTruthy();
    expect(db._state.updateCalls).toHaveLength(0);
    expect(commissions.mintSalesSourceCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.removeSalesSourceCommissionForDeal).not.toHaveBeenCalled();
  });

  it("returns null for a soft-deleted (is_active=false) deal — no mutation", async () => {
    const db = makeTenantDb({ id: "d", salesSourceUserId: null, assignedRepId: OWNER, isActive: false });
    const result = await setDealSalesSource(db, "d", SRC_A, OWNER, "o1");
    expect(result).toBeNull();
    expect(db._state.lockedSelects).toBe(1);
    expect(db._state.updateCalls).toHaveLength(0);
    expect(commissions.mintSalesSourceCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.removeSalesSourceCommissionForDeal).not.toHaveBeenCalled();
  });

  it("throws 409 CHANGE_ORDER_FIELD_LOCKED for a change-order deal", async () => {
    const db = makeTenantDb({ id: "d", salesSourceUserId: null, assignedRepId: OWNER, isChangeOrder: true });
    await expect(setDealSalesSource(db, "d", SRC_A, OWNER, "o1")).rejects.toMatchObject({
      statusCode: 409,
      code: "CHANGE_ORDER_FIELD_LOCKED",
    });
    expect(db._state.updateCalls).toHaveLength(0);
    expect(commissions.mintSalesSourceCommissionForDeal).not.toHaveBeenCalled();
  });

  it("throws 422 SALES_SOURCE_CONFLICT when new source equals the assigned rep", async () => {
    // Setting the deal owner as the sales source would grant a double commission cut
    // (owner row + additive source row). The service must reject this at the data layer.
    const db = makeTenantDb({ id: "d", salesSourceUserId: null, assignedRepId: OWNER });
    await expect(setDealSalesSource(db, "d", OWNER, OWNER, "o1")).rejects.toMatchObject({
      statusCode: 422,
      code: "SALES_SOURCE_CONFLICT",
    });
    expect(db._state.updateCalls).toHaveLength(0);
    expect(commissions.mintSalesSourceCommissionForDeal).not.toHaveBeenCalled();
  });
});
