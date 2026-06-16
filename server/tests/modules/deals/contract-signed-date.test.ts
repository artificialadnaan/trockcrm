import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageById: vi.fn(),
}));

// Mock the commission helpers so these tests assert ROUTING (which helper fires per contract-date
// transition) — the money correctness of each helper (attribution-preserving + all-or-nothing recompute)
// is proven against the real schema in commissions/commission-recalc-on-edit.runtime.test.ts.
vi.mock("../../../src/modules/commissions/service.js", () => ({
  calculateCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  recalculateCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  removeCommissionForDeal: vi.fn().mockResolvedValue(1),
}));

const pipelineService = await import("../../../src/modules/pipeline/service.js");
const commissions = await import("../../../src/modules/commissions/service.js");
import { setDealContractSignedDate } from "../../../src/modules/deals/service.js";

interface FakeDealRow {
  id: string;
  contractSignedDate: string | null;
  contractSignedAt?: Date | null;
  stageId?: string;
  workflowRoute?: "normal" | "service";
  dealNumber?: string;
  name?: string;
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
    jobInserts: [] as Array<Record<string, unknown>>,
    selectCalls: 0,
    lockedSelects: 0,
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
                  const rows =
                    tableName === "deal_signed_commissions"
                      ? state.commissionRows.length > 0
                        ? [{ id: state.commissionRows[0]?.id }]
                        : []
                      : tableName === "user_commission_settings"
                        ? []
                        : // deals (or default)
                          state.deal
                          ? [{ ...state.deal }]
                          : [];
                  const resultP = Promise.resolve(rows);
                  // `.for("update")` (row lock) is awaitable like a bare `.limit()`; track that the
                  // deal SELECT actually locked the row before classify+update.
                  return {
                    for() {
                      state.lockedSelects += 1;
                      return resultP;
                    },
                    then(onfulfilled: (value: unknown[]) => unknown) {
                      return resultP.then(onfulfilled);
                    },
                  };
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
          if (tableName === "job_queue" || value.jobType === "domain_event") {
            state.jobInserts.push(value);
            return Promise.resolve();
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
  beforeEach(() => {
    delete process.env.ENABLE_CONTRACT_SIGNED_HANDOFF;
    vi.mocked(commissions.calculateCommissionForDeal).mockClear();
    vi.mocked(commissions.recalculateCommissionForDeal).mockClear();
    vi.mocked(commissions.removeCommissionForDeal).mockClear();
    vi.mocked(pipelineService.getStageById).mockReset();
    vi.mocked(pipelineService.getStageById).mockResolvedValue({
      id: "stage-contract",
      slug: "contract",
      workflowFamily: "standard_deal",
      isTerminal: false,
      displayOrder: 5,
    } as never);
  });

  it("writes the value and an audit row on null → date", async () => {
    const tenantDb = makeTenantDb({ id: "deal-1", contractSignedDate: null, contractSignedAt: null });
    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      "2026-09-15",
      "admin-1",
      "office-1"
    );

    expect(updated?.contractSignedDate).toBe("2026-09-15");
    expect(updated?.contractSignedAt).toEqual(new Date("2026-09-15T00:00:00.000Z"));
    expect(tenantDb._state.updateCalls).toHaveLength(1);
    expect(tenantDb._state.updateCalls[0]?.contractSignedDate).toBe("2026-09-15");
    expect(tenantDb._state.updateCalls[0]?.contractSignedAt).toEqual(new Date("2026-09-15T00:00:00.000Z"));
    expect(tenantDb._state.auditInserts).toHaveLength(1);
    expect(tenantDb._state.auditInserts[0]).toMatchObject({
      tableName: "deals",
      recordId: "deal-1",
      action: "update",
      changedBy: "admin-1",
      changes: {
        contractSignedDate: { from: null, to: "2026-09-15" },
        contractSignedAt: { from: null, to: "2026-09-15T00:00:00.000Z" },
      },
    });
  });

