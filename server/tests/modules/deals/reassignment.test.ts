import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/assignment-tasks/service.js", () => ({
  createAssignmentTaskIfNeeded: vi.fn(),
}));

const { createAssignmentTaskIfNeeded } = await import(
  "../../../src/modules/assignment-tasks/service.js"
);
const { startProposalDraft, updateDeal } = await import("../../../src/modules/deals/service.js");

function createDealDb() {
  const insertedValues: unknown[] = [];
  const queue: unknown[] = [
    [
      {
        id: "deal-1",
        name: "Hill Place Interior Upgrade",
        assignedRepId: "rep-old",
        sourceLeadId: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        primaryContactId: null,
        stageId: "stage-estimating",
        workflowRoute: "estimating",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
    ],
    [{ id: "rep-new", isActive: true, officeId: "office-1" }],
  ];

  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => {
        const next = queue.shift();
        return {
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(next).then(resolve),
          limit: vi.fn(async () => next),
        };
      }),
    })),
  }));

  const returning = vi.fn(async () => [
    {
      id: "deal-1",
      name: "Hill Place Interior Upgrade",
      assignedRepId: "rep-new",
      sourceLeadId: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      stageId: "stage-estimating",
      workflowRoute: "estimating",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    },
  ]);

  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning,
      })),
    })),
  }));

  const insert = vi.fn(() => ({
    values: vi.fn(async (value: unknown) => {
      insertedValues.push(value);
      return [];
    }),
  }));

  return { select, update, insert, insertedValues };
}

describe("deal reassignment tasking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new deal assignment task when assignedRepId changes", async () => {
    const tenantDb = createDealDb();

    await updateDeal(
      tenantDb as any,
      "deal-1",
      {
        assignedRepId: "rep-new",
      },
      "director",
      "director-1",
      "office-1"
    );

    expect(createAssignmentTaskIfNeeded).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        entityType: "deal",
        entityId: "deal-1",
        previousAssignedRepId: "rep-old",
        nextAssignedRepId: "rep-new",
        actorUserId: "director-1",
      })
    );
    expect(tenantDb.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "deal_history",
          recordId: "deal-1",
          changedBy: "director-1",
          changes: {
            assignedRepId: { from: "rep-old", to: "rep-new" },
          },
          fullRow: expect.objectContaining({
            oldRepId: "rep-old",
            newRepId: "rep-new",
            changedBy: "director-1",
          }),
        }),
        expect.objectContaining({
          jobType: "domain_event",
          payload: expect.objectContaining({
            eventName: "deal.assignment.changed",
            oldRepId: "rep-old",
            newRepId: "rep-new",
            changedBy: "director-1",
            propagationChannel: "synchub_bid_board",
          }),
        }),
      ])
    );
  });
});

describe("proposal draft backend wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stamps proposalDraftStartedAt and writes a draft audit row", async () => {
    const startedAt = new Date("2026-04-28T15:00:00.000Z");
    const insertedValues: unknown[] = [];
    const existingDeal = {
      id: "deal-1",
      name: "Hill Place Interior Upgrade",
      assignedRepId: "rep-1",
      sourceLeadId: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      stageId: "stage-estimating",
      workflowRoute: "normal",
      isBidBoardOwned: false,
      proposalStatus: "not_started",
      proposalDraftStartedAt: null,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    };
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn(async () => [existingDeal]),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          expect(values).toMatchObject({
            proposalStatus: "drafting",
            proposalDraftStartedAt: expect.any(Date),
          });
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [
                {
                  ...existingDeal,
                  ...values,
                  proposalDraftStartedAt: startedAt,
                },
              ]),
            })),
          };
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: unknown) => {
          insertedValues.push(value);
          return [];
        }),
      })),
    };

    const deal = await startProposalDraft(
      tenantDb as any,
      "deal-1",
      "director",
      "director-1"
    );

    expect(deal.proposalStatus).toBe("drafting");
    expect(deal.proposalDraftStartedAt).toEqual(startedAt);
    expect(insertedValues).toEqual([
      expect.objectContaining({
        tableName: "proposal_drafts",
        recordId: "deal-1",
        action: "insert",
        changedBy: "director-1",
        changes: expect.objectContaining({
          proposalDraftStartedAt: {
            from: null,
            to: expect.any(String),
          },
        }),
        fullRow: expect.objectContaining({
          dealId: "deal-1",
          status: "draft",
          createdBy: "director-1",
        }),
      }),
    ]);
  });
});
