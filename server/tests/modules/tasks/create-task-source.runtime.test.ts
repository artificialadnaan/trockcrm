// REAL-SQL (PGlite) proof that the API's human task constructor records `source = 'manual'`.
//
// WHY THIS LIVES IN THE SCHEMA PR RATHER THAN THE WRITE-SITES PR. The API container runs migrations and
// only then starts serving (`Dockerfile`: `node server/dist/migrations/runner.js && node
// server/dist/index.js`), so `source` cannot be missing when this code executes — the column and this
// writer ship together safely. The WORKER is the deploy hazard: `Dockerfile.worker` has no migrate step
// and deploys separately, so worker code naming `source` before the API has migrated would fail on the
// unknown column. Those write sites ship in the follow-up instead.
//
// The reason it matters that this one is NOT deferred: `createTask` is the only path a person's typed
// task takes. Left to the column DEFAULT of 'automated' for even one deploy, every manually created
// task in that window is permanently misfiled — the backfill only classifies rows that existed when the
// migration ran, so nothing repairs them afterwards, and they are precisely the tasks this feature
// exists to surface.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { tasks } from "@trock-crm/shared/schema";
import { createTask } from "../../../src/modules/tasks/service.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const USER = "00000000-0000-0000-0000-0000000000a1";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [tasks]));
  // THE DEFAULT IS DROPPED ON PURPOSE, and it is what gives this test teeth. With `DEFAULT 'automated'`
  // in place a writer that forgets the column still produces a row reading 'automated', and asserting
  // the stored value would pass whether the code set it or the database did — a guard that cannot fire.
  // Without the default, omitting it is a NOT NULL violation instead. It also rehearses the end state:
  // the migration keeps the DEFAULT only to cover the window where the API has migrated and the worker
  // has not, and a follow-up drops it once every writer is deployed.
  await pg.exec(`ALTER TABLE tasks ALTER COLUMN source DROP DEFAULT;`);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

describe("createTask records who made the task", () => {
  it("writes 'manual' — read straight from the row, not through a projection", async () => {
    const created = await createTask(tdb, {
      title: "Call the client back",
      type: "manual",
      assignedTo: USER,
      createdBy: USER,
    });

    const stored = await pg.query<{ source: string }>(
      `SELECT source FROM tasks WHERE id = $1`,
      [created.id]
    );
    expect(stored.rows[0]?.source).toBe("manual");
  });

  it("does not depend on the caller supplying it", async () => {
    // The three callers are all a person filling in a form and none of them passes `source`; the value
    // is decided inside createTask precisely so no route can get it wrong.
    const created = await createTask(tdb, {
      title: "Second task",
      type: "follow_up",
      assignedTo: USER,
    });

    const stored = await pg.query<{ source: string }>(
      `SELECT source FROM tasks WHERE id = $1`,
      [created.id]
    );
    expect(stored.rows[0]?.source).toBe("manual");
  });
});
