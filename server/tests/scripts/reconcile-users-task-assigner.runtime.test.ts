// REAL-SQL proof for the two task identities a USER MERGE must reconcile.
//
// `assigned_to` says who owns the work. `COALESCE(last_assigned_by, created_by)` says who receives an
// assignee's reply. A source account can be only the second identity — it assigned work to somebody
// else — so a merge that moves only assigned_to leaves replies targeting a deactivated user forever.
// Execute the script's own UPDATE clauses: source-text assertions alone have previously passed against
// a statement that was never run.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const uid = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, "0")}`;

const MERGED_AWAY = uid("a1");
const MERGE_TARGET = uid("a2");
const ASSIGNEE = uid("a3");
const PRIOR_ASSIGNER = uid("a4");
const HISTORICAL_CREATOR = uid("a5");

const ASSIGNED_OUT_FROM_CREATOR = uid("b1");
const ASSIGNED_OUT_FROM_REASSIGNMENT = uid("b2");
const INCOMING_FROM_ANOTHER_ASSIGNER = uid("b3");
const REPLACEMENT_SELF_ASSIGNMENT = uid("b4");

let pg: PGlite;

type TaskUpdate = { setClause: string; whereClause: string };

/** The two task UPDATEs in reassignOwnerRecords, extracted from the actual script under test. */
function taskMergeUpdates(): TaskUpdate[] {
  const source = readFileSync(
    join(process.cwd(), "..", "scripts", "reconcileUsers.ts"),
    "utf-8"
  );
  const updates = [...source.matchAll(
    /UPDATE \$\{schemaName\}\.tasks\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*?)\s+RETURNING id, title, status/g
  )].map((match) => ({ setClause: match[1]!.trim(), whereClause: match[2]!.trim() }));

  if (updates.length !== 2) {
    throw new Error(`Expected the two task merge UPDATEs, found ${updates.length}`);
  }
  return updates;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE SCHEMA office_dallas;
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
      -- Source created this task for another person, so created_by is the resolved assigner.
      ('${ASSIGNED_OUT_FROM_CREATOR}', 'Source assigned this out', '${ASSIGNEE}', '${MERGED_AWAY}', NULL),
      -- Same outcome when the source was recorded as a later reassigner instead of the creator.
      ('${ASSIGNED_OUT_FROM_REASSIGNMENT}', 'Source reassigned this out', '${ASSIGNEE}', '${HISTORICAL_CREATOR}', '${MERGED_AWAY}'),
      -- Source only owns this one; a different person remains the reply recipient after reassignment.
      ('${INCOMING_FROM_ANOTHER_ASSIGNER}', 'Incoming work', '${MERGED_AWAY}', '${HISTORICAL_CREATOR}', '${PRIOR_ASSIGNER}'),
      -- Replacement takes both sides of a source self-assignment. It is intentionally self-addressed.
      ('${REPLACEMENT_SELF_ASSIGNMENT}', 'Source self assignment', '${MERGED_AWAY}', '${MERGED_AWAY}', NULL);
  `);
});

async function runMerge() {
  for (const { setClause, whereClause } of taskMergeUpdates()) {
    const bind = (clause: string) => clause
      .replace(/\$1/g, `'${MERGED_AWAY}'`)
      .replace(/\$2/g, `'${MERGE_TARGET}'`)
      .replace(/NOW\(\)/g, "NOW()");
    await pg.exec(`UPDATE office_dallas.tasks SET ${bind(setClause)} WHERE ${bind(whereClause)}`);
  }
}

async function taskRow(id: string) {
  const result = await pg.query<{
    assigned_to: string;
    created_by: string | null;
    last_assigned_by: string | null;
  }>(
    `SELECT assigned_to, created_by, last_assigned_by FROM office_dallas.tasks WHERE id = $1`, [id]
  );
  return result.rows[0]!;
}

describe("a user merge and task reply loops", () => {
  it("transfers the source's resolved assigner role on tasks they assigned to somebody else", async () => {
    await runMerge();

    for (const id of [ASSIGNED_OUT_FROM_CREATOR, ASSIGNED_OUT_FROM_REASSIGNMENT]) {
      const row = await taskRow(id);
      expect(row.assigned_to, "the existing assignee keeps the work").toBe(ASSIGNEE);
      expect(row.last_assigned_by, "the active replacement receives future replies").toBe(MERGE_TARGET);
    }
  });

  it("preserves created_by as historical attribution while transferring a creator-resolved loop", async () => {
    await runMerge();
    const row = await taskRow(ASSIGNED_OUT_FROM_CREATOR);

    expect(row.created_by, "who originally created the task never changes").toBe(MERGED_AWAY);
    expect(row.last_assigned_by, "routing moves without rewriting history").toBe(MERGE_TARGET);
  });

  it("moves a retiring assignee without stealing a different active assigner's loop", async () => {
    await runMerge();
    const row = await taskRow(INCOMING_FROM_ANOTHER_ASSIGNER);

    expect(row.assigned_to).toBe(MERGE_TARGET);
    expect(row.last_assigned_by).toBe(PRIOR_ASSIGNER);
    expect(row.created_by).toBe(HISTORICAL_CREATOR);
  });

  it("makes a replacement self-assignment explicit instead of leaving its resolved assigner inactive", async () => {
    await runMerge();
    const row = await taskRow(REPLACEMENT_SELF_ASSIGNMENT);

    expect(row.assigned_to).toBe(MERGE_TARGET);
    expect(row.last_assigned_by).toBe(MERGE_TARGET);
    // The old account remains the historical creator even though the replacement is now both sides
    // of this task. The loop's normal self-reply suppression handles that intentionally.
    expect(row.created_by).toBe(MERGED_AWAY);
  });

  it("keeps separate UPDATEs for assigner-only transfers and assignee ownership moves", () => {
    const updates = taskMergeUpdates();
    expect(updates[0]!.whereClause).toContain("COALESCE(last_assigned_by, created_by) = $1");
    expect(updates[0]!.whereClause).toContain("IS DISTINCT FROM $1");
    expect(updates[1]!.whereClause).toBe("assigned_to = $1");
    expect(updates[1]!.setClause).toContain("last_assigned_by = CASE");
  });
});
