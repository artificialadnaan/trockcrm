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
  };
  return {
    _state: state,
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve(state.deal ? [{ ...state.deal }] : []);
                },
                then(onfulfilled: (rows: unknown[]) => unknown) {
                  return Promise.resolve(state.deal ? [{ ...state.deal }] : []).then(onfulfilled);
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
    insert(_table: unknown) {
      return {
        values(value: Record<string, unknown>) {
          state.auditInserts.push(value);
          return Promise.resolve();
        },
      };
    },
  };
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
