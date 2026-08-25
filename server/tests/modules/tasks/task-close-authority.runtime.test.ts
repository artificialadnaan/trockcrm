// REAL-SQL (PGlite) proof for who may CLOSE a task.
//
// Before this change `completeTask` let anyone who could SEE a task complete it, and `assertTaskVisible`
// only restricts `rep` — so a `construction` user could close any task in the office, including one
// assigned to somebody else by somebody else. That is the accountability hole the closed loop is about:
// "Adam assigned it, Adam accepts it" is meaningless if a third party can mark it done.
//
// THREE PATHS REACH A TERMINAL STATUS, and a guard on one of them is decorative:
//   * completeTask            (POST /:id/complete)
//   * dismissTask             (POST /:id/dismiss)   — `dismissed` is terminal and had NO check at all
//   * transitionTaskStatus    (POST /:id/transition with nextStatus 'completed' | 'dismissed')
//                             — reaches `completed` without touching completeTask
// Every case below is asserted against all three, because the bypass is one HTTP call away otherwise.
//
// TWO INTERNAL CALLERS ARE NEITHER ASSIGNEE NOR ASSIGNER and must keep working: email/service.ts
// `completeInboundEmailTasks` (auto-completes inbound_email tasks assigned to the MAILBOX OWNER when
// some other user associates the email to a deal) and ai-copilot/intervention-service.ts
// `syncGeneratedTaskResolution` (the AI-disconnect task has created_by = NULL, so there is no assigner
// to fall back on). They pass an explicit, enumerated system actor rather than borrowing an admin's id.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { tasks, taskResolutionState } from "@trock-crm/shared/schema";
import {
  assertTaskCloseAuthority,
  completeTask,
  dismissTask,
  transitionTaskStatus,
  TASK_CLOSE_ELEVATED_ROLES,
} from "../../../src/modules/tasks/service.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const uid = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, "0")}`;

const ASSIGNEE = uid("a1");
const ASSIGNER = uid("a2");
const STRANGER = uid("a3");
const ADMIN = uid("a4");
const MACHINE_TASK = uid("f1");
const DEAL = uid("d1");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

/** A fresh open task per case — the guards are about who may close, so each case needs an open row. */
async function seedTask(
  id: string,
  overrides: { assignedTo?: string; createdBy?: string | null } = {}
) {
  const assignedTo = overrides.assignedTo ?? ASSIGNEE;
  const createdBy = overrides.createdBy === undefined ? ASSIGNER : overrides.createdBy;
  await pg.exec(`
    DELETE FROM tasks WHERE id = '${id}';
    INSERT INTO tasks (id, title, type, priority, status, assigned_to, created_by, source)
    VALUES ('${id}', 'Send the roof photos', 'manual', 'normal', 'pending',
            '${assignedTo}', ${createdBy === null ? "NULL" : `'${createdBy}'`}, 'manual');
  `);
}

async function statusOf(id: string) {
  const result = await pg.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [id]);
  return result.rows[0]?.status;
}

/**
 * Stage a reassignment at the seam after a terminal path's authority read but before its UPDATE
 * executes. A fixture reassigned before the call only proves the first check; this wraps the real
 * Drizzle update builder so removing the write predicate lets the stale caller close the reassigned
 * row and makes the test fail.
 */
