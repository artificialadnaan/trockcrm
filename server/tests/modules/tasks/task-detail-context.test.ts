import { describe, expect, it, vi } from "vitest";

const { getTaskById, getTaskRowById } = await import("../../../src/modules/tasks/service.js");

/**
 * Captures the projection object handed to `.select()` and whether the query joined `deals`.
 * The detail endpoint used to run a bare `select()` over `tasks`, so it returned `dealId` but
 * none of the deal columns the UI needs to name the project.
 */
function createCapturingDb(rows: unknown[]) {
  const captured: { projection?: Record<string, unknown>; joined: boolean } = { joined: false };
  const chain: Record<string, any> = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => {
      captured.joined = true;
      return chain;
    }),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
  };
  const db = {
    select: vi.fn((projection?: Record<string, unknown>) => {
      captured.projection = projection;
      return chain;
    }),
  };
  return { db, captured };
}

const taskRow = {
  id: "61a456fb-05c6-44fb-a888-f970d0733246",
  title: "Need Property info",
  status: "pending",
  assignedTo: "user-derek",
  assignedToName: "Derek Barr",
  dealId: "deal-1",
  dealName: "Palm Villas",
  dealNumber: "HS-324283495135",
  projectNumber: "DFW-1-12826-AH",
  startedAt: null,
};

describe("getTaskById project context", () => {
  it("joins deals so a deep-linked task can name its project", async () => {
    const { db, captured } = createCapturingDb([taskRow]);

    const task = (await getTaskById(db as any, taskRow.id, "admin", "admin-1")) as any;

    expect(captured.joined).toBe(true);
    expect(Object.keys(captured.projection ?? {})).toEqual(
      expect.arrayContaining(["dealId", "dealName", "dealNumber", "projectNumber"])
    );
    expect(task.dealName).toBe("Palm Villas");
    expect(task.projectNumber).toBe("DFW-1-12826-AH");
  });

  it("resolves the assignee display name instead of leaving the row 'Unassigned'", async () => {
    const { db, captured } = createCapturingDb([taskRow]);

    const task = (await getTaskById(db as any, taskRow.id, "admin", "admin-1")) as any;

    expect(Object.keys(captured.projection ?? {})).toContain("assignedToName");
    expect(task.assignedToName).toBe("Derek Barr");
  });

  // The fixture's task is assigned to `user-derek` and has no createdBy, so "someone-else" is neither
  // its assignee NOR its assigner — still a 403. The rule widened to admit a rep who ASSIGNED the task
  // (F4: without that, a rep assigner is 403'd from the thread on their own task), which is why the
  // message names both halves now.
  it("still enforces the rep-only-own-tasks rule", async () => {
    const { db } = createCapturingDb([taskRow]);

    await expect(getTaskById(db as any, taskRow.id, "rep", "someone-else")).rejects.toThrow(
      /only view tasks assigned to you or by you/i
    );
  });

  it("still returns the status/startedAt fields the mutation guards depend on", async () => {
    const { db, captured } = createCapturingDb([taskRow]);

    await getTaskById(db as any, taskRow.id, "admin", "admin-1");

    expect(Object.keys(captured.projection ?? {})).toEqual(
      expect.arrayContaining(["status", "startedAt", "assignedTo"])
    );
  });
});

describe("getTaskRowById", () => {
  it("stays lean — the mutation guards must not pay for the display join", async () => {
    const { db, captured } = createCapturingDb([taskRow]);

    const task = (await getTaskRowById(db as any, taskRow.id, "admin", "admin-1")) as any;

    // A bare select() returns every `tasks` column and nothing else; the write paths return the
    // raw `.returning()` row, so enriching here would make PATCH's response shape depend on
    // whether any field actually changed.
    expect(captured.projection).toBeUndefined();
    expect(captured.joined).toBe(false);
    expect(task.status).toBe("pending");
  });

  it("enforces the same rep-only-own-tasks rule as the enriched read", async () => {
    const { db } = createCapturingDb([taskRow]);

    await expect(getTaskRowById(db as any, taskRow.id, "rep", "someone-else")).rejects.toThrow(
      /only view tasks assigned to you or by you/i
    );
  });
});
