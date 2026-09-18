// Posting a comment must decide EVERYTHING from one assignment.
//
// `postTaskComment` reads the task, then uses that row for four separate decisions: whether the
// author may comment, whether their comment counts as a REPLY (author === assignee), the stamp on
// `last_reply_at`, and who the reply is delivered to. Under READ COMMITTED a reassignment committing
// between the read and those decisions is enough to make them disagree with each other: a former
// assignee passes the stale authority check, their comment is classified as a reply and raises the
// task in the NEW assigner's bucket, while the notification -- built from the same stale row --
// is delivered to the FORMER assigner. Every individual step looks correct.
//
// The fix is a row lock, so the reassignment's own UPDATE has to wait behind the comment and the
// four decisions are all made against one version of the row.
//
// ⚠️ WHY THIS IS A CAPTURING TEST RATHER THAN A RACE. PGlite is a single embedded connection, so two
// genuinely concurrent transactions cannot be staged against it -- there is no second session to hold
// the conflicting write. What CAN be proven is which lock the read asks for, and that is the whole
// behavioural difference between the two versions of this code. The runtime suite alongside it proves
// the resulting row is correct; this proves the read that produced it was serialised.
import { describe, expect, it, vi } from "vitest";

const { loadLoopTaskForUpdate } = await import("../../../src/modules/tasks/closed-loop-service.js");

const TASK = "61a456fb-05c6-44fb-a888-f970d0733246";

/** Captures the lock mode the select chain requests. */
function createCapturingDb(rows: unknown[]) {
  const captured: { lockMode?: string; locked: boolean } = { locked: false };
  const chain: Record<string, any> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    for: vi.fn((mode: string) => {
      captured.locked = true;
      captured.lockMode = mode;
      return chain;
    }),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return { db: { select: vi.fn(() => chain) }, captured };
}

const taskRow = {
  id: TASK,
  title: "Send the roof photos",
  status: "pending",
  source: "manual",
  originRule: null,
  assignedTo: "user-derek",
  createdBy: "user-adam",
  lastAssignedBy: null,
};

describe("loadLoopTaskForUpdate", () => {
  it("takes a FOR UPDATE row lock, so a concurrent reassignment queues behind it", async () => {
    const { db, captured } = createCapturingDb([taskRow]);

    await loadLoopTaskForUpdate(db as any, TASK, "rep", "user-derek");

    expect(captured.locked, "the read must be locked").toBe(true);
    expect(captured.lockMode).toBe("update");
  });

  it("still enforces the visibility rule on the locked row", async () => {
    const { db } = createCapturingDb([taskRow]);
    await expect(
      loadLoopTaskForUpdate(db as any, TASK, "rep", "somebody-else")
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("404s a task that is not there", async () => {
    const { db } = createCapturingDb([]);
    await expect(
      loadLoopTaskForUpdate(db as any, TASK, "admin", "admin-1")
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns the row the rest of the write path decides from", async () => {
    const { db } = createCapturingDb([taskRow]);
    const task = await loadLoopTaskForUpdate(db as any, TASK, "rep", "user-derek");
    expect(task).toMatchObject({ id: TASK, assignedTo: "user-derek", createdBy: "user-adam" });
  });
});

describe("postTaskComment uses the locked read", () => {
  // The lock is worthless if the write path does not go through it. Read from source rather than
  // executed, because the alternative -- the unlocked loadLoopTask -- returns an identical row and
  // the difference is invisible to any single-connection assertion.
  it("does not read the task through the unlocked path", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../../../src/modules/tasks/closed-loop-service.ts", import.meta.url),
        "utf-8"
      )
    );
    const body = source.slice(source.indexOf("export async function postTaskComment"));
    const fn = body.slice(0, body.indexOf("\nexport "));

    expect(fn).toContain("loadLoopTaskForUpdate(");
    expect(fn, "the unlocked read must not be used on the write path").not.toMatch(
      /\bloadLoopTask\(/
    );
  });
});