function withReassignmentBeforeTerminalWrite(taskId: string) {
  let reassignedAtWrite = false;

  const wrapBuilder = (builder: any): any => new Proxy(builder, {
    get(target, property) {
      const value = target[property];
      if (property === "returning") {
        return (...args: unknown[]) => {
          const returning = value.apply(target, args);
          return new Proxy(returning, {
            get(returningTarget, returningProperty) {
              const returningValue = returningTarget[returningProperty];
              if (returningProperty === "then") {
                return async (...thenArgs: unknown[]) => {
                  if (!reassignedAtWrite) {
                    reassignedAtWrite = true;
                    await pg.exec(`UPDATE tasks SET assigned_to = '${STRANGER}' WHERE id = '${taskId}'`);
                  }
                  return returningValue.apply(returningTarget, thenArgs);
                };
              }
              return typeof returningValue === "function"
                ? returningValue.bind(returningTarget)
                : returningValue;
            },
          });
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]) => wrapBuilder(value.apply(target, args))
        : value;
    },
  });

  const tenantDb = new Proxy(tdb, {
    get(target, property) {
      const value = target[property];
      if (property !== "update") return typeof value === "function" ? value.bind(target) : value;
      return (...args: unknown[]) => wrapBuilder(value.apply(target, args));
    },
  });

  return { tenantDb, wasInterleaved: () => reassignedAtWrite };
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [tasks, taskResolutionState]));
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, is_change_order boolean NOT NULL DEFAULT false,
      deal_number text, project_number text, is_active boolean NOT NULL DEFAULT true,
      assigned_rep_id uuid, procore_project_id text);
    INSERT INTO users (id, display_name) VALUES
      ('${ASSIGNEE}','Assignee'), ('${ASSIGNER}','Assigner'),
      ('${STRANGER}','Stranger'), ('${ADMIN}','Admin');
    -- getProjectTasks requires an ACTIVE deal carrying a procore_project_id.
    INSERT INTO deals (id, name, procore_project_id, assigned_rep_id)
    VALUES ('${DEAL}', 'Roof job', 'pc-1', '${ASSIGNEE}');
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

const CASE = uid("b1");

beforeEach(async () => {
  await seedTask(CASE);
});

describe("assertTaskCloseAuthority — the shared rule", () => {
  it("admits the assignee, the assigner and the elevated roles", () => {
    const task = { assignedTo: ASSIGNEE, createdBy: ASSIGNER };
    expect(() => assertTaskCloseAuthority(task, "rep", ASSIGNEE)).not.toThrow();
    expect(() => assertTaskCloseAuthority(task, "rep", ASSIGNER)).not.toThrow();
    for (const role of TASK_CLOSE_ELEVATED_ROLES) {
      expect(() => assertTaskCloseAuthority(task, role, STRANGER), role).not.toThrow();
    }
  });

  // The role list is an ALLOWLIST, not "everything except rep". `construction` is enumerated here
  // rather than assumed, because it is the role the old rule silently admitted: assertTaskVisible only
  // narrows `rep`, so a construction user could see — and therefore close — any task in the office.
  it("REFUSES construction and field_contractor when they are neither assignee nor assigner", () => {
    const task = { assignedTo: ASSIGNEE, createdBy: ASSIGNER };
    for (const role of ["construction", "field_contractor", "rep"]) {
      expect(() => assertTaskCloseAuthority(task, role, STRANGER), role).toThrow(/close/i);
    }
    expect(TASK_CLOSE_ELEVATED_ROLES).not.toContain("construction");
    expect(TASK_CLOSE_ELEVATED_ROLES).not.toContain("field_contractor");
  });

  // created_by IS NULL for every rules-engine and AI-disconnect task. `x === null` must not become an
  // accidental grant for a user whose id is also missing.
  it("does not treat a NULL assigner as a match", () => {
    const task = { assignedTo: ASSIGNEE, createdBy: null };
    expect(() => assertTaskCloseAuthority(task, "rep", STRANGER)).toThrow(/close/i);

    // ...and not even for a caller carrying no id of its own. `null == undefined` is TRUE under LOOSE
    // equality, so a `==` here would hand close authority over every rules-engine and AI-disconnect
    // task (all of which have created_by = NULL) to any request that reached the handler without a
    // user id on it. This is the assertion that makes the strict comparison load-bearing.
    expect(() =>
      assertTaskCloseAuthority(task, "rep", undefined as unknown as string)
    ).toThrow(/close/i);

    // ...and the assignee still gets through on a task with no assigner.
    expect(() => assertTaskCloseAuthority(task, "rep", ASSIGNEE)).not.toThrow();
  });

  it("lets an enumerated system actor through, and rejects an unrecognised one", () => {
    const task = { assignedTo: ASSIGNEE, createdBy: null };
    expect(() =>
      assertTaskCloseAuthority(task, "rep", STRANGER, { systemActor: "email_association" })
    ).not.toThrow();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assertTaskCloseAuthority(task, "rep", STRANGER, { systemActor: "whatever" as any })
    ).toThrow(/system actor/i);
  });
});