  it("writes the value and an audit row on date → null (clear)", async () => {
    const tenantDb = makeTenantDb({
      id: "deal-1",
      contractSignedDate: "2026-09-15",
      contractSignedAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      null,
      "admin-1",
      "office-1"
    );

    expect(updated?.contractSignedDate).toBeNull();
    expect(updated?.contractSignedAt).toBeNull();
    expect(tenantDb._state.updateCalls[0]?.contractSignedDate).toBeNull();
    expect(tenantDb._state.updateCalls[0]?.contractSignedAt).toBeNull();
    expect(tenantDb._state.auditInserts).toHaveLength(1);
    expect(tenantDb._state.auditInserts[0]?.changes).toMatchObject({
      contractSignedDate: { from: "2026-09-15", to: null },
      contractSignedAt: { from: "2026-09-15T00:00:00.000Z", to: null },
    });
  });

  it("writes the value and an audit row on date → different date", async () => {
    const tenantDb = makeTenantDb({
      id: "deal-1",
      contractSignedDate: "2026-09-15",
      contractSignedAt: new Date("2026-09-15T00:00:00.000Z"),
    });
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
      contractSignedAt: {
        from: "2026-09-15T00:00:00.000Z",
        to: "2026-12-01T00:00:00.000Z",
      },
    });
  });

  it("is a no-op when the value matches the current value (no audit row)", async () => {
    const tenantDb = makeTenantDb({
      id: "deal-1",
      contractSignedDate: "2026-09-15",
      contractSignedAt: new Date("2026-09-15T00:00:00.000Z"),
    });
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

  it("routes null → date to calculate (initial sign)", async () => {
    const tenantDb = makeTenantDb({ id: "deal-1", contractSignedDate: null });
    await setDealContractSignedDate(tenantDb as never, "deal-1", "2026-09-15", "admin-1", "office-1");

    expect(commissions.calculateCommissionForDeal).toHaveBeenCalledTimes(1);
    expect(commissions.calculateCommissionForDeal).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ dealId: "deal-1", contractSignedDate: "2026-09-15", triggeredByUserId: "admin-1" })
    );
    expect(commissions.recalculateCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.removeCommissionForDeal).not.toHaveBeenCalled();
  });

  it("routes date → null (clear) to REMOVE — no signed date ⇒ no phantom payout", async () => {
    const tenantDb = makeTenantDb({
      id: "deal-1",
      contractSignedDate: "2026-09-15",
      contractSignedAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    await setDealContractSignedDate(tenantDb as never, "deal-1", null, "admin-1", "office-1");

    expect(commissions.removeCommissionForDeal).toHaveBeenCalledTimes(1);
    expect(commissions.removeCommissionForDeal).toHaveBeenCalledWith(tenantDb, "deal-1", "admin-1");
    expect(commissions.calculateCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.recalculateCommissionForDeal).not.toHaveBeenCalled();
  });

  it("routes date → different date (correction) to RECALCULATE (attribution-preserving, all-or-nothing)", async () => {
    const tenantDb = makeTenantDb({
      id: "deal-1",
      contractSignedDate: "2026-09-15",
      contractSignedAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    await setDealContractSignedDate(tenantDb as never, "deal-1", "2026-12-01", "admin-1", "office-1");

    expect(commissions.recalculateCommissionForDeal).toHaveBeenCalledTimes(1);
    expect(commissions.recalculateCommissionForDeal).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ dealId: "deal-1", contractSignedDate: "2026-12-01", triggeredByUserId: "admin-1" })
    );
    expect(commissions.removeCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.calculateCommissionForDeal).not.toHaveBeenCalled();
  });

  // Bug 3 (CodeRabbit): an _at-only signed row (contract_signed_at set, contract_signed_date null — the
  // reseed/import shape) must transition off the EFFECTIVE signed date, not contract_signed_date alone.
  it("CLEAR on an _at-only signed row (date null, _at set) still routes to REMOVE", async () => {
    const tenantDb = makeTenantDb({
      id: "deal-1",
      contractSignedDate: null, // date column never populated
      contractSignedAt: new Date("2026-09-15T00:00:00.000Z"), // but _at IS set (reseed shape)
    });
    // Clearing sets both to null. Keyed on the effective date, this is signed → cleared.
    await setDealContractSignedDate(tenantDb as never, "deal-1", null, "admin-1", "office-1");

    expect(commissions.removeCommissionForDeal).toHaveBeenCalledTimes(1);
    expect(commissions.calculateCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.recalculateCommissionForDeal).not.toHaveBeenCalled();
  });

  it("CORRECTION on an _at-only signed row routes to RECALCULATE (not a misrouted initial calc)", async () => {
    const tenantDb = makeTenantDb({
      id: "deal-1",
      contractSignedDate: null,
      contractSignedAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    await setDealContractSignedDate(tenantDb as never, "deal-1", "2026-12-01", "admin-1", "office-1");

    // Effective old = 2026-09-15 (from _at), new = 2026-12-01 → correction → recalc, NOT initial calc.
    expect(commissions.recalculateCommissionForDeal).toHaveBeenCalledTimes(1);
    expect(commissions.calculateCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.removeCommissionForDeal).not.toHaveBeenCalled();
  });

  it("emits deal.contract.signed once on contract_signed_at null → value when flag is on and deal is in Contract", async () => {
    process.env.ENABLE_CONTRACT_SIGNED_HANDOFF = "true";
    const tenantDb = makeTenantDb({
      id: "deal-1",
      name: "Contract Deal",
      dealNumber: "D-1001",
      stageId: "stage-contract",
      workflowRoute: "normal",
      contractSignedDate: null,
      contractSignedAt: null,
    });

    await setDealContractSignedDate(tenantDb as never, "deal-1", "2026-09-15", "director-1", "office-1");

    expect(tenantDb._state.jobInserts).toHaveLength(1);
    expect(tenantDb._state.jobInserts[0]).toMatchObject({
      jobType: "domain_event",
      officeId: "office-1",
      status: "pending",
      payload: expect.objectContaining({
        eventName: "deal.contract.signed",
        idempotencyKey: "deal:deal-1:contract_signed:2026-09-15T00:00:00.000Z",
        dealId: "deal-1",
        dealNumber: "D-1001",
        dealName: "Contract Deal",
        officeId: "office-1",
        workflowRoute: "normal",
        contractSignedAt: new Date("2026-09-15T00:00:00.000Z"),
        contractStageId: "stage-contract",
        signedBy: "director-1",
        source: "crm_contract_signed_date",
      }),
    });
  });

  it("treats legacy date-only signed rows as no-op when re-saving the same date", async () => {
    process.env.ENABLE_CONTRACT_SIGNED_HANDOFF = "true";
    vi.mocked(pipelineService.getStageById).mockResolvedValueOnce({
      id: "stage-estimating",
      slug: "estimating",
      workflowFamily: "standard_deal",
      isTerminal: false,
      displayOrder: 1,
    } as never);
    const tenantDb = makeTenantDb({
      id: "deal-1",
      stageId: "stage-estimating",
      workflowRoute: "normal",
      contractSignedDate: "2026-09-15",
      contractSignedAt: null,
    });

    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      "2026-09-15",
      "director-1",
      "office-1"
    );

    expect(updated?.contractSignedDate).toBe("2026-09-15");
    expect(tenantDb._state.updateCalls).toHaveLength(0);
    expect(tenantDb._state.jobInserts).toHaveLength(0);
    // The stage is now resolved up-front (for Won-family classification + stale-won reconciliation),
    // but a non-Won deal re-saving the same date is still a no-op — no won_closed_date write.
  });

  it("allows legacy date-only corrections outside Contract without emitting handoff", async () => {
    process.env.ENABLE_CONTRACT_SIGNED_HANDOFF = "true";
    vi.mocked(pipelineService.getStageById).mockResolvedValueOnce({
      id: "stage-estimating",
      slug: "estimating",
      workflowFamily: "standard_deal",
      isTerminal: false,
      displayOrder: 1,
    } as never);
    const tenantDb = makeTenantDb({
      id: "deal-1",
      stageId: "stage-estimating",
      workflowRoute: "normal",
      contractSignedDate: "2026-09-15",
      contractSignedAt: null,
    });

    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      "2026-12-01",
      "director-1",
      "office-1"
    );

    expect(updated?.contractSignedDate).toBe("2026-12-01");
    expect(updated?.contractSignedAt).toEqual(new Date("2026-12-01T00:00:00.000Z"));
    expect(tenantDb._state.updateCalls).toHaveLength(1);
    expect(tenantDb._state.jobInserts).toHaveLength(0);
    // The stage is now resolved on every change to decide Won-family write-through;
    // estimating is non-Won, so won_closed_date is left untouched.
    expect(tenantDb._state.updateCalls[0]).not.toHaveProperty("wonClosedDate");
  });

  it("allows setting contract_signed_at outside Contract (ungated); a non-Won deal keeps won_closed_date untouched and still emits the handoff", async () => {
    // UNGATE: the contract-signed date is now editable at ANY stage (accounting's
    // correction lever). A deal in estimating is NOT in the Won family, so the
    // write-through must NOT touch won_closed_date (no promotion). The deal is also
    // not already-Won, so the Procore handoff still fires on this initial sign.
    process.env.ENABLE_CONTRACT_SIGNED_HANDOFF = "true";
    vi.mocked(pipelineService.getStageById).mockResolvedValueOnce({
      id: "stage-estimating",
      slug: "estimating",
      workflowFamily: "standard_deal",
      isTerminal: false,
      displayOrder: 1,
    } as never);
    const tenantDb = makeTenantDb({
      id: "deal-1",
      stageId: "stage-estimating",
      workflowRoute: "normal",
      contractSignedDate: null,
      contractSignedAt: null,
    });

    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      "2026-09-15",
      "director-1",
      "office-1"
    );

    expect(updated?.contractSignedDate).toBe("2026-09-15");
    expect(tenantDb._state.updateCalls).toHaveLength(1);
    // No promotion: a non-Won deal's won_closed_date is never written.
    expect(tenantDb._state.updateCalls[0]).not.toHaveProperty("wonClosedDate");
    // Non-Won initial sign with the flag on → Procore create-project handoff still fires.
    expect(tenantDb._state.jobInserts).toHaveLength(1);
  });

  it("does not emit duplicate contract-signed jobs when re-saving the same contract_signed_at", async () => {
    process.env.ENABLE_CONTRACT_SIGNED_HANDOFF = "true";
    const tenantDb = makeTenantDb({
      id: "deal-1",
      stageId: "stage-contract",
      workflowRoute: "normal",
      contractSignedDate: "2026-09-15",
      contractSignedAt: new Date("2026-09-15T00:00:00.000Z"),
    });

    await setDealContractSignedDate(tenantDb as never, "deal-1", "2026-09-15", "director-1", "office-1");

    expect(tenantDb._state.updateCalls).toHaveLength(0);
    expect(tenantDb._state.jobInserts).toHaveLength(0);
  });

  it("allows contract_signed_at to be written with handoff flag off but queues no Procore handoff event", async () => {
    process.env.ENABLE_CONTRACT_SIGNED_HANDOFF = "false";
    const tenantDb = makeTenantDb({
      id: "deal-1",
      stageId: "stage-contract",
      workflowRoute: "normal",
      contractSignedDate: null,
      contractSignedAt: null,
    });

    await setDealContractSignedDate(tenantDb as never, "deal-1", "2026-09-15", "director-1", "office-1");

    expect(tenantDb._state.updateCalls).toHaveLength(1);
    expect(tenantDb._state.jobInserts).toHaveLength(0);
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

  it("writes won_closed_date through on a Won-family deal (contract-signed wins) and suppresses the Procore handoff when a project already exists", async () => {
    // Accounting-correction path: setting the contract-signed date on an ALREADY-WON deal
    // writes it through to the canonical won_closed_date (always-when-present), so every Won
    // report surface re-buckets to the corrected date. The Procore create-project handoff is
    // suppressed when the deal ALREADY has a Procore project (procoreProjectId set); commission
    // still fires.
    process.env.ENABLE_CONTRACT_SIGNED_HANDOFF = "true";
    vi.mocked(pipelineService.getStageById).mockResolvedValueOnce({
      id: "stage-won",
      slug: "won",
      workflowFamily: "standard_deal",
      isTerminal: true,
      displayOrder: 9,
    } as never);
    const tenantDb = makeTenantDb({
      id: "deal-1",
      stageId: "stage-won",
      workflowRoute: "normal",
      contractSignedDate: null,
      contractSignedAt: null,
      wonClosedDate: null,
      procoreProjectId: 990001, // already linked to a Procore project
      stageEnteredAt: new Date("2026-01-20T08:30:00.000Z"),
    });

    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      "2026-02-15",
      "director-1",
      "office-1"
    );

    expect(updated?.contractSignedDate).toBe("2026-02-15");
    expect(tenantDb._state.updateCalls).toHaveLength(1);
    expect(tenantDb._state.updateCalls[0]?.wonClosedDate).toBe("2026-02-15");
    // Existing Procore project → create-project handoff suppressed (the idempotent job would
    // no-op anyway), even though the flag is on and this is an initial sign.
    expect(tenantDb._state.jobInserts).toHaveLength(0);
  });

  it("fires the Procore create-project handoff for a Won deal with NO existing Procore project", async () => {
    // A Won deal that reached Won without a Procore project (procoreProjectId null) must still get
    // its only project-creation trigger on the first contract sign — suppression keys on actual
    // project linkage, not the Won stage alone.
    process.env.ENABLE_CONTRACT_SIGNED_HANDOFF = "true";
    vi.mocked(pipelineService.getStageById).mockResolvedValueOnce({
      id: "stage-won",
      slug: "won",
      workflowFamily: "standard_deal",
      isTerminal: true,
      displayOrder: 9,
    } as never);
    const tenantDb = makeTenantDb({
      id: "deal-1",
      stageId: "stage-won",
      workflowRoute: "normal",
      contractSignedDate: null,
      contractSignedAt: null,
      wonClosedDate: null,
      procoreProjectId: null, // no existing project
      stageEnteredAt: new Date("2026-01-20T08:30:00.000Z"),
    });

    await setDealContractSignedDate(tenantDb as never, "deal-1", "2026-02-15", "director-1", "office-1");

    // No existing project → the create-project handoff fires (still writes the won date through).
    expect(tenantDb._state.updateCalls[0]?.wonClosedDate).toBe("2026-02-15");
    expect(tenantDb._state.jobInserts).toHaveLength(1);
  });

  it("reverts won_closed_date to the stage-entry date when the contract date is cleared on a Won-family deal", async () => {
    vi.mocked(pipelineService.getStageById).mockResolvedValueOnce({
      id: "stage-won",
      slug: "won",
      workflowFamily: "standard_deal",
      isTerminal: true,
      displayOrder: 9,
    } as never);
    const tenantDb = makeTenantDb({
      id: "deal-1",
      stageId: "stage-won",
      workflowRoute: "normal",
      contractSignedDate: "2026-02-15",
      contractSignedAt: new Date("2026-02-15T00:00:00.000Z"),
      stageEnteredAt: new Date("2026-01-20T08:30:00.000Z"),
    });

    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      null,
      "director-1",
      "office-1"
    );

    expect(updated?.contractSignedDate).toBeNull();
    expect(tenantDb._state.updateCalls).toHaveLength(1);
    // Cleared → the stage-driven won date stands (stage_entered_at::date).
    expect(tenantDb._state.updateCalls[0]?.wonClosedDate).toBe("2026-01-20");
  });

  // Codex review #612 (R-tip):
  it("locks the deal row (FOR UPDATE) before classifying Won status", async () => {
    const tenantDb = makeTenantDb({ id: "deal-1", contractSignedDate: null, contractSignedAt: null });
    await setDealContractSignedDate(tenantDb as never, "deal-1", "2026-09-15", "admin-1", "office-1");
    // The deal SELECT must lock the row so a concurrent stage change can't make the Won
    // classification (and the won_closed_date write/omit) race against the final stage.
    expect(tenantDb._state.lockedSelects).toBeGreaterThanOrEqual(1);
  });

  it("reconciles a stale won_closed_date when the same contract date is re-saved on a Won-family deal", async () => {
    vi.mocked(pipelineService.getStageById).mockResolvedValueOnce({
      id: "stage-won",
      slug: "won",
      workflowFamily: "standard_deal",
      isTerminal: true,
      displayOrder: 9,
    } as never);
    const tenantDb = makeTenantDb({
      id: "deal-1",
      stageId: "stage-won",
      workflowRoute: "normal",
      contractSignedDate: "2026-02-15",
      contractSignedAt: new Date("2026-02-15T00:00:00.000Z"),
      wonClosedDate: "2026-05-01", // STALE — predates the write-through
      stageEnteredAt: new Date("2026-01-20T08:30:00.000Z"),
    });

    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      "2026-02-15",
      "director-1",
      "office-1"
    );

    // Same contract date re-saved, but the stored Won date was stale → NOT a no-op: reconcile it.
    expect(tenantDb._state.updateCalls).toHaveLength(1);
    expect(tenantDb._state.updateCalls[0]?.wonClosedDate).toBe("2026-02-15");
    expect(updated?.contractSignedDate).toBe("2026-02-15");
  });

  it("does NOT rewrite won_closed_date on a no-op for a Won-family deal that has no contract date", async () => {
    vi.mocked(pipelineService.getStageById).mockResolvedValueOnce({
      id: "stage-won",
      slug: "won",
      workflowFamily: "standard_deal",
      isTerminal: true,
      displayOrder: 9,
    } as never);
    const tenantDb = makeTenantDb({
      id: "deal-1",
      stageId: "stage-won",
      workflowRoute: "normal",
      contractSignedDate: null,
      contractSignedAt: null,
      wonClosedDate: "2026-05-01", // the real Won-entry stamp — must NOT be overwritten
      stageEnteredAt: new Date("2026-01-20T08:30:00.000Z"),
    });

    // Re-saving an already-null contract date is a true no-op; the stale-won reconciliation must
    // NOT fire (no contract date is the authoritative source), so won_closed_date is left intact —
    // it is NOT recomputed from stage_entered_at (which would corrupt the original Won stamp).
    await setDealContractSignedDate(tenantDb as never, "deal-1", null, "director-1", "office-1");

    expect(tenantDb._state.updateCalls).toHaveLength(0);
    expect(tenantDb._state.deal?.wonClosedDate).toBe("2026-05-01");
  });

  it("audits the won_closed_date change when the write-through re-buckets a Won-family deal", async () => {
    vi.mocked(pipelineService.getStageById).mockResolvedValueOnce({
      id: "stage-won",
      slug: "won",
      workflowFamily: "standard_deal",
      isTerminal: true,
      displayOrder: 9,
    } as never);
    const tenantDb = makeTenantDb({
      id: "deal-1",
      stageId: "stage-won",
      workflowRoute: "normal",
      contractSignedDate: null,
      contractSignedAt: null,
      wonClosedDate: "2026-05-01",
      stageEnteredAt: new Date("2026-01-20T08:30:00.000Z"),
    });

    await setDealContractSignedDate(tenantDb as never, "deal-1", "2026-02-15", "director-1", "office-1");

    expect(tenantDb._state.auditInserts).toHaveLength(1);
    expect(tenantDb._state.auditInserts[0]?.changes).toMatchObject({
      contractSignedDate: { from: null, to: "2026-02-15" },
      wonClosedDate: { from: "2026-05-01", to: "2026-02-15" },
    });
  });

  // PR #613 un-hides the Contract-Signed card for Bid-Board-owned deals, making this write path
  // reachable for them via the UI. The backend has no bid-board read-only guard here, so the #612
  // write-through must fire for a Bid-Board-owned Won deal exactly as for any other deal — this
  // guard locks that dependency in (catches a future bid-board guard regressing the new capability).
  it("writes won_closed_date through for a Bid-Board-OWNED Won-family deal (no bid-board guard blocks it)", async () => {
    vi.mocked(pipelineService.getStageById).mockResolvedValueOnce({
      id: "stage-won",
      slug: "won",
      workflowFamily: "standard_deal",
      isTerminal: true,
      displayOrder: 9,
    } as never);
    const tenantDb = makeTenantDb({
      id: "deal-1",
      stageId: "stage-won",
      workflowRoute: "normal",
      isBidBoardOwned: true,
      readOnlySyncedAt: new Date("2026-01-25T00:00:00.000Z"),
      procoreProjectId: 990001,
      contractSignedDate: null,
      contractSignedAt: null,
      wonClosedDate: "2026-05-01",
      stageEnteredAt: new Date("2026-01-20T08:30:00.000Z"),
    });

    const updated = await setDealContractSignedDate(
      tenantDb as never,
      "deal-1",
      "2026-02-15",
      "director-1",
      "office-1"
    );

    // Accepted (no BID_BOARD_OWNED_FIELD_READ_ONLY) and written through to won_closed_date.
    expect(updated?.contractSignedDate).toBe("2026-02-15");
    expect(tenantDb._state.updateCalls).toHaveLength(1);
    expect(tenantDb._state.updateCalls[0]?.wonClosedDate).toBe("2026-02-15");
  });
});
