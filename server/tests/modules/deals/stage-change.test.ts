import { describe, expect, it, vi, beforeEach } from "vitest";
import { auditLog, dealApprovals, deals, dealStageHistory, jobQueue, tasks } from "@trock-crm/shared/schema";

vi.mock("../../../src/modules/deals/stage-gate.js", () => ({
  validateStageGate: vi.fn(),
}));

vi.mock("../../../src/modules/deals/scoping-service.js", () => ({
  activateDealScopingIntake: vi.fn(),
  evaluateDealScopingReadiness: vi.fn(),
}));

vi.mock("../../../src/modules/deals/timer-service.js", () => ({
  createStageTimers: vi.fn(),
}));

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageBySlug: vi.fn(async () => ({
    id: "stage-estimating",
    name: "Estimate in Progress",
    slug: "estimate_in_progress",
    isTerminal: false,
    isActivePipeline: true,
    displayOrder: 2,
  })),
  getStageById: vi.fn(),
}));

const { AppError } = await import("../../../src/middleware/error-handler.js");
const { validateStageGate } = await import("../../../src/modules/deals/stage-gate.js");
const scopingService = await import("../../../src/modules/deals/scoping-service.js");
const { createStageTimers } = await import("../../../src/modules/deals/timer-service.js");
const { changeDealStage } = await import("../../../src/modules/deals/stage-change.js");
const pipelineService = await import("../../../src/modules/pipeline/service.js");
const { inferDealBidBoardOwnership } = await import("../../../src/modules/deals/workflow-backfill.js");
const { BID_BOARD_BOUNDARY_STAGE_MISSING_MESSAGE } = await import("../../../src/modules/deals/service.js");

type FakeDeal = {
  id: string;
  name: string;
  dealNumber: string;
  stageId: string;
  stageEnteredAt: Date;
  onHold: boolean;
  onHoldStartedAt: Date | null;
  onHoldAccumulatedSeconds: number;
  onHoldAccumulatedSecondsAtStageEntry: number;
  workflowRoute: "normal" | "service";
  assignedRepId: string;
  isBidBoardOwned: boolean;
  bidBoardStageSlug: string | null;
  readOnlySyncedAt: Date | null;
  bidBoardProjectNumber: string | null;
  actualCloseDate: string | null;
  expectedCloseDate?: string | null;
  lostReasonId: string | null;
  lostNotes: string | null;
  lostCompetitor: string | null;
  lostAt: Date | null;
  awardedAmount: string | null;
  bidEstimate: string | null;
  ddEstimate: string | null;
  forecastRevenue: string | null;
  estimator: string | null;
  bidBoardEstimator: string | null;
  projectType: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  propertyCountry: string | null;
  description: string | null;
  bidDueDate: Date | null;
  bidBoardDueDate: Date | null;
  rfpApprovalRequestedAt: Date | null;
  rfpApprovalRequestEventId: string | null;
  rfpApprovalRequestedBy: string | null;
  rfpApprovalStatus: string | null;
};

type FakeTenantDb = ReturnType<typeof createTenantDb>;

