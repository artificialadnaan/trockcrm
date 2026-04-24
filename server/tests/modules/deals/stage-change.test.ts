import { describe, expect, it, vi, beforeEach } from "vitest";
import { dealApprovals, deals, dealStageHistory, jobQueue, tasks } from "@trock-crm/shared/schema";

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
  workflowRoute: "normal" | "service";
  assignedRepId: string;
  isBidBoardOwned: boolean;
  bidBoardStageSlug: string | null;
  readOnlySyncedAt: Date | null;
  actualCloseDate: string | null;
  lostReasonId: string | null;
  lostNotes: string | null;
  lostCompetitor: string | null;
  lostAt: Date | null;
  awardedAmount: string | null;
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
        workflowRoute: "normal" as const,
        assignedRepId: "user-1",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
        actualCloseDate: null,
        lostReasonId: null,
        lostNotes: null,
        lostCompetitor: null,
        lostAt: null,
        awardedAmount: null,
        ...overrides,
      },
    ] as FakeDeal[],
    stageHistory: [] as Array<Record<string, unknown>>,
    jobs: [] as Array<Record<string, unknown>>,
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
            state.stageHistory.push(row);
            return {
              returning() {
                return Promise.resolve([row]);
              },
            };
          }

          if (name === tableName(jobQueue)) {
            state.jobs.push(row);
            return Promise.resolve([row]);
          }

          throw new Error(`Unexpected insert on ${name}`);
        },
      };
    },
    execute() {
      return Promise.resolve([]);
    },
  };
}

describe("changeDealStage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(scopingService.activateDealScopingIntake).mockResolvedValue({
      readiness: { status: "ready" },
    } as never);
    vi.mocked(createStageTimers).mockResolvedValue(undefined as never);
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
        displayOrder: 2,
      },
      currentStage: {
        id: "stage-dd",
        name: "DD",
        slug: "dd",
        isTerminal: false,
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
        displayOrder: 1,
      },
      currentStage: {
        id: "stage-dd",
        name: "DD",
        slug: "dd",
        isTerminal: false,
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
        displayOrder: 3,
      },
      currentStage: {
        id: "stage-estimating",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isTerminal: false,
        displayOrder: 2,
      },
    } as never);
    vi.mocked(pipelineService.getStageBySlug).mockResolvedValueOnce({
      id: "stage-estimate-in-progress",
      name: "Estimate in Progress",
      slug: "estimate_in_progress",
      isTerminal: false,
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
        displayOrder: 1,
      },
      currentStage: {
        id: "stage-estimating-service",
        name: "Service Estimating",
        slug: "estimating",
        isTerminal: false,
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
        displayOrder: 2,
      },
      currentStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
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
        displayOrder: 2,
      },
      currentStage: {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isTerminal: false,
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
        displayOrder: 5,
      },
      currentStage: {
        id: "stage-bid-sent",
        name: "Estimate Under Review",
        slug: "estimate_under_review",
        isTerminal: false,
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
        displayOrder: 4,
      },
      currentStage: {
        id: "stage-bid-sent",
        name: "Bid Sent",
        slug: "bid_sent",
        isTerminal: false,
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
        displayOrder: 0,
      },
      currentStage: {
        id: "stage-closed-won",
        name: "Sent to Production",
        slug: "sent_to_production",
        isTerminal: true,
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
        displayOrder: 3,
      },
      currentStage: {
        id: "stage-estimating",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isTerminal: false,
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

});
