import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/assignment-tasks/service.js", () => ({
  createAssignmentTaskIfNeeded: vi.fn(),
}));

const { createAssignmentTaskIfNeeded } = await import(
  "../../../src/modules/assignment-tasks/service.js"
);
const { updateDeal } = await import("../../../src/modules/deals/service.js");

function createDealDb() {
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

  return { select, update };
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
  });
});