function createTenantDb(overrides?: Partial<FakeDeal>) {
  const state = {
    deals: [
      {
        id: "deal-1",
        name: "Palm Villas",
        dealNumber: "TR-2026-0001",
        stageId: "stage-dd",
        stageEnteredAt: new Date("2026-04-20T10:00:00.000Z"),
        onHold: false,
        onHoldStartedAt: null,
        onHoldAccumulatedSeconds: 0,
        onHoldAccumulatedSecondsAtStageEntry: 0,
        workflowRoute: "normal" as const,
        assignedRepId: "user-1",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
        bidBoardProjectNumber: null,
        actualCloseDate: null,
        lostReasonId: null,
        lostNotes: null,
        lostCompetitor: null,
        lostAt: null,
        awardedAmount: null,
        bidEstimate: "125000",
        ddEstimate: null,
        forecastRevenue: null,
        estimator: "Estimator One",
        bidBoardEstimator: null,
        projectType: "reroof",
        propertyAddress: "100 Main",
        propertyCity: "Dallas",
        propertyState: "TX",
        propertyZip: "75201",
        propertyCountry: "US",
        description: "Roof scope",
        bidDueDate: new Date("2026-06-01T00:00:00.000Z"),
        bidBoardDueDate: null,
        rfpApprovalRequestedAt: null,
        rfpApprovalRequestEventId: null,
        rfpApprovalRequestedBy: null,
        rfpApprovalStatus: null,
        ...overrides,
      },
    ] as FakeDeal[],
    stageHistory: [] as Array<Record<string, unknown>>,
    auditLog: [] as Array<Record<string, unknown>>,
    jobs: [] as Array<Record<string, unknown>>,
    ops: [] as string[],
  };

  function tableName(table: unknown) {
    return String((table as Record<PropertyKey, unknown> | undefined)?.[Symbol.for("drizzle:Name")] ?? "");
  }

  return {
    state,
    select() {
      return {
        from(table: unknown) {
          const name = tableName(table);
          const rows =
            name === "deals"
              ? state.deals
              : name === "deal_stage_history"
                ? state.stageHistory
                : [];

          return {
            where() {
              return {
                limit(limit: number) {
                  return {
                    for() {
                      return Promise.resolve(rows.slice(0, limit));
                    },
                    then(onfulfilled: (value: unknown[]) => unknown) {
                      return Promise.resolve(rows.slice(0, limit)).then(onfulfilled);
                    },
                  };
                },
                then(onfulfilled: (value: unknown[]) => unknown) {
                  return Promise.resolve(rows).then(onfulfilled);
                },
              };
            },
            limit(limit: number) {
              return Promise.resolve(rows.slice(0, limit));
            },
          };
        },
      };
    },
    update(table: unknown) {
      const name = tableName(table);
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              return {
                returning() {
                  if (name === "deals") {
                    state.ops.push("update:deals");
                    state.deals[0] = {
                      ...state.deals[0],
                      ...values,
                    };
                    return Promise.resolve([state.deals[0]]);
                  }

                  if (name === tableName(dealApprovals) || name === tableName(tasks)) {
                    return Promise.resolve([]);
                  }

                  throw new Error(`Unexpected update on ${name}`);
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      const name = tableName(table);
      return {
        values(values: Record<string, unknown>) {
          const row = { id: `${name}-${state.jobs.length + state.stageHistory.length + 1}`, ...values };
          if (name === tableName(dealStageHistory)) {
            state.ops.push("insert:deal_stage_history");
            state.stageHistory.push(row);
            return {
              returning() {
                return Promise.resolve([row]);
              },
            };
          }

          if (name === tableName(jobQueue)) {
            state.jobs.push(row);
            return {
              returning() {
                return Promise.resolve([row]);
              },
              then(onfulfilled: (value: unknown) => unknown) {
                return Promise.resolve([row]).then(onfulfilled);
              },
            };
          }

          if (name === tableName(auditLog)) {
            state.auditLog.push(row);
            return Promise.resolve([]);
          }

          throw new Error(`Unexpected insert on ${name}`);
        },
      };
    },
    execute(query: unknown) {
      state.ops.push("execute:" + sqlText(query));
      return Promise.resolve({ rows: [] });
    },
  };
}

// Recover the static text of a drizzle `sql` template (no interpolated params in the
// statements under test) so a test can assert which set_config call ran and in what order.
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      if (Array.isArray(value)) return value.join("");
      if (typeof value === "string") return value;
      return "";
    })
    .join("");
}

