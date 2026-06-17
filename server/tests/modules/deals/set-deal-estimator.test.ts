import { beforeEach, describe, expect, it, vi } from "vitest";

// Routing/transition test for setDealEstimator. The commission re-attribution helpers are mocked so we
// assert WHICH helper fires per transition (the money correctness of each helper is proven against the
// real schema in commissions/estimator-earned-commission.runtime.test.ts). Critically: setDealEstimator
// must use the ESTIMATOR-SCOPED removeEstimatorCommissionForDeal, never the all-rows removeCommissionForDeal.
vi.mock("../../../src/modules/commissions/service.js", () => ({
  mintEstimatorCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  removeEstimatorCommissionForDeal: vi.fn().mockResolvedValue(1),
  // Imported elsewhere in deals/service.ts — must exist on the mock so the module loads.
  calculateCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  recalculateCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  removeCommissionForDeal: vi.fn().mockResolvedValue(0),
}));

const commissions = await import("../../../src/modules/commissions/service.js");
import { setDealEstimator } from "../../../src/modules/deals/service.js";

interface FakeDeal {
  id: string;
  estimatorUserId: string | null;
  assignedRepId: string | null;
  isChangeOrder?: boolean;
  officeCode?: string | null;
  [k: string]: unknown;
}

function makeTenantDb(initial: FakeDeal) {
  const state = {
    deal: { isChangeOrder: false, officeCode: null as string | null, ...initial } as FakeDeal,
    updateCalls: [] as Array<Record<string, unknown>>,
    auditInserts: [] as Array<Record<string, unknown>>,
    lockedSelects: 0,
  };
  // validateDealReassignmentAssignee queries `users` (active target + current-owner office) — return a
  // canned active user in a single shared office so same-office validation always passes.
  const cannedUser = [{ id: "u", isActive: true, officeId: "o1", displayName: "U" }];
  const tenantDb: any = {
    _state: state,
    select() {
      return {
        from(table: any) {
          const name = table?._?.name ?? "";
          const rows = () =>
            name === "users"
              ? cannedUser
              : name === "offices"
                ? [{ id: "o1", slug: "dfw", name: "Dallas" }]
                : [{ ...state.deal }];
          return {
            where() {
              return {
                limit() {
                  const p = Promise.resolve(rows());
                  return {
                    for() {
                      state.lockedSelects += 1;
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
          state.updateCalls.push(values);
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
const A = "est-a";
const B = "est-b";

describe("setDealEstimator routing", () => {
  beforeEach(() => {
    vi.mocked(commissions.mintEstimatorCommissionForDeal).mockClear();
    vi.mocked(commissions.removeEstimatorCommissionForDeal).mockClear();
    vi.mocked(commissions.removeCommissionForDeal).mockClear();
  });

  it("rejects a change order with 409 CHANGE_ORDER_FIELD_LOCKED and touches no commission", async () => {
    const db = makeTenantDb({ id: "d", estimatorUserId: A, assignedRepId: OWNER, isChangeOrder: true });
    await expect(setDealEstimator(db, "d", B, OWNER)).rejects.toMatchObject({
      statusCode: 409,
      code: "CHANGE_ORDER_FIELD_LOCKED",
    });
    expect(db._state.updateCalls).toHaveLength(0);
    expect(commissions.mintEstimatorCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.removeEstimatorCommissionForDeal).not.toHaveBeenCalled();
  });

  it("no-op short-circuits when the estimator is unchanged (no update, no audit, no commission churn)", async () => {
    const db = makeTenantDb({ id: "d", estimatorUserId: A, assignedRepId: OWNER });
    const result = await setDealEstimator(db, "d", A, OWNER);
    expect(result).toBeTruthy();
    expect(db._state.updateCalls).toHaveLength(0);
    expect(db._state.auditInserts).toHaveLength(0);
    expect(commissions.mintEstimatorCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.removeEstimatorCommissionForDeal).not.toHaveBeenCalled();
  });

  it("null→B mints the estimator row only (no remove) and writes the estimator audit change", async () => {
    const db = makeTenantDb({ id: "d", estimatorUserId: null, assignedRepId: OWNER });
    await setDealEstimator(db, "d", B, OWNER);
    expect(db._state.updateCalls[0]?.estimatorUserId).toBe(B);
    expect(db._state.auditInserts[0]).toMatchObject({
      tableName: "deals",
      changes: { estimatorUserId: { from: null, to: B } },
    });
    expect(commissions.mintEstimatorCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", estimatorUserId: B }),
    );
    expect(commissions.removeEstimatorCommissionForDeal).not.toHaveBeenCalled();
  });

  it("A→B removes A then mints B — scoped, never the all-rows removeCommissionForDeal", async () => {
    const db = makeTenantDb({ id: "d", estimatorUserId: A, assignedRepId: OWNER });
    await setDealEstimator(db, "d", B, OWNER);
    expect(commissions.removeEstimatorCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", estimatorUserId: A, ownerUserId: OWNER }),
    );
    expect(commissions.mintEstimatorCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", estimatorUserId: B }),
    );
    expect(commissions.removeCommissionForDeal).not.toHaveBeenCalled();
  });

  it("B→null calls the scoped remove only (no mint, no all-rows remove)", async () => {
    const db = makeTenantDb({ id: "d", estimatorUserId: B, assignedRepId: OWNER });
    await setDealEstimator(db, "d", null, OWNER);
    expect(db._state.updateCalls[0]?.estimatorUserId).toBeNull();
    expect(commissions.removeEstimatorCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", estimatorUserId: B, ownerUserId: OWNER }),
    );
    expect(commissions.mintEstimatorCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.removeCommissionForDeal).not.toHaveBeenCalled();
  });

  it("owner→null does NOT call the scoped remove (oldEstimator === owner is filtered out)", async () => {
    const db = makeTenantDb({ id: "d", estimatorUserId: OWNER, assignedRepId: OWNER });
    await setDealEstimator(db, "d", null, OWNER);
    expect(commissions.removeEstimatorCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.mintEstimatorCommissionForDeal).not.toHaveBeenCalled();
  });
});
