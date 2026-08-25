// REAL-SQL proof for what a USER MERGE does to a task's assigner.
//
// EXECUTED, NOT GREPPED. The sibling branch caught exactly this on the same function: a substring
// assertion over the SQL text passes against a statement that never runs, so the only way to know
// what a merge does to `last_assigned_by` is to run it and read the row back.
//
// THE DECISION THIS PINS. `reassignOwnerRecords` moves `assigned_to` from a user being merged away to
// the merge target — so the task changes hands, and the sibling's `assigned_at` is re-stamped. The
// question is what `last_assigned_by` becomes, and both obvious answers are wrong:
//
//   * the merge target — it is the new ASSIGNEE. Making them their own assigner means every reply
//     they write is a self-reply, which the loop deliberately does not notify anyone about, so the
//     loop would go silently dead on precisely the tasks a merge just touched.
//   * NULL — that reads as "never reassigned", which resolves the assigner back to `created_by`. On a
//     task that HAD been reassigned this silently re-points the loop at the original creator, which
//     is the defect the column was added to fix.
//
// So it is left ALONE: an account merge is not somebody deciding to hand work over. Whoever last
// assigned the task is still the person waiting on it, and if that identity is the one being merged
// away the loop already reports `assigner_inactive` and declines to mail them.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const uid = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, "0")}`;

const MERGED_AWAY = uid("a1");
const MERGE_TARGET = uid("a2");
const ASSIGNER = uid("a3");
const CREATOR = uid("a4");

const REASSIGNED_TASK = uid("b1"); // has changed hands: last_assigned_by is set
const VIRGIN_TASK = uid("b2"); // never reassigned: last_assigned_by is NULL

let pg: PGlite;

/**
 * The task UPDATE `reassignOwnerRecords` runs, taken from the script itself so this suite cannot pass
 * against a statement the script no longer contains.
 */
function taskReassignSql(): string {
  const source = readFileSync(
    join(process.cwd(), "..", "scripts", "reconcileUsers.ts"),
    "utf-8"
  );
  const match = source.match(
    /UPDATE \$\{schemaName\}\.tasks SET ([^`]*?) WHERE assigned_to = \$1 RETURNING/
  );
  if (!match) throw new Error("reassignOwnerRecords' task UPDATE not found — has it been renamed?");
  return match[1]!.trim();
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE SCHEMA office_dallas;
    CREATE TABLE public_users (id uuid PRIMARY KEY);
    CREATE TABLE office_dallas.tasks (
      id uuid PRIMARY KEY,
      title varchar(500) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending',
      assigned_to uuid,
      created_by uuid,
      last_assigned_by uuid,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}, 30000);

afterAll(async () => { await pg?.close?.(); });

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM office_dallas.tasks;
    INSERT INTO office_dallas.tasks (id, title, assigned_to, created_by, last_assigned_by) VALUES
      ('${REASSIGNED_TASK}', 'Handed over once', '${MERGED_AWAY}', '${CREATOR}', '${ASSIGNER}'),
      ('${VIRGIN_TASK}',     'Never reassigned', '${MERGED_AWAY}', '${CREATOR}', NULL);
  `);
});

async function runMerge() {
  // The script's own SET clause, against the merge pair.
  await pg.exec(
    `UPDATE office_dallas.tasks SET ${taskReassignSql()
      .replace(/\$2/g, `'${MERGE_TARGET}'`)
      .replace(/NOW\(\)/g, "NOW()")} WHERE assigned_to = '${MERGED_AWAY}'`
  );
}

async function taskRow(id: string) {
  const r = await pg.query<{ assigned_to: string; last_assigned_by: string | null }>(
    `SELECT assigned_to, last_assigned_by FROM office_dallas.tasks WHERE id = $1`, [id]
  );
  return r.rows[0]!;
}

describe("a user merge and the task assigner", () => {
  it("moves the ASSIGNEE to the merge target", async () => {
    await runMerge();
    expect((await taskRow(REASSIGNED_TASK)).assigned_to).toBe(MERGE_TARGET);
    expect((await taskRow(VIRGIN_TASK)).assigned_to).toBe(MERGE_TARGET);
  });

  // THE ONE THAT MATTERS.
  it("leaves last_assigned_by ALONE — a merge is not somebody handing work over", async () => {
    await runMerge();

    const reassigned = await taskRow(REASSIGNED_TASK);
    expect(reassigned.last_assigned_by, "the prior assigner is still the one waiting").toBe(ASSIGNER);
    // NOT the merge target: that is the new assignee, and making them their own assigner turns every
    // reply into a self-reply the loop deliberately notifies nobody about.
    expect(reassigned.last_assigned_by).not.toBe(MERGE_TARGET);
    // NOT NULL either: that reads as "never reassigned" and silently re-points the loop at created_by.
    expect(reassigned.last_assigned_by).not.toBeNull();
  });

  it("leaves a never-reassigned task NULL, so it still resolves to its creator", async () => {
    await runMerge();
    expect((await taskRow(VIRGIN_TASK)).last_assigned_by).toBeNull();
  });

  // Executed rather than asserted on text: this is the statement the script actually runs, and if it
  // ever starts naming last_assigned_by the tests above change meaning without changing wording.
  it("does not mention last_assigned_by in the statement at all", () => {
    expect(taskReassignSql()).not.toContain("last_assigned_by");
  });
});
