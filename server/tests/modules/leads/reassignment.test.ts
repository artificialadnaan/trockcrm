import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/assignment-tasks/service.js", () => ({
  createAssignmentTaskIfNeeded: vi.fn(),
}));

const { createAssignmentTaskIfNeeded } = await import(
  "../../../src/modules/assignment-tasks/service.js"
);
const { createLeadService } = await import("../../../src/modules/leads/service.js");

function createSelectQueueDb(queue: unknown[]) {
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
      id: "lead-1",
      name: "Oakwood Roof Assessment",
      assignedRepId: "rep-new",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      stageId: "stage-lead",
      status: "open",
      source: null,
      description: null,
      stageEnteredAt: new Date("2026-04-01T00:00:00.000Z"),
      isActive: true,
      lastActivityAt: null,
      convertedAt: null,
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

describe("lead reassignment tasking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new lead assignment task when assignedRepId changes", async () => {
    const tenantDb = createSelectQueueDb([
      [
        {
          id: "lead-1",
          name: "Oakwood Roof Assessment",
          assignedRepId: "rep-old",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          stageId: "stage-lead",
          status: "open",
          source: null,
          description: null,
          stageEnteredAt: new Date("2026-04-01T00:00:00.000Z"),
          isActive: true,
          lastActivityAt: null,
          convertedAt: null,
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        },
      ],
      [{ id: "company-1", name: "Oakwood" }],
      [{ id: "property-1", name: "Oakwood Apartments", address: null, city: null, state: null, zip: null }],
      [],
      [{ id: "rep-new", isActive: true, officeId: "office-1" }],
    ]);
    const service = createLeadService();

    await service.updateLead(
      tenantDb as any,
      "lead-1",
      {
        assignedRepId: "rep-new",
        officeId: "office-1",
      },
      "director",
      "director-1"
    );

    expect(createAssignmentTaskIfNeeded).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        entityType: "lead",
        entityId: "lead-1",
        previousAssignedRepId: "rep-old",
        nextAssignedRepId: "rep-new",
        actorUserId: "director-1",
      })
    );
  });
});
