import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageById: vi.fn(),
}));

const pipelineService = await import("../../../src/modules/pipeline/service.js");
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

  it("hook fires commission calculation on null → date transition", async () => {
    const tenantDb = makeTenantDb({ id: "deal-1", contractSignedDate: null });
    await setDealContractSignedDate(tenantDb as never, "deal-1", "2026-09-15", "admin-1", "office-1");
    // Calls: 1 deal-load + (commission path: deal again, settings, dedup)
    // The exact count depends on the commission service's internal queries.
    // We assert >1 to prove the commission path was entered (would be
    // exactly 1 if the hook failed to fire).
    expect(tenantDb._state.selectCalls).toBeGreaterThan(1);
  });

  it("hook does NOT fire commission calculation on date → null (clear)", async () => {
    const tenantDb = makeTenantDb({
      id: "deal-1",
      contractSignedDate: "2026-09-15",
      contractSignedAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    await setDealContractSignedDate(tenantDb as never, "deal-1", null, "admin-1", "office-1");
    // Only the initial deal-load should have happened. No commission path.
    expect(tenantDb._state.selectCalls).toBe(1);
  });

  it("hook does NOT fire commission calculation on date → different date (edit)", async () => {
    const tenantDb = makeTenantDb({
      id: "deal-1",
      contractSignedDate: "2026-09-15",
      contractSignedAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    await setDealContractSignedDate(tenantDb as never, "deal-1", "2026-12-01", "admin-1", "office-1");
    expect(tenantDb._state.selectCalls).toBe(1);
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
    expect(pipelineService.getStageById).not.toHaveBeenCalled();
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
    expect(pipelineService.getStageById).not.toHaveBeenCalled();
  });

  it("rejects setting contract_signed_at when the deal is not in Contract", async () => {
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

    await expect(
      setDealContractSignedDate(tenantDb as never, "deal-1", "2026-09-15", "director-1", "office-1")
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "CONTRACT_SIGNED_STAGE_REQUIRED",
    });
    expect(tenantDb._state.updateCalls).toHaveLength(0);
    expect(tenantDb._state.jobInserts).toHaveLength(0);
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
});
