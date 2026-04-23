import { describe, expect, it, vi } from "vitest";
import { createAssignmentTaskIfNeeded } from "../../../src/modules/assignment-tasks/service.js";

function createMockDb(existingRows: unknown[] = []) {
  const returningTask = {
    id: "task-1",
    title: "New Lead Assignment",
    assignedTo: "rep-new",
    dueDate: "2026-04-23",
    dealId: null,
    entitySnapshot: { entityType: "lead", leadId: "lead-1" },
  };

  const limit = vi.fn(async () => existingRows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => [returningTask]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));

  return {
    db: { select, insert },
    spies: { select, from, where, limit, insert, values, returning },
  };
}

describe("createAssignmentTaskIfNeeded", () => {
  it("creates a new lead assignment task due in 3 days when assignee changes", async () => {
    const { db, spies } = createMockDb();

    const result = await createAssignmentTaskIfNeeded(db as any, {
      entityType: "lead",
      entityId: "lead-1",
      entityName: "Oakwood Roof Assessment",
      previousAssignedRepId: "rep-old",
      nextAssignedRepId: "rep-new",
      actorUserId: "director-1",
      officeId: "office-1",
      now: new Date("2026-04-20T10:00:00.000Z"),
    });

    expect(result?.title).toBe("New Lead Assignment");
    expect(result?.assignedTo).toBe("rep-new");
    expect(result?.dueDate).toBe("2026-04-23");
    expect(spies.insert).toHaveBeenCalledTimes(1);
  });

  it("creates a new deal assignment task linked to the deal", async () => {
    const { db, spies } = createMockDb();
    spies.returning.mockResolvedValueOnce([
      {
        id: "task-2",
        title: "New Deal Assignment",
        assignedTo: "rep-new",
        dueDate: "2026-04-23",
        dealId: "deal-1",
        entitySnapshot: { entityType: "deal", dealId: "deal-1" },
      },
    ]);

    const result = await createAssignmentTaskIfNeeded(db as any, {
      entityType: "deal",
      entityId: "deal-1",
      entityName: "Hill Place Interior Upgrade",
      previousAssignedRepId: "rep-old",
      nextAssignedRepId: "rep-new",
      actorUserId: "admin-1",
      officeId: "office-1",
      now: new Date("2026-04-20T10:00:00.000Z"),
    });

    expect(result?.title).toBe("New Deal Assignment");
    expect(result?.dealId).toBe("deal-1");
  });

  it("does not create a duplicate open assignment task for the same entity and assignee", async () => {
    const { db, spies } = createMockDb([{ id: "task-existing", status: "pending" }]);

    const result = await createAssignmentTaskIfNeeded(db as any, {
      entityType: "lead",
      entityId: "lead-1",
      entityName: "Oakwood Roof Assessment",
      previousAssignedRepId: "rep-old",
      nextAssignedRepId: "rep-new",
      actorUserId: "director-1",
      officeId: "office-1",
      now: new Date("2026-04-20T10:00:00.000Z"),
    });

    expect(result).toBeNull();
    expect(spies.insert).not.toHaveBeenCalled();
  });
});
