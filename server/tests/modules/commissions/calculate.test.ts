import { describe, expect, it } from "vitest";
import { calculateCommissionForDeal } from "../../../src/modules/commissions/service.js";

interface FakeDealRow {
  id: string;
  assignedRepId: string | null;
  awardedAmount: string | null;
  bidEstimate: string | null;
  ddEstimate: string | null;
}

interface FakeRepSettings {
  commissionRate: string;
  isActive: boolean;
}

interface FakeSetup {
  deal: FakeDealRow | null;
  settings?: FakeRepSettings;
}

function makeTenantDb(setup: FakeSetup) {
  // The service makes selects in a deterministic order:
  //   1. deals     2. user_commission_settings    3. deal_signed_commissions (dedup)
  // We queue responses per-call rather than route by table name (Drizzle
  // pgTable internals aren't stable enough to introspect reliably).
  const state = {
    selectQueue: [] as unknown[][],
    commissionRows: [] as Array<Record<string, unknown> & { id: string }>,
    commissionInserts: [] as Array<Record<string, unknown>>,
    auditInserts: [] as Array<Record<string, unknown>>,
  };

  function pushSelectResponses() {
    state.selectQueue.push(setup.deal ? [{ ...setup.deal }] : []);
    state.selectQueue.push(setup.settings ? [{ ...setup.settings }] : []);
    state.selectQueue.push(state.commissionRows.map((r) => ({ id: r.id })));
  }

  pushSelectResponses();

  const tenantDb: any = {
    _state: state,
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  const next = state.selectQueue.shift() ?? [];
                  return Promise.resolve(next);
                },
              };
            },
          };
        },
      };
    },
    insert(table: any) {
      // Determine table by checking what was inserted. The commission
      // service inserts into deal_signed_commissions first, then
      // audit_log. We track on call order: 1st insert = commission, 2nd
      // = audit. State counters reset per fresh call site.
      let isCommissionInsertNext = state.commissionInserts.length === state.auditInserts.length;
      return {
        values(value: Record<string, unknown>) {
          if (isCommissionInsertNext && "appliedRate" in value) {
            state.commissionInserts.push(value);
            const row = { id: `commission-${state.commissionInserts.length}`, ...value };
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
    transaction(cb: (tx: unknown) => unknown) {
      // For the idempotency test we re-queue selects so a second
      // calculateCommissionForDeal call sees fresh deal+settings rows
      // plus the now-populated commissionRows for the dedup branch.
      pushSelectResponses();
      return cb(tenantDb);
    },
  };

  return tenantDb;
}

describe("calculateCommissionForDeal", () => {
  it("creates a commission row for a deal with rep + rate + awardedAmount (manual calc check)", async () => {
    const tenantDb = makeTenantDb({
      deal: {
        id: "deal-1",
        assignedRepId: "rep-1",
        awardedAmount: "100000.00",
        bidEstimate: "95000.00",
        ddEstimate: "90000.00",
      },
      settings: { commissionRate: "0.075000", isActive: true },
    });

    const result = await calculateCommissionForDeal(tenantDb as never, {
      dealId: "deal-1",
      contractSignedDate: "2026-09-15",
      triggeredByUserId: "admin-1",
    });

    // Manual calc verification — printed in test name comment so a
    // reviewer eyeballing the expected/actual sees the math:
    //   100000.00 (awarded_amount, preferred over bid/dd estimates)
    //   × 0.075 (rep commission_rate)
    //   = 7500.00
    expect(result.status).toBe("created");
    expect(result.amount).toBe("7500.00");
    expect(result.appliedRate).toBe("0.075000");
    expect(result.sourceValueAmount).toBe("100000.00");
    expect(result.sourceValueKind).toBe("awarded_amount");

    expect(tenantDb._state.commissionInserts).toHaveLength(1);
    expect(tenantDb._state.commissionInserts[0]).toMatchObject({
      dealId: "deal-1",
      repUserId: "rep-1",
      sourceValueKind: "awarded_amount",
      sourceValueAmount: "100000.00",
      appliedRate: "0.075000",
      amount: "7500.00",
      contractSignedDateAtSigning: "2026-09-15",
      createdBy: "admin-1",
    });

    expect(tenantDb._state.auditInserts).toHaveLength(1);
    expect(tenantDb._state.auditInserts[0]).toMatchObject({
      tableName: "deal_signed_commissions",
      action: "insert",
      changedBy: "admin-1",
    });
  });

  it("idempotency: firing twice for same (deal, rep) produces exactly one commission row", async () => {
    const dealRow = {
      id: "deal-1",
      assignedRepId: "rep-1",
      awardedAmount: "100000.00",
      bidEstimate: null,
      ddEstimate: null,
    };
    const settings = { commissionRate: "0.050000", isActive: true };
    const tenantDb = makeTenantDb({ deal: dealRow, settings });

    const first = await calculateCommissionForDeal(tenantDb as never, {
      dealId: "deal-1",
      contractSignedDate: "2026-09-15",
      triggeredByUserId: "admin-1",
    });

    // Re-queue selects for the second call (the test-fake auto-queues
    // only inside .transaction(), but calculateCommissionForDeal can be
    // invoked directly outside of one too — that's the canonical
    // production caller pattern from setDealContractSignedDate).
    tenantDb._state.selectQueue.push([{ ...dealRow }]);
    tenantDb._state.selectQueue.push([{ ...settings }]);
    tenantDb._state.selectQueue.push(
      tenantDb._state.commissionRows.map((r: { id: string }) => ({ id: r.id }))
    );

    const second = await calculateCommissionForDeal(tenantDb as never, {
      dealId: "deal-1",
      contractSignedDate: "2026-09-15",
      triggeredByUserId: "admin-1",
    });

    expect(first.status).toBe("created");
    expect(second.status).toBe("skipped_existing");
    expect(tenantDb._state.commissionInserts).toHaveLength(1);
    expect(tenantDb._state.commissionRows).toHaveLength(1);
  });

  it("skips with skipped_no_rep when deal has no assignedRepId", async () => {
    const tenantDb = makeTenantDb({
      deal: {
        id: "deal-1",
        assignedRepId: null,
        awardedAmount: "100000.00",
        bidEstimate: null,
        ddEstimate: null,
      },
      settings: { commissionRate: "0.075000", isActive: true },
    });

    const result = await calculateCommissionForDeal(tenantDb as never, {
      dealId: "deal-1",
      contractSignedDate: "2026-09-15",
      triggeredByUserId: "admin-1",
    });

    expect(result.status).toBe("skipped_no_rep");
    expect(tenantDb._state.commissionInserts).toHaveLength(0);
  });

  it("skips with skipped_no_rate when rep has no commission settings", async () => {
    const tenantDb = makeTenantDb({
      deal: {
        id: "deal-1",
        assignedRepId: "rep-1",
        awardedAmount: "100000.00",
        bidEstimate: null,
        ddEstimate: null,
      },
      // settings omitted entirely
    });

    const result = await calculateCommissionForDeal(tenantDb as never, {
      dealId: "deal-1",
      contractSignedDate: "2026-09-15",
      triggeredByUserId: "admin-1",
    });

    expect(result.status).toBe("skipped_no_rate");
    expect(tenantDb._state.commissionInserts).toHaveLength(0);
  });

  it("skips with skipped_no_rate when commission_rate is zero", async () => {
    const tenantDb = makeTenantDb({
      deal: {
        id: "deal-1",
        assignedRepId: "rep-1",
        awardedAmount: "100000.00",
        bidEstimate: null,
        ddEstimate: null,
      },
      settings: { commissionRate: "0.000000", isActive: true },
    });

    const result = await calculateCommissionForDeal(tenantDb as never, {
      dealId: "deal-1",
      contractSignedDate: "2026-09-15",
      triggeredByUserId: "admin-1",
    });

    expect(result.status).toBe("skipped_no_rate");
  });

  it("skips with skipped_no_rate when settings.isActive is false", async () => {
    const tenantDb = makeTenantDb({
      deal: {
        id: "deal-1",
        assignedRepId: "rep-1",
        awardedAmount: "100000.00",
        bidEstimate: null,
        ddEstimate: null,
      },
      settings: { commissionRate: "0.075000", isActive: false },
    });

    const result = await calculateCommissionForDeal(tenantDb as never, {
      dealId: "deal-1",
      contractSignedDate: "2026-09-15",
      triggeredByUserId: "admin-1",
    });

    expect(result.status).toBe("skipped_no_rate");
  });

  it("skips with skipped_no_value when all three value fields are null", async () => {
    const tenantDb = makeTenantDb({
      deal: {
        id: "deal-1",
        assignedRepId: "rep-1",
        awardedAmount: null,
        bidEstimate: null,
        ddEstimate: null,
      },
      settings: { commissionRate: "0.075000", isActive: true },
    });

    const result = await calculateCommissionForDeal(tenantDb as never, {
      dealId: "deal-1",
      contractSignedDate: "2026-09-15",
      triggeredByUserId: "admin-1",
    });

    expect(result.status).toBe("skipped_no_value");
    expect(tenantDb._state.commissionInserts).toHaveLength(0);
  });

  it("source value preference: awardedAmount > bidEstimate > ddEstimate", async () => {
    // awardedAmount missing, bidEstimate present → uses bidEstimate
    const tenantDb1 = makeTenantDb({
      deal: {
        id: "deal-1",
        assignedRepId: "rep-1",
        awardedAmount: null,
        bidEstimate: "80000.00",
        ddEstimate: "70000.00",
      },
      settings: { commissionRate: "0.050000", isActive: true },
    });
    const r1 = await calculateCommissionForDeal(tenantDb1 as never, {
      dealId: "deal-1",
      contractSignedDate: "2026-09-15",
      triggeredByUserId: "admin-1",
    });
    expect(r1.sourceValueKind).toBe("bid_estimate");
    expect(r1.sourceValueAmount).toBe("80000.00");
    expect(r1.amount).toBe("4000.00"); // 80000 × 0.05 = 4000

    // awardedAmount + bidEstimate both missing, ddEstimate present
    const tenantDb2 = makeTenantDb({
      deal: {
        id: "deal-1",
        assignedRepId: "rep-1",
        awardedAmount: null,
        bidEstimate: null,
        ddEstimate: "70000.00",
      },
      settings: { commissionRate: "0.030000", isActive: true },
    });
    const r2 = await calculateCommissionForDeal(tenantDb2 as never, {
      dealId: "deal-1",
      contractSignedDate: "2026-09-15",
      triggeredByUserId: "admin-1",
    });
    expect(r2.sourceValueKind).toBe("dd_estimate");
    expect(r2.sourceValueAmount).toBe("70000.00");
    expect(r2.amount).toBe("2100.00"); // 70000 × 0.03 = 2100
  });
});
