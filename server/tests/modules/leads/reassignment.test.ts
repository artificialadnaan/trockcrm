import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/assignment-tasks/service.js", () => ({
  createAssignmentTaskIfNeeded: vi.fn(),
}));

const { createAssignmentTaskIfNeeded } = await import(
  "../../../src/modules/assignment-tasks/service.js"
);
const { createLeadService } = await import("../../../src/modules/leads/service.js");
const NEW_REP_ID = "00000000-0000-4000-8000-000000000002";

function createSelectQueueDb(queue: unknown[]) {
  const existingLead = queue[0] as unknown[];
  const tableRows = (table: any) => {
    const tableName = table?._?.name ?? table?.[Symbol.for("drizzle:Name")] ?? table?.tableName ?? "";
    if (tableName === "leads") return existingLead;
    if (tableName === "companies") return [{ id: "company-1", name: "Oakwood" }];
    if (tableName === "properties") {
      return [{ id: "property-1", name: "Oakwood Apartments", address: null, city: null, state: null, zip: null }];
    }
    if (tableName === "users") return [{ id: NEW_REP_ID, isActive: true, officeId: "office-1", role: "rep" }];
    if (tableName === "user_office_access") return [];
    return [];
  };
  const select = vi.fn(() => ({
    from: vi.fn((table: any) => {
      // decorateLeads now chains .leftJoin(users, ...) for owner badges (PR #465); support a chainable
      // leftJoin that resolves identically to a bare .where() (row resolution stays keyed on `from`).
      const where = vi.fn(() => {
        const next = tableRows(table);
        return {
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(next).then(resolve),
          limit: vi.fn(async () => next),
        };
      });
      const builder: any = { where, leftJoin: vi.fn(() => builder) };
      return builder;
    }),
  }));

  const returning = vi.fn(async () => [
    {
      id: "lead-1",
      name: "Oakwood Roof Assessment",
      assignedRepId: NEW_REP_ID,
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
      [{ id: NEW_REP_ID, isActive: true, officeId: "office-1", role: "rep" }],
    ]);
    const service = createLeadService();

    await service.updateLead(
      tenantDb as any,
      "lead-1",
      {
        assignedRepId: NEW_REP_ID,
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
        nextAssignedRepId: NEW_REP_ID,
        actorUserId: "director-1",
      })
    );
  });
});
