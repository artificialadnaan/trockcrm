import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(() => ({
      values: vi.fn(async () => ({})),
    })),
  },
  pool: {},
}));

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
  getActiveProjectTypes: vi.fn(async () => []),
  resolveActiveProjectTypeValue: vi.fn(async (value: string) => value),
}));

const { updateDeal } = await import("../../../src/modules/deals/service.js");

type FakeDealRow = {
  id: string;
  name: string;
  dealNumber: string;
  stageId: string;
  assignedRepId: string;
  primaryContactId: string | null;
  sourceLeadId: string | null;
  companyId: string | null;
  propertyId: string | null;
  workflowRoute: "normal" | "service";
  ddEstimate: string | null;
  bidEstimate: string | null;
  awardedAmount: string | null;
  description: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  projectTypeId: string | null;
  regionId: string | null;
  source: string | null;
  winProbability: number | null;
  expectedCloseDate: string | null;
  proposalStatus: string | null;
  proposalNotes: string | null;
  estimatingSubstage: string | null;
  isBidBoardOwned: boolean;
  isChangeOrder: boolean;
  bidBoardStageSlug: string | null;
  readOnlySyncedAt: Date | null;
  officeCode?: string | null;
  onHold: boolean;
  onHoldStartedAt: Date | null;
  onHoldAccumulatedSeconds: number;
};

function makeDealRow(overrides: Partial<FakeDealRow> = {}): FakeDealRow {
  return {
    id: "deal-1",
    name: "Palm Villas",
    dealNumber: "TR-2026-0001",
    stageId: "stage-estimating",
    assignedRepId: "rep-1",
    primaryContactId: null,
    sourceLeadId: "lead-1",
    companyId: "company-1",
    propertyId: "property-1",
    workflowRoute: "normal",
    ddEstimate: null,
    bidEstimate: "875000",
    awardedAmount: null,
    description: "Exterior refresh",
    propertyAddress: "123 Palm Way",
    propertyCity: "Dallas",
    propertyState: "TX",
    propertyZip: "75201",
    projectTypeId: null,
    regionId: null,
    source: "referral",
    winProbability: 50,
    expectedCloseDate: null,
    proposalStatus: "drafting",
    proposalNotes: null,
    estimatingSubstage: "building_estimate",
    isBidBoardOwned: false,
    isChangeOrder: false,
    bidBoardStageSlug: null,
    readOnlySyncedAt: null,
    officeCode: "dfw",
    onHold: false,
    onHoldStartedAt: null,
    onHoldAccumulatedSeconds: 0,
    ...overrides,
  };
}

function createTenantDb(initialDeal: FakeDealRow) {
  const state = {
    deal: { ...initialDeal },
    updateCalls: [] as Array<Record<string, unknown>>,
    queryLog: [] as string[],
  };

  let activeQuery = false;

  const startQuery = async <T>(label: string, result: T): Promise<T> => {
    if (activeQuery) {
      throw new Error(`Concurrent tenantDb query detected during ${label}`);
    }
    activeQuery = true;
    state.queryLog.push(`${label}:start`);
    await Promise.resolve();
    activeQuery = false;
    state.queryLog.push(`${label}:end`);
    return result;
  };

  const tenantDb: any = {
    _state: state,
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return {
                    for() {
                      return startQuery("select-for-update", [{ ...state.deal }]);
                    },
                    then(onfulfilled: (rows: FakeDealRow[]) => unknown) {
                      return startQuery("select", [{ ...state.deal }]).then(onfulfilled);
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
                  return startQuery("update", [{ ...state.deal }]);
                },
              };
            },
          };
        },
      };
    },
  };

  return tenantDb;
}