describe("changeDealStage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.ENABLE_OPPORTUNITY_RFP_EVENT;
    process.env.ENABLE_CONTRACT_STAGE_SELECTION = "false";
    vi.mocked(scopingService.activateDealScopingIntake).mockResolvedValue({
      readiness: { status: "ready" },
    } as never);
    vi.mocked(createStageTimers).mockResolvedValue(undefined as never);
  });

  it("rejects moving a deal into an inactive target stage with a typed validation error", async () => {
    const tenantDb = createTenantDb({
      stageId: "stage-opportunity",
      ddEstimate: null,
      bidEstimate: null,
    });

    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-dd",
        name: "Due Diligence",
        slug: "dd",
        isTerminal: false,
        isActivePipeline: false,
        displayOrder: 0,
      },
      currentStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 1,
      },
    } as never);

    await expect(
      changeDealStage(tenantDb as never, {
        dealId: "deal-1",
        targetStageId: "stage-dd",
        userId: "user-1",
        userRole: "director",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 400,
      code: "INACTIVE_DEAL_STAGE",
      message: "Cannot set deal stage to inactive pipeline stage.",
    });

    expect(tenantDb.state.deals[0]?.stageId).toBe("stage-opportunity");
    expect(tenantDb.state.stageHistory).toHaveLength(0);
  });

  it("applies an incoming expectedCloseDate: passes it to the gate as a pending value and persists it with the move", async () => {
    const tenantDb = createTenantDb({ stageId: "stage-a", ddEstimate: null, bidEstimate: null });
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: { id: "stage-b", name: "Estimating", slug: "estimating", isTerminal: false, isActivePipeline: true, displayOrder: 3 },
      currentStage: { id: "stage-a", name: "Opportunity", slug: "opportunity", isTerminal: false, isActivePipeline: true, displayOrder: 1 },
    } as never);

    await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-b",
      userId: "user-1",
      userRole: "director",
      expectedCloseDate: "2026-12-01",
    });

    // the gate considered the about-to-be-persisted date (so the advance succeeds in one action)
    expect(vi.mocked(validateStageGate)).toHaveBeenCalledWith(
      tenantDb,
      "deal-1",
      "stage-b",
      "director",
      "user-1",
      { expectedCloseDate: "2026-12-01" }
    );
    // and the date is persisted with the move
    expect(tenantDb.state.deals[0]?.expectedCloseDate).toBe("2026-12-01");
  });

  it("sets the skip flag before the stage UPDATE and clears it after the history insert (de-dupes the DB backstop trigger)", async () => {
    const tenantDb = createTenantDb({
      stageId: "stage-a",
      ddEstimate: null,
      bidEstimate: null,
    });
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: { id: "stage-b", name: "Opportunity", slug: "opportunity", isTerminal: false, isActivePipeline: true, displayOrder: 1 },
      currentStage: { id: "stage-a", name: "Sales Validation", slug: "sales_validation", isTerminal: false, isActivePipeline: true, displayOrder: 0 },
    } as never);

    await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-b",
      userId: "user-1",
      userRole: "director",
    });

    const ops = tenantDb.state.ops;
    const setIdx = ops.findIndex((o) => o.includes("set_config") && o.includes("skip_stage_history_trigger") && o.includes("'1', true"));
    const updIdx = ops.indexOf("update:deals");
    const insIdx = ops.indexOf("insert:deal_stage_history");
    const resetIdx = ops.findIndex((o) => o.includes("set_config") && o.includes("skip_stage_history_trigger") && o.includes("'', true"));

    // Exactly one app-level history row (the rich insert); the backstop trigger must not also record.
    expect(ops.filter((o) => o === "insert:deal_stage_history")).toHaveLength(1);
    // Flag set BEFORE the stage UPDATE (which fires the AFTER-UPDATE backstop trigger) ...
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(updIdx).toBeGreaterThan(setIdx);
    // ... and cleared AFTER the explicit insert so it cannot leak to later updates in the same txn.
    expect(insIdx).toBeGreaterThan(updIdx);
    expect(resetIdx).toBeGreaterThan(insIdx);
  });

  it("resets stageEnteredAt on every transition including re-entry to a previous stage", async () => {
    vi.useFakeTimers();
    const tenantDb = createTenantDb({
      stageId: "stage-a",
      stageEnteredAt: new Date("2026-05-01T12:00:00.000Z"),
      ddEstimate: null,
      bidEstimate: null,
    });
    const stageA = {
      id: "stage-a",
      name: "Sales Validation",
      slug: "sales_validation",
      isTerminal: false,
      isActivePipeline: true,
      displayOrder: 0,
    };
    const stageB = {
      id: "stage-b",
      name: "Opportunity",
      slug: "opportunity",
      isTerminal: false,
      isActivePipeline: true,
      displayOrder: 1,
    };

    vi.mocked(validateStageGate).mockImplementation(async (_tenantDb, _dealId, targetStageId) => ({
      allowed: true,
      isBackwardMove: targetStageId === "stage-a",
      requiresOverride: false,
      targetStage: targetStageId === "stage-a" ? stageA : stageB,
      currentStage: targetStageId === "stage-a" ? stageB : stageA,
    }) as never);

    vi.setSystemTime(new Date("2026-05-02T09:00:00.000Z"));
    const firstMove = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-b",
      userId: "user-1",
      userRole: "director",
    });

    vi.setSystemTime(new Date("2026-05-03T10:30:00.000Z"));
    const reentryMove = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-a",
      userId: "user-1",
      userRole: "director",
    });

    expect(firstMove.deal.stageEnteredAt).toEqual(new Date("2026-05-02T09:00:00.000Z"));
    expect(reentryMove.deal.stageEnteredAt).toEqual(new Date("2026-05-03T10:30:00.000Z"));
    expect(tenantDb.state.stageHistory).toEqual([
      expect.objectContaining({
        fromStageId: "stage-a",
        toStageId: "stage-b",
      }),
      expect.objectContaining({
        fromStageId: "stage-b",
        toStageId: "stage-a",
      }),
    ]);
    vi.useRealTimers();
  });

  it("snapshots the lifetime hold accumulator at stage entry when moving while active", async () => {
    vi.useFakeTimers();
    const tenantDb = createTenantDb({
      stageId: "stage-a",
      stageEnteredAt: new Date("2026-05-01T12:00:00.000Z"),
      onHold: false,
      onHoldStartedAt: null,
      onHoldAccumulatedSeconds: 7200,
      onHoldAccumulatedSecondsAtStageEntry: 1800,
      ddEstimate: null,
      bidEstimate: null,
    });
    const stageA = {
      id: "stage-a",
      name: "Sales Validation",
      slug: "sales_validation",
      isTerminal: false,
      isActivePipeline: true,
      displayOrder: 0,
    };
    const stageB = {
      id: "stage-b",
      name: "Opportunity",
      slug: "opportunity",
      isTerminal: false,
      isActivePipeline: true,
      displayOrder: 1,
    };

    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: stageB,
      currentStage: stageA,
    } as never);

    vi.setSystemTime(new Date("2026-05-02T09:00:00.000Z"));
    const result = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-b",
      userId: "user-1",
      userRole: "director",
    });

    expect(result.deal.stageEnteredAt).toEqual(new Date("2026-05-02T09:00:00.000Z"));
    expect(result.deal.onHoldAccumulatedSecondsAtStageEntry).toBe(7200);
    vi.useRealTimers();
  });

  it("splits an active hold at the stage boundary so the new stage starts with a clean hold clock", async () => {
    vi.useFakeTimers();
    const tenantDb = createTenantDb({
      stageId: "stage-a",
      stageEnteredAt: new Date("2026-05-01T12:00:00.000Z"),
      onHold: true,
      onHoldStartedAt: new Date("2026-05-01T20:00:00.000Z"),
      onHoldAccumulatedSeconds: 3600,
      onHoldAccumulatedSecondsAtStageEntry: 1800,
      ddEstimate: null,
      bidEstimate: null,
    });
    const stageA = {
      id: "stage-a",
      name: "Sales Validation",
      slug: "sales_validation",
      isTerminal: false,
      isActivePipeline: true,
      displayOrder: 0,
    };
    const stageB = {
      id: "stage-b",
      name: "Opportunity",
      slug: "opportunity",
      isTerminal: false,
      isActivePipeline: true,
      displayOrder: 1,
    };

    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: stageB,
      currentStage: stageA,
    } as never);

    vi.setSystemTime(new Date("2026-05-02T09:00:00.000Z"));
    const result = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-b",
      userId: "user-1",
      userRole: "director",
    });

    expect(result.deal.onHold).toBe(true);
    expect(result.deal.stageEnteredAt).toEqual(new Date("2026-05-02T09:00:00.000Z"));
    expect(result.deal.onHoldStartedAt).toEqual(new Date("2026-05-02T09:00:00.000Z"));
    expect(result.deal.onHoldAccumulatedSeconds).toBe(3600 + 13 * 60 * 60);
    expect(result.deal.onHoldAccumulatedSecondsAtStageEntry).toBe(3600 + 13 * 60 * 60);
    vi.useRealTimers();
  });

  it("marks the deal as Bid Board-owned once CRM hands it off into estimate in progress", async () => {
    const tenantDb = createTenantDb();
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-estimating",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 2,
      },
      currentStage: {
        id: "stage-dd",
        name: "DD",
        slug: "dd",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 0,
      },
    } as never);

    const result = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-estimating",
      userId: "user-1",
      userRole: "director",
    });

    expect(result.deal.stageId).toBe("stage-estimating");
    expect(result.deal.isBidBoardOwned).toBe(true);
    expect(result.deal.bidBoardStageSlug).toBe("estimate_in_progress");
    expect(result.deal.readOnlySyncedAt).toBeInstanceOf(Date);
  });

  it("does not generate Bid Board project numbers on entry to Opportunity", async () => {
    vi.setSystemTime(new Date("2026-04-16T15:00:00.000Z"));
    const tenantDb = createTenantDb();
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 1,
      },
      currentStage: {
        id: "stage-sales-validation",
        name: "Sales Validation Stage",
        slug: "sales_validation_stage",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 0,
      },
    } as never);

    const result = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-opportunity",
      userId: "user-1",
      userRole: "director",
    });

    expect(result.deal.bidBoardProjectNumber).toBeNull();
    vi.useRealTimers();
  });

  it("does not enqueue RFP automatically when CRM enters Opportunity", async () => {
    process.env.ENABLE_OPPORTUNITY_RFP_EVENT = "true";
    vi.setSystemTime(new Date("2026-05-01T18:00:00.000Z"));
    const tenantDb = createTenantDb({
      stageId: "stage-sales-validation",
    });
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 1,
      },
      currentStage: {
        id: "stage-sales-validation",
        name: "Sales Validation",
        slug: "sales_validation",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 0,
      },
    } as never);

    const result = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-opportunity",
      userId: "user-1",
      userRole: "director",
      officeId: "office-1",
    });

    expect(result.eventsEmitted).not.toContain("deal.opportunity.entered");
    expect(result.deal.rfpApprovalRequestedAt).toBeNull();
    expect(result.deal.rfpApprovalRequestEventId).toBeNull();
    expect(result.deal.rfpApprovalRequestedBy).toBeNull();
    expect(result.deal.rfpApprovalStatus).toBeNull();

    const opportunityJobs = tenantDb.state.jobs.filter(
      (job) => (job.payload as { eventName?: string }).eventName === "deal.opportunity.entered"
    );
    expect(opportunityJobs).toHaveLength(0);

    const rfpJobs = tenantDb.state.jobs.filter((job) => job.jobType === "rfp_request_delivery");
    expect(rfpJobs).toHaveLength(0);
    vi.useRealTimers();
  });

  it("suppresses deal.opportunity.entered after the lifetime request marker is set", async () => {
    process.env.ENABLE_OPPORTUNITY_RFP_EVENT = "true";
    const tenantDb = createTenantDb({
      rfpApprovalRequestedAt: new Date("2026-04-30T18:00:00.000Z"),
      rfpApprovalRequestEventId: "11111111-1111-4111-8111-111111111111",
      rfpApprovalRequestedBy: "user-previous",
    });
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: true,
      requiresOverride: false,
      targetStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 1,
      },
      currentStage: {
        id: "stage-estimating",
        name: "Estimating",
        slug: "estimating",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 2,
      },
    } as never);

    const result = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-opportunity",
      userId: "user-1",
      userRole: "director",
      officeId: "office-1",
    });

    expect(result.eventsEmitted).not.toContain("deal.opportunity.entered");
    expect(result.deal.rfpApprovalRequestedAt).toEqual(new Date("2026-04-30T18:00:00.000Z"));
    expect(result.deal.rfpApprovalRequestEventId).toBe("11111111-1111-4111-8111-111111111111");
    expect(result.deal.rfpApprovalRequestedBy).toBe("user-previous");
    expect(
      tenantDb.state.jobs.filter(
        (job) => (job.payload as { eventName?: string }).eventName === "deal.opportunity.entered"
      )
    ).toHaveLength(0);
    expect(tenantDb.state.jobs.filter((job) => job.jobType === "rfp_request_delivery")).toHaveLength(0);
  });

  it("does not emit deal.opportunity.entered when the feature flag is disabled", async () => {
    const tenantDb = createTenantDb();
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 1,
      },
      currentStage: {
        id: "stage-sales-validation",
        name: "Sales Validation",
        slug: "sales_validation",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 0,
      },
    } as never);

    const result = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-opportunity",
      userId: "user-1",
      userRole: "director",
      officeId: "office-1",
    });

    expect(result.eventsEmitted).not.toContain("deal.opportunity.entered");
    expect(result.deal.rfpApprovalRequestedAt).toBeNull();
    expect(result.deal.rfpApprovalRequestEventId).toBeNull();
    expect(result.deal.rfpApprovalRequestedBy).toBeNull();
  });

  it("does not emit deal.opportunity.entered for non-Opportunity stage changes", async () => {
    process.env.ENABLE_OPPORTUNITY_RFP_EVENT = "true";
    const tenantDb = createTenantDb();
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-sales-validation",
        name: "Sales Validation",
        slug: "sales_validation",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 0,
      },
      currentStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 1,
      },
    } as never);

    const result = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-sales-validation",
      userId: "user-1",
      userRole: "director",
      officeId: "office-1",
    });

    expect(result.eventsEmitted).not.toContain("deal.opportunity.entered");
  });

  it("rejects transitions into Contract while contract stage selection is disabled", async () => {
    const tenantDb = createTenantDb({
      stageId: "stage-opportunity",
    });
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-contract",
        name: "Contract",
        slug: "contract",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 5,
      },
      currentStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 1,
      },
    } as never);

    await expect(
      changeDealStage(tenantDb as never, {
        dealId: "deal-1",
        targetStageId: "stage-contract",
        userId: "user-1",
        userRole: "director",
        officeId: "office-1",
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "CONTRACT_STAGE_SELECTION_DISABLED",
    });

    expect(tenantDb.state.deals[0]?.stageId).toBe("stage-opportunity");
  });

  it("allows transitions into Contract when contract stage selection is enabled", async () => {
    process.env.ENABLE_CONTRACT_STAGE_SELECTION = "true";
    const tenantDb = createTenantDb({
      stageId: "stage-opportunity",
    });
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-contract",
        name: "Contract",
        slug: "contract",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 5,
      },
      currentStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 1,
      },
    } as never);

    const result = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-contract",
      userId: "user-1",
      userRole: "director",
      officeId: "office-1",
    });

    expect(result.deal.stageId).toBe("stage-contract");
  });

  it("marks service deals as Bid Board-owned when CRM hands them into service estimating", async () => {
    const tenantDb = createTenantDb({
      workflowRoute: "service",
    });
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-service-estimating",
        name: "Service Estimating",
        slug: "service_estimating",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 1,
      },
      currentStage: {
        id: "stage-dd",
        name: "DD",
        slug: "dd",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 0,
      },
    } as never);

    const result = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-service-estimating",
      userId: "user-1",
      userRole: "director",
    });

    expect(result.deal.stageId).toBe("stage-service-estimating");
    expect(result.deal.isBidBoardOwned).toBe(true);
    expect(result.deal.bidBoardStageSlug).toBe("service_estimating");
    expect(result.deal.readOnlySyncedAt).toBeInstanceOf(Date);
  });

  it("blocks manual downstream stage changes after Bid Board ownership begins", async () => {
    const tenantDb = createTenantDb({
      stageId: "stage-estimating",
      isBidBoardOwned: true,
      bidBoardStageSlug: "estimate_in_progress",
      readOnlySyncedAt: new Date("2026-04-21T12:00:00.000Z"),
    });

    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-bid-sent",
        name: "Estimate Under Review",
        slug: "estimate_under_review",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 3,
      },
      currentStage: {
        id: "stage-estimating",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 2,
      },
    } as never);
    vi.mocked(pipelineService.getStageBySlug).mockResolvedValueOnce({
      id: "stage-estimate-in-progress",
      name: "Estimate in Progress",
      slug: "estimate_in_progress",
      isTerminal: false,
      isActivePipeline: true,
      displayOrder: 1,
    } as never);

    await expect(
      changeDealStage(tenantDb as never, {
        dealId: "deal-1",
        targetStageId: "stage-bid-sent",
        userId: "user-1",
        userRole: "director",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 403,
      code: "BID_BOARD_OWNED_STAGE_READ_ONLY",
      message:
        "Deal stage progression is read-only in CRM after estimating handoff. Bid Board is now the source of truth for downstream stages.",
    });

    expect(tenantDb.state.deals[0]?.stageId).toBe("stage-estimating");
    expect(tenantDb.state.stageHistory).toHaveLength(0);
  });

  it("blocks manual stage-id mutations within Bid Board-owned estimating after handoff", async () => {
    const tenantDb = createTenantDb({
      stageId: "stage-estimating-service",
      workflowRoute: "service",
      isBidBoardOwned: true,
      bidBoardStageSlug: "estimating",
      readOnlySyncedAt: new Date("2026-04-21T12:00:00.000Z"),
    });

    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-estimating-service-clone",
        name: "Service Estimating",
        slug: "estimating",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 1,
      },
      currentStage: {
        id: "stage-estimating-service",
        name: "Service Estimating",
        slug: "estimating",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 1,
      },
    } as never);

    await expect(
      changeDealStage(tenantDb as never, {
        dealId: "deal-1",
        targetStageId: "stage-estimating-service-clone",
        userId: "user-1",
        userRole: "director",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 403,
      code: "BID_BOARD_OWNED_STAGE_READ_ONLY",
      message:
        "Deal stage progression is read-only in CRM after estimating handoff. Bid Board is now the source of truth for downstream stages.",
    });

    expect(tenantDb.state.deals[0]?.stageId).toBe("stage-estimating-service");
    expect(tenantDb.state.stageHistory).toHaveLength(0);
  });

  it("allows the CRM-authored handoff move into estimate in progress", async () => {
    const tenantDb = createTenantDb({
      stageId: "stage-opportunity",
      isBidBoardOwned: false,
      bidBoardStageSlug: null,
      readOnlySyncedAt: null,
    });
    vi.mocked(pipelineService.getStageBySlug).mockResolvedValueOnce({
      id: "stage-estimating-boundary",
      name: "Estimate in Progress",
      slug: "estimate_in_progress",
      isTerminal: false,
      isActivePipeline: true,
      displayOrder: 1,
    } as never);

    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-estimating",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 2,
      },
      currentStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 1,
      },
    } as never);

    const result = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-estimating",
      userId: "user-1",
      userRole: "director",
    });

    expect(result.deal.stageId).toBe("stage-estimating");
    expect(tenantDb.state.stageHistory).toHaveLength(1);
  });

  it("activates scoping intake before the estimating handoff marks the deal as Bid Board-owned", async () => {
    const tenantDb = createTenantDb({
      stageId: "stage-opportunity",
      isBidBoardOwned: false,
      bidBoardStageSlug: null,
      readOnlySyncedAt: null,
    });
    vi.mocked(pipelineService.getStageBySlug).mockResolvedValueOnce({
      id: "stage-estimating-boundary",
      name: "Estimate in Progress",
      slug: "estimate_in_progress",
      isTerminal: false,
      isActivePipeline: true,
      displayOrder: 1,
    } as never);
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-estimating",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 2,
      },
      currentStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 1,
      },
    } as never);
    vi.mocked(scopingService.activateDealScopingIntake).mockImplementation(async () => {
      expect(tenantDb.state.deals[0]?.isBidBoardOwned).toBe(false);
      return {
        readiness: { status: "ready" },
      } as never;
    });

    const result = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-estimating",
      userId: "user-1",
      userRole: "director",
    });

    expect(result.deal.isBidBoardOwned).toBe(true);
    expect(scopingService.activateDealScopingIntake).toHaveBeenCalledWith(tenantDb, "deal-1");
  });

  it("blocks crm-authored progression deeper into downstream mirrored stages after a bid board sync", async () => {
    const tenantDb = createTenantDb({
      stageId: "stage-bid-sent",
      isBidBoardOwned: true,
      bidBoardStageSlug: "estimate_under_review",
      readOnlySyncedAt: new Date("2026-04-21T12:00:00.000Z"),
    });

    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-production",
        name: "Sent to Production",
        slug: "sent_to_production",
        isTerminal: true,
        isActivePipeline: true,
        displayOrder: 5,
      },
      currentStage: {
        id: "stage-bid-sent",
        name: "Estimate Under Review",
        slug: "estimate_under_review",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 3,
      },
    } as never);

    await expect(
      changeDealStage(tenantDb as never, {
        dealId: "deal-1",
        targetStageId: "stage-production",
        userId: "user-1",
        userRole: "director",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 403,
      code: "BID_BOARD_OWNED_STAGE_READ_ONLY",
      message:
        "Deal stage progression is read-only in CRM after estimating handoff. Bid Board is now the source of truth for downstream stages.",
    });

    expect(tenantDb.state.deals[0]?.stageId).toBe("stage-bid-sent");
    expect(tenantDb.state.stageHistory).toHaveLength(0);
  });

  it("blocks downstream stage changes for legacy downstream deals even when the ownership flags were never backfilled", async () => {
    const tenantDb = createTenantDb({
      stageId: "stage-bid-sent",
      isBidBoardOwned: false,
      bidBoardStageSlug: null,
      readOnlySyncedAt: null,
    });

    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-production",
        name: "In Production",
        slug: "in_production",
        isTerminal: true,
        isActivePipeline: true,
        displayOrder: 4,
      },
      currentStage: {
        id: "stage-bid-sent",
        name: "Bid Sent",
        slug: "bid_sent",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 3,
      },
    } as never);

    await expect(
      changeDealStage(tenantDb as never, {
        dealId: "deal-1",
        targetStageId: "stage-production",
        userId: "user-1",
        userRole: "director",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 403,
      code: "BID_BOARD_OWNED_STAGE_READ_ONLY",
      message:
        "Deal stage progression is read-only in CRM after estimating handoff. Bid Board is now the source of truth for downstream stages.",
    });

    expect(tenantDb.state.deals[0]?.stageId).toBe("stage-bid-sent");
    expect(tenantDb.state.stageHistory).toHaveLength(0);
  });

  it("clears bid board ownership markers when a legitimate reopen moves back into crm-owned opportunity", async () => {
    const tenantDb = createTenantDb({
      stageId: "stage-closed-won",
      isBidBoardOwned: true,
      bidBoardStageSlug: "sent_to_production",
      readOnlySyncedAt: new Date("2026-04-21T12:00:00.000Z"),
      actualCloseDate: "2026-04-21",
    });

    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: true,
      requiresOverride: false,
      targetStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 0,
      },
      currentStage: {
        id: "stage-closed-won",
        name: "Sent to Production",
        slug: "sent_to_production",
        isTerminal: true,
        isActivePipeline: true,
        displayOrder: 10,
      },
    } as never);

    const result = await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-opportunity",
      userId: "user-1",
      userRole: "director",
    });

    expect(result.deal.stageId).toBe("stage-opportunity");
    expect(result.deal.isBidBoardOwned).toBe(false);
    expect(result.deal.bidBoardStageSlug).toBeNull();
    expect(result.deal.readOnlySyncedAt).toBeNull();
    expect(result.deal.actualCloseDate).toBeNull();

    expect(
      inferDealBidBoardOwnership({
        id: result.deal.id,
        stageSlug: "opportunity",
        stageEnteredAt: result.deal.stageEnteredAt,
        workflowRoute: result.deal.workflowRoute,
        awardedAmount: result.deal.awardedAmount,
        sourceLeadId: (result.deal as { sourceLeadId?: string | null }).sourceLeadId ?? null,
        isBidBoardOwned: result.deal.isBidBoardOwned,
        bidBoardStageSlug: result.deal.bidBoardStageSlug,
        bidBoardStageEnteredAt: (result.deal as { bidBoardStageEnteredAt?: Date | null })
          .bidBoardStageEnteredAt ?? null,
        bidBoardMirrorSourceEnteredAt:
          (result.deal as { bidBoardMirrorSourceEnteredAt?: Date | null })
            .bidBoardMirrorSourceEnteredAt ?? null,
        isReadOnlyMirror: (result.deal as { isReadOnlyMirror?: boolean }).isReadOnlyMirror ?? false,
        readOnlySyncedAt: result.deal.readOnlySyncedAt,
      }).ownershipModel
    ).toBe("crm");
  });

  it("fails closed when the estimating boundary stage config is missing for an owned deal", async () => {
    const tenantDb = createTenantDb({
      stageId: "stage-estimating",
      isBidBoardOwned: true,
      bidBoardStageSlug: "estimate_in_progress",
      readOnlySyncedAt: new Date("2026-04-21T12:00:00.000Z"),
    });

    vi.mocked(pipelineService.getStageBySlug)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(null as never);
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-bid-sent",
        name: "Estimate Under Review",
        slug: "estimate_under_review",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 3,
      },
      currentStage: {
        id: "stage-estimating",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 2,
      },
    } as never);

    await expect(
      changeDealStage(tenantDb as never, {
        dealId: "deal-1",
        targetStageId: "stage-bid-sent",
        userId: "user-1",
        userRole: "director",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 500,
      code: "BID_BOARD_BOUNDARY_STAGE_MISSING",
      message: BID_BOARD_BOUNDARY_STAGE_MISSING_MESSAGE,
    });
  });

  it("writes a rich audit_log entry for stage transitions when audit context is present", async () => {
    const tenantDb = createTenantDb();
    vi.mocked(validateStageGate).mockResolvedValue({
      allowed: true,
      isBackwardMove: false,
      requiresOverride: false,
      targetStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 3,
      },
      currentStage: {
        id: "stage-discovery",
        name: "Discovery",
        slug: "discovery",
        isTerminal: false,
        isActivePipeline: true,
        displayOrder: 2,
      },
    } as never);

    await changeDealStage(tenantDb as never, {
      dealId: "deal-1",
      targetStageId: "stage-opportunity",
      userId: "user-1",
      userRole: "director",
      auditContext: {
        actor: {
          type: "user",
          userId: "director-1",
          name: "Director User",
          role: "director",
        },
      },
    });

    expect(tenantDb.state.auditLog).toEqual([
      expect.objectContaining({
        tableName: "deals",
        recordId: "deal-1",
        action: "update",
        actorName: "Director User",
        entityType: "deal",
        entityNameSnapshot: "Palm Villas",
        fieldChangesJsonb: [
          expect.objectContaining({
            key: "stageId",
            fromDisplay: "Discovery",
            toDisplay: "Opportunity",
          }),
        ],
      }),
    ]);
  });

});
