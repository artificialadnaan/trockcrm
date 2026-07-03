import { beforeEach, describe, expect, it, vi } from "vitest";

// Finding I: clearSalesSource is called from ownership-sync paths that do NOT hold the deal row lock, so a
// concurrent admin/director source change can land between clearSalesSource's read and its UPDATE. The
// null-out is scoped to `sales_source_user_id = oldSourceId` so a concurrent change makes it a no-op instead
// of clobbering the new source to null while removing only the OLD source's commission row (orphaning the
// newly-minted row behind a null column).
//
// This uses a controllable mock tenantDb so the guarded clear UPDATE can be forced to match 0 rows (the
// race). Commission helpers are mocked so we assert clearSalesSource's control flow, not commission math.
vi.mock("../../../src/modules/commissions/service.js", () => ({
  calculateCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  mintEstimatorCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  mintSalesSourceCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  recalculateCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  removeCommissionForDeal: vi.fn().mockResolvedValue(0),
  removeEstimatorCommissionForDeal: vi.fn().mockResolvedValue(1),
  removeSalesSourceCommissionForDeal: vi.fn().mockResolvedValue(1),
}));

const commissions = await import("../../../src/modules/commissions/service.js");
import { clearSalesSource } from "../../../src/modules/deals/service.js";

const OLD_SOURCE = "old-source-1";

/**
 * Mock tenantDb.
 * - currentSource: what the initial read sees for sales_source_user_id.
 * - clearResult: what the GUARDED clear UPDATE (`.where(...).returning()`) returns — `[]` simulates a
 *   concurrent source change (the `= oldSourceId` predicate matched nothing), `[{ id }]` a real clear.
 * The CO-propagation UPDATE awaits the same where() result directly (no `.returning()`).
 */
function makeTenantDb(currentSource: string | null, clearResult: Array<{ id: string }>) {
  const state = { audits: [] as Array<Record<string, unknown>>, updateWhereCalls: 0 };
  const tenantDb: any = {
    _state: state,
    select() {
      return {
        from() {
          return {
            where() {
              return { limit: () => Promise.resolve([{ salesSourceUserId: currentSource }]) };
            },
          };
        },
      };
    },
    update() {
      return {
        set() {
          return {
            where() {
              state.updateWhereCalls += 1;
              const resolved = Promise.resolve(undefined);
              return {
                returning: () => Promise.resolve(clearResult),
                then: (onf: (v: unknown) => unknown, onr?: (e: unknown) => unknown) =>
                  resolved.then(onf, onr),
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(value: Record<string, unknown>) {
          state.audits.push(value);
          return Promise.resolve();
        },
      };
    },
  };
  return tenantDb;
}

describe("clearSalesSource — concurrent-source-change guard (Finding I)", () => {
  beforeEach(() => {
    vi.mocked(commissions.removeSalesSourceCommissionForDeal).mockClear();
  });

  it("clears + removes the old source's row when the source is unchanged (guarded UPDATE matched)", async () => {
    const db = makeTenantDb(OLD_SOURCE, [{ id: "deal-1" }]);
    await clearSalesSource(db, "deal-1", "actor-1");

    expect(commissions.removeSalesSourceCommissionForDeal).toHaveBeenCalledOnce();
    expect(commissions.removeSalesSourceCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "deal-1", salesSourceUserId: OLD_SOURCE }),
    );
    expect(db._state.audits.length).toBeGreaterThan(0);
  });

  it("no-ops when a concurrent change replaced the source (guarded UPDATE matched 0 rows)", async () => {
    // The read still sees OLD_SOURCE, but the guarded UPDATE returns [] — a concurrent setDealSalesSource
    // changed the source (and minted its row) between the read and this write. We must leave the new source
    // intact: no OLD-source row removal, no misleading clear audit, and the CO-propagation UPDATE skipped.
    const db = makeTenantDb(OLD_SOURCE, []);
    await clearSalesSource(db, "deal-1", "actor-1");

    expect(commissions.removeSalesSourceCommissionForDeal).not.toHaveBeenCalled();
    expect(db._state.audits).toHaveLength(0);
    // Only the single guarded clear UPDATE ran; the CO-propagation UPDATE was skipped by the early return.
    expect(db._state.updateWhereCalls).toBe(1);
  });

  it("is a no-op before any UPDATE when the deal already has no source", async () => {
    const db = makeTenantDb(null, []);
    await clearSalesSource(db, "deal-1", "actor-1");
    expect(commissions.removeSalesSourceCommissionForDeal).not.toHaveBeenCalled();
    expect(db._state.updateWhereCalls).toBe(0);
  });
});