describe("updateDeal on hold foundation", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("rejects changing a change-order child's awarded amount via the normal deal edit (use the CO endpoint)", async () => {
    // A CO's amount is managed via the change-order endpoint (which also recomputes commission). Editing it
    // through the normal deal path would change the Won total without resyncing commission — block it.
    const tenantDb = createTenantDb(makeDealRow({ isChangeOrder: true, awardedAmount: "1000" }));
    await expect(
      updateDeal(tenantDb as never, "deal-1", { awardedAmount: "2000" }, "director", "director-1")
    ).rejects.toMatchObject({ statusCode: 409, code: "CHANGE_ORDER_FIELD_LOCKED" });
  });

  it("rejects putting a change-order child on hold via the normal deal edit (its value would zero out)", async () => {
    // on_hold zeroes a deal's effective Won value, which would silently drop the CO from reports.
    const tenantDb = createTenantDb(makeDealRow({ isChangeOrder: true, onHold: false }));
    await expect(
      updateDeal(tenantDb as never, "deal-1", { onHold: true }, "director", "director-1")
    ).rejects.toMatchObject({ statusCode: 409, code: "CHANGE_ORDER_FIELD_LOCKED" });
  });

  it("rejects reassigning a change-order child's rep via the normal deal edit (commission attribution stays put)", async () => {
    // Reassigning would move Won credit (assigned_rep_id) but leave the commission under the original rep.
    // A CO's rep is set at creation (inherited from the parent); it is not reassignable via the normal path.
    const tenantDb = createTenantDb(makeDealRow({ isChangeOrder: true, assignedRepId: "rep-1" }));
    await expect(
      updateDeal(tenantDb as never, "deal-1", { assignedRepId: "rep-2" }, "director", "director-1")
    ).rejects.toMatchObject({ statusCode: 409, code: "CHANGE_ORDER_FIELD_LOCKED" });
  });

  it("rejects changing a change-order child's workflow route via the normal deal edit (bucket integrity)", async () => {
    // workflowRoute drives the service/normal report buckets + filters; a CO inherits the parent's route.
    const tenantDb = createTenantDb(makeDealRow({ isChangeOrder: true, workflowRoute: "normal" }));
    await expect(
      updateDeal(tenantDb as never, "deal-1", { workflowRoute: "service" }, "director", "director-1")
    ).rejects.toMatchObject({ statusCode: 409, code: "CHANGE_ORDER_FIELD_LOCKED" });
  });

  it("does NOT block a safe field edit (name) on a change-order child — only amount/hold/rep/route are locked", async () => {
    // Full-deal treatment: non-report-affecting fields stay editable on a CO child.
    const tenantDb = createTenantDb(makeDealRow({ isChangeOrder: true }));
    await expect(
      updateDeal(tenantDb as never, "deal-1", { name: "Renamed CO" }, "director", "director-1")
    ).resolves.toBeDefined();
  });

  it("turning hold on sets the flag and started timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T15:30:00.000Z"));
    const tenantDb = createTenantDb(makeDealRow());

    const updated = await updateDeal(
      tenantDb as never,
      "deal-1",
      { onHold: true },
      "director",
      "director-1"
    );

    expect(updated.onHold).toBe(true);
    expect(updated.onHoldStartedAt).toEqual(new Date("2026-05-21T15:30:00.000Z"));
    expect(updated.onHoldAccumulatedSeconds).toBe(0);
    expect(tenantDb._state.updateCalls[0]).toMatchObject({
      onHold: true,
      onHoldStartedAt: new Date("2026-05-21T15:30:00.000Z"),
    });
  });

  it("turning hold off accumulates the elapsed hold time and clears startedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T18:00:00.000Z"));
    const tenantDb = createTenantDb(
      makeDealRow({
        onHold: true,
        onHoldStartedAt: new Date("2026-05-21T15:30:00.000Z"),
        onHoldAccumulatedSeconds: 3600,
      })
    );

    const updated = await updateDeal(
      tenantDb as never,
      "deal-1",
      { onHold: false },
      "director",
      "director-1"
    );

    expect(updated.onHold).toBe(false);
    expect(updated.onHoldStartedAt).toBeNull();
    expect(updated.onHoldAccumulatedSeconds).toBe(3600 + 9000);
    expect(tenantDb._state.updateCalls[0]).toMatchObject({
      onHold: false,
      onHoldStartedAt: null,
      onHoldAccumulatedSeconds: 12600,
    });
  });

  it("keeps tenantDb operations sequential while applying the toggle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T18:00:00.000Z"));
    const tenantDb = createTenantDb(
      makeDealRow({
        onHold: true,
        onHoldStartedAt: new Date("2026-05-21T15:30:00.000Z"),
      })
    );

    await expect(
      updateDeal(
        tenantDb as never,
        "deal-1",
        { onHold: false },
        "director",
        "director-1"
      )
    ).resolves.toMatchObject({
      onHold: false,
      onHoldAccumulatedSeconds: 9000,
    });

    expect(tenantDb._state.queryLog).toEqual([
      "select-for-update:start",
      "select-for-update:end",
      "update:start",
      "update:end",
    ]);
  });

  it("preserves hold columns on in-stage updates that do not toggle hold", async () => {
    const tenantDb = createTenantDb(
      makeDealRow({
        onHold: true,
        onHoldStartedAt: new Date("2026-05-21T15:30:00.000Z"),
        onHoldAccumulatedSeconds: 3600,
      })
    );

    const updated = await updateDeal(
      tenantDb as never,
      "deal-1",
      { description: "Updated without touching hold" },
      "director",
      "director-1"
    );

    expect(updated.onHold).toBe(true);
    expect(updated.onHoldStartedAt).toEqual(new Date("2026-05-21T15:30:00.000Z"));
    expect(updated.onHoldAccumulatedSeconds).toBe(3600);
    expect(tenantDb._state.updateCalls[0]).toMatchObject({
      description: "Updated without touching hold",
    });
    expect(tenantDb._state.updateCalls[0]).not.toHaveProperty("onHold");
    expect(tenantDb._state.updateCalls[0]).not.toHaveProperty("onHoldStartedAt");
    expect(tenantDb._state.updateCalls[0]).not.toHaveProperty("onHoldAccumulatedSeconds");
  });
});
