import { describe, expect, it, vi } from "vitest";
import { setDealContractSignedDate } from "../../../src/modules/deals/service.js";

interface FakeDealRow {
  id: string;
  contractSignedDate: string | null;
  updatedAt?: Date;
  [k: string]: unknown;
}

function makeTenantDb(initial: FakeDealRow | null) {
  const state = {
    deal: initial ? { ...initial } : null,
    auditInserts: [] as Array<Record<string, unknown>>,
    updateCalls: [] as Array<Record<string, unknown>>,
    commissionInserts: [] as Array<Record<string, unknown>>,
    commissionRows: [] as Array<{ id: string; dealId: string; repUserId: string }>,
    selectCalls: 0,
  };
  // The deal-id branch returns the deal row; user_commission_settings and
  // deal_signed_commissions branches return [] in this minimal fake (the
  // commission service then short-circuits as skipped_no_rate / no rep).
  // Service-level tests for full commission flow live in
  // commissions/calculate.test.ts where the fake supports those tables.
  const tenantDb: any = {
    _state: state,
    select() {
      state.selectCalls++;
      return {
        from(table: any) {
          const tableName = table?._?.name ?? "";
          return {
            where() {
              return {
                limit() {
                  if (tableName === "deal_signed_commissions") {
                    return Promise.resolve(
                      state.commissionRows.length > 0
                        ? [{ id: state.commissionRows[0]?.id }]
                        : []
                    );
                  }
                  if (tableName === "user_commission_settings") {
                    return Promise.resolve([]);
                  }
                  // deals (or default)
                  return Promise.resolve(state.deal ? [{ ...state.deal }] : []);
                },
                then(onfulfilled: (rows: unknown[]) => unknown) {
                  return Promise.resolve(state.deal ? [{ ...state.deal }] : []).then(
                    onfulfilled
                  );
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
              if (state.deal) {
                Object.assign(state.deal, values);
              }
              return {
                returning() {
                  return Promise.resolve(state.deal ? [{ ...state.deal }] : []);
                },
              };
            },
          };
        },
      };
    },
    insert(table: any) {
      const tableName = table?._?.name ?? "";
      return {
        values(value: Record<string, unknown>) {
          if (tableName === "deal_signed_commissions") {
            state.commissionInserts.push(value);
            const row = {
              id: `commission-${state.commissionInserts.length}`,
              dealId: String(value.dealId),
              repUserId: String(value.repUserId),
            };
            state.commissionRows.push(row);
            return {
              returning() {
                return Promise.resolve([row]);
              },
            };
          }
          state.auditInserts.push(value);
          return Promise.resolve();
        },
      };
    },
    transaction(callback: (tx: unknown) => unknown) {
      return callback(tenantDb);
    },
  };
  return tenantDb;
}

describe("setDealContractSignedDate", () => {
  it("writes the value and an audit row on null → date", async () => {
    const tenantDb = makeTenantDb({ id: "deal-1", contractSignedDate: null });
    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      "2026-09-15",
      "admin-1"
    );

    expect(updated?.contractSignedDate).toBe("2026-09-15");
    expect(tenantDb._state.updateCalls).toHaveLength(1);
    expect(tenantDb._state.updateCalls[0]?.contractSignedDate).toBe("2026-09-15");
    expect(tenantDb._state.auditInserts).toHaveLength(1);
    expect(tenantDb._state.auditInserts[0]).toMatchObject({
      tableName: "deals",
      recordId: "deal-1",
      action: "update",
      changedBy: "admin-1",
      changes: { contractSignedDate: { from: null, to: "2026-09-15" } },
    });
  });

  it("writes the value and an audit row on date → null (clear)", async () => {
    const tenantDb = makeTenantDb({ id: "deal-1", contractSignedDate: "2026-09-15" });
    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      null,
      "admin-1"
    );

    expect(updated?.contractSignedDate).toBeNull();
    expect(tenantDb._state.updateCalls[0]?.contractSignedDate).toBeNull();
    expect(tenantDb._state.auditInserts).toHaveLength(1);
    expect(tenantDb._state.auditInserts[0]?.changes).toEqual({
      contractSignedDate: { from: "2026-09-15", to: null },
    });
  });

  it("writes the value and an audit row on date → different date", async () => {
    const tenantDb = makeTenantDb({ id: "deal-1", contractSignedDate: "2026-09-15" });
    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      "2026-12-01",
      "director-1"
    );

    expect(updated?.contractSignedDate).toBe("2026-12-01");
    expect(tenantDb._state.auditInserts).toHaveLength(1);
    expect(tenantDb._state.auditInserts[0]?.changes).toEqual({
      contractSignedDate: { from: "2026-09-15", to: "2026-12-01" },
    });
  });

  it("is a no-op when the value matches the current value (no audit row)", async () => {
    const tenantDb = makeTenantDb({ id: "deal-1", contractSignedDate: "2026-09-15" });
    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      "2026-09-15",
      "admin-1"
    );

    expect(updated?.contractSignedDate).toBe("2026-09-15");
    expect(tenantDb._state.updateCalls).toHaveLength(0);
    expect(tenantDb._state.auditInserts).toHaveLength(0);
  });

  it("treats null → null as a no-op", async () => {
    const tenantDb = makeTenantDb({ id: "deal-1", contractSignedDate: null });
    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      null,
      "admin-1"
    );

    expect(updated?.contractSignedDate).toBeNull();
    expect(tenantDb._state.updateCalls).toHaveLength(0);
    expect(tenantDb._state.auditInserts).toHaveLength(0);
  });

  it("hook fires commission calculation on null → date transition", async () => {
    const tenantDb = makeTenantDb({ id: "deal-1", contractSignedDate: null });
    await setDealContractSignedDate(tenantDb as never, "deal-1", "2026-09-15", "admin-1");
    // Calls: 1 deal-load + (commission path: deal again, settings, dedup)
    // The exact count depends on the commission service's internal queries.
    // We assert >1 to prove the commission path was entered (would be
    // exactly 1 if the hook failed to fire).
    expect(tenantDb._state.selectCalls).toBeGreaterThan(1);
  });

  it("hook does NOT fire commission calculation on date → null (clear)", async () => {
    const tenantDb = makeTenantDb({ id: "deal-1", contractSignedDate: "2026-09-15" });
    await setDealContractSignedDate(tenantDb as never, "deal-1", null, "admin-1");
    // Only the initial deal-load should have happened. No commission path.
    expect(tenantDb._state.selectCalls).toBe(1);
  });

  it("hook does NOT fire commission calculation on date → different date (edit)", async () => {
    const tenantDb = makeTenantDb({ id: "deal-1", contractSignedDate: "2026-09-15" });
    await setDealContractSignedDate(tenantDb as never, "deal-1", "2026-12-01", "admin-1");
    expect(tenantDb._state.selectCalls).toBe(1);
  });

  it("returns null when the deal does not exist", async () => {
    const tenantDb = makeTenantDb(null);
    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "missing-deal",
      "2026-09-15",
      "admin-1"
    );

    expect(updated).toBeNull();
    expect(tenantDb._state.updateCalls).toHaveLength(0);
    expect(tenantDb._state.auditInserts).toHaveLength(0);
  });
});