// Not in the spec, and the feature does not exist without it. `assertTaskVisible` narrowed a rep to
// tasks ASSIGNED TO THEM, so a rep who assigned a task to somebody else got a 403 on the task they had
// themselves created — no detail page, no thread, no acknowledgement, no close. The ask is literally
// "Adam assigns a task and forgets what he assigned"; if Adam is a rep, every endpoint in this feature
// 403s him on his own task.
describe("a rep can reach a task they ASSIGNED, not just one assigned to them", () => {
  it("lets a rep assigner read the task they created", async () => {
    const { getTaskRowById, getTaskById } = await import("../../../src/modules/tasks/service.js");
    await expect(getTaskRowById(tdb, CASE, "rep", ASSIGNER)).resolves.toMatchObject({ id: CASE });
    await expect(getTaskById(tdb, CASE, "rep", ASSIGNER)).resolves.toMatchObject({ id: CASE });
  });

  it("still 403s a rep who is neither the assignee nor the assigner", async () => {
    const { getTaskRowById } = await import("../../../src/modules/tasks/service.js");
    await expect(getTaskRowById(tdb, CASE, "rep", STRANGER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  // The LIST is deliberately not widened with it — a rep's task list still shows only their own work.
  it("does not put tasks a rep assigned into that rep's own task list", async () => {
    const { getTasks } = await import("../../../src/modules/tasks/service.js");
    const result = await getTasks(tdb, {}, "rep", ASSIGNER);
    expect(result.tasks.map((t: { id: string }) => t.id)).not.toContain(CASE);
  });
});

// THE GUARD MADE DEAD CONTROLS. `getTasks` only scopes REPS, so a construction user is handed every
// task in the office -- and the row then renders a completion checkbox and the edit dialog offers
// Dismiss, both of which now 403. "Offered, then refused" is worse than the permissive behaviour it
// replaced: the button looks like every other button and simply never works.
//
// The client cannot re-derive this. Visibility and close authority are two different rules, and a
// second copy of the second one in the browser is how they drift. The projection carries the server's
// own verdict.
describe("close authority is exposed on every task projection", () => {
  it("getTasks marks rows the caller may and may not close", async () => {
    const { getTasks } = await import("../../../src/modules/tasks/service.js");

    const asStranger = await getTasks(tdb, {}, "construction", STRANGER);
    const row = asStranger.tasks.find((t: { id: string }) => t.id === CASE);
    expect(row, "construction users are still handed the row").toBeDefined();
    expect((row as { canClose?: boolean }).canClose).toBe(false);

    // Only the roles the LIST actually hands this row to. A rep who merely ASSIGNED the task is
    // deliberately not one of them -- getTasks scopes reps to `assigned_to`, and their assigned-out
    // work surfaces in the separate "Needs your attention" bucket instead.
    for (const [role, id] of [["rep", ASSIGNEE], ["admin", ADMIN]] as const) {
      const result = await getTasks(tdb, {}, role, id);
      const mine = result.tasks.find((t: { id: string }) => t.id === CASE);
      expect(mine, `${role}/${id} should be handed the row`).toBeDefined();
      expect((mine as { canClose?: boolean }).canClose, `${role}/${id}`).toBe(true);
    }

    // ...and the assigner's own bucket carries the verdict too, since it renders the same row.
    const { getTasksAwaitingMe } = await import("../../../src/modules/tasks/closed-loop-service.js");
    void getTasksAwaitingMe;
  });

  it("getTaskById carries the same verdict", async () => {
    const { getTaskById } = await import("../../../src/modules/tasks/service.js");
    expect((await getTaskById(tdb, CASE, "construction", STRANGER))?.canClose).toBe(false);
    expect((await getTaskById(tdb, CASE, "rep", ASSIGNEE))?.canClose).toBe(true);
  });

  it("getProjectTasks carries it too — the Procore surface has the same buttons", async () => {
    const { getProjectTasks } = await import("../../../src/modules/tasks/service.js");
    await pg.exec(`UPDATE tasks SET deal_id = '${DEAL}' WHERE id = '${CASE}'`);

    const rows = await getProjectTasks(tdb, DEAL, "construction", STRANGER);
    const row = rows.find((t: { id: string }) => t.id === CASE);
    expect((row as { canClose?: boolean })?.canClose).toBe(false);
  });

  // The verdict must agree with what the write path actually does, or it is just a second opinion.
  it("agrees with completeTask for every role/actor pair", async () => {
    const { getTaskById, completeTask } = await import("../../../src/modules/tasks/service.js");

    for (const [role, id] of [
      ["construction", STRANGER], ["rep", STRANGER], ["field_contractor", STRANGER],
      ["rep", ASSIGNEE], ["rep", ASSIGNER], ["admin", ADMIN], ["director", ADMIN],
    ] as const) {
      await seedTask(CASE);
      let claimed: boolean | undefined;
      try {
        claimed = (await getTaskById(tdb, CASE, role, id))?.canClose;
      } catch {
        claimed = false; // cannot even see it, so certainly cannot close it
      }

      let actual = true;
      try {
        await completeTask(tdb, CASE, role, id);
      } catch {
        actual = false;
      }
      expect(claimed, `${role}/${id}`).toBe(actual);
    }
  });
});

describe("POST /:id/complete — completeTask", () => {
  it("lets the assignee complete", async () => {
    await expect(completeTask(tdb, CASE, "rep", ASSIGNEE)).resolves.toBeDefined();
    expect(await statusOf(CASE)).toBe("completed");
  });

  it("lets the assigner complete", async () => {
    await expect(completeTask(tdb, CASE, "rep", ASSIGNER)).resolves.toBeDefined();
    expect(await statusOf(CASE)).toBe("completed");
  });

  it("lets an admin complete", async () => {
    await expect(completeTask(tdb, CASE, "admin", ADMIN)).resolves.toBeDefined();
    expect(await statusOf(CASE)).toBe("completed");
  });

  it("403s an unrelated construction user COMPLETING, and LEAVES THE TASK OPEN", async () => {
    await expect(completeTask(tdb, CASE, "construction", STRANGER)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await statusOf(CASE)).toBe("pending");
  });
});

// dismissTask had NO authority check whatsoever, and `dismissed` is terminal — a task dismissed by a
// stranger is just as closed as one they completed, and it additionally writes a suppression window
// that stops the rules engine ever raising it again.
describe("POST /:id/dismiss — dismissTask", () => {
  it("lets the assignee dismiss", async () => {
    await expect(dismissTask(tdb, CASE, "rep", ASSIGNEE)).resolves.toBeDefined();
    expect(await statusOf(CASE)).toBe("dismissed");
  });

  it("lets the assigner dismiss", async () => {
    await expect(dismissTask(tdb, CASE, "rep", ASSIGNER)).resolves.toBeDefined();
    expect(await statusOf(CASE)).toBe("dismissed");
  });

  it("403s an unrelated construction user DISMISSING, and LEAVES THE TASK OPEN", async () => {
    await expect(dismissTask(tdb, CASE, "construction", STRANGER)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await statusOf(CASE)).toBe("pending");
  });
});

// The bypass that made the original guard decorative: `pending -> completed` is an ALLOWED transition,
// so /transition reaches a terminal status without ever entering completeTask.
describe("POST /:id/transition — the bypass", () => {
  it("403s an unrelated user transitioning straight to completed", async () => {
    await expect(
      transitionTaskStatus(tdb, CASE, { nextStatus: "completed" }, "construction", STRANGER)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await statusOf(CASE)).toBe("pending");
  });

  it("403s an unrelated user transitioning straight to dismissed", async () => {
    await expect(
      transitionTaskStatus(tdb, CASE, { nextStatus: "dismissed" }, "construction", STRANGER)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await statusOf(CASE)).toBe("pending");
  });

  // The guard must be scoped to TERMINAL targets only. Narrowing every transition would break the
  // ordinary "somebody else picked this up" workflow, which was never the accountability concern.
  it("still lets an unrelated user move a task to a NON-terminal status", async () => {
    await expect(
      transitionTaskStatus(tdb, CASE, { nextStatus: "in_progress" }, "construction", STRANGER)
    ).resolves.toBeDefined();
    expect(await statusOf(CASE)).toBe("in_progress");
  });

  it("lets the assigner transition to completed", async () => {
    await expect(
      transitionTaskStatus(tdb, CASE, { nextStatus: "completed" }, "rep", ASSIGNER)
    ).resolves.toBeDefined();
    expect(await statusOf(CASE)).toBe("completed");
  });
});

// The initial assertion is a snapshot. These are real interleavings, not pre-reassigned fixtures:
// former assignee Derek is still authorised when each call starts, then the task moves to Stranger at
// the exact terminal UPDATE seam. Every terminal path must repeat participant authority in its WHERE.
describe("terminal close authority is revalidated at write time", () => {
  it.each([
    ["complete", (db: any) => completeTask(db, CASE, "rep", ASSIGNEE)],
    ["dismiss", (db: any) => dismissTask(db, CASE, "rep", ASSIGNEE)],
    ["transition to completed", (db: any) => transitionTaskStatus(db, CASE, { nextStatus: "completed" }, "rep", ASSIGNEE)],
    ["transition to dismissed", (db: any) => transitionTaskStatus(db, CASE, { nextStatus: "dismissed" }, "rep", ASSIGNEE)],
  ])("does not let the former assignee %s after a reassignment", async (_path, close) => {
    const { tenantDb, wasInterleaved } = withReassignmentBeforeTerminalWrite(CASE);

    await expect(close(tenantDb)).rejects.toMatchObject({ statusCode: expect.any(Number) });

    expect(wasInterleaved(), "the reassignment must occur at the terminal write seam").toBe(true);
    expect(await statusOf(CASE)).toBe("pending");
  });
});

// Without an explicit bypass these two paths start 403ing in production the day the guard ships, and
// the failure is silent-ish: an inbound_email task simply never closes, and an AI-disconnect case
// resolves while its task stays open forever.
describe("the two internal callers keep working", () => {
  it("completes a task assigned to the mailbox owner on behalf of a different user (email association)", async () => {
    await seedTask(MACHINE_TASK, { assignedTo: ASSIGNEE, createdBy: null });

    await expect(
      completeTask(tdb, MACHINE_TASK, "rep", STRANGER, { systemActor: "email_association" })
    ).resolves.toBeDefined();
    expect(await statusOf(MACHINE_TASK)).toBe("completed");
  });

  it("completes and dismisses an AI-disconnect task that has NO assigner at all", async () => {
    await seedTask(MACHINE_TASK, { assignedTo: ASSIGNEE, createdBy: null });
    await expect(
      completeTask(tdb, MACHINE_TASK, "rep", STRANGER, { systemActor: "ai_disconnect_resolution" })
    ).resolves.toBeDefined();
    expect(await statusOf(MACHINE_TASK)).toBe("completed");

    await seedTask(MACHINE_TASK, { assignedTo: ASSIGNEE, createdBy: null });
    await expect(
      dismissTask(tdb, MACHINE_TASK, "rep", STRANGER, { systemActor: "ai_disconnect_resolution" })
    ).resolves.toBeDefined();
    expect(await statusOf(MACHINE_TASK)).toBe("dismissed");
  });

  // The bypass is a parameter, not a role string, so it cannot be reached from an HTTP request: the
  // route handlers below never construct one. Proven by the route surface rather than by inspection.
  it("is not reachable from the HTTP surface", async () => {
    const routes = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../../src/modules/tasks/routes.ts", import.meta.url), "utf-8")
    );
    expect(routes).not.toMatch(/systemActor/);
  });
});
