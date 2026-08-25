// REAL-SQL (PGlite) proof that the rules engine stamps `source = 'automated'` on what it writes.
//
// The rules engine is the largest automated writer in the system (25 rules), and it inserts through TWO
// separate code paths that have to agree: a raw INSERT built by hand for the tenant-client case, and a
// Drizzle insert for the tenantDb case. They are edited independently, which is exactly how one of them
// ends up on the column default while the other is explicit.
//
// Both are EXECUTED here rather than string-matched. A test that greps the SQL for "source" cannot tell
// the new column from the `source_rule` / `source_event` columns already sitting next to it in the same
// statement, and it would keep passing if the value bound to it were wrong or the statement no longer
// parsed at all.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { tasks } from "@trock-crm/shared/schema";
import {
  createTenantTaskRulePersistence,
  createDrizzleTaskRulePersistence,
} from "../../../src/modules/tasks/rules/persistence.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

const OFFICE = "00000000-0000-0000-0000-0000000000f1";
const USER = "00000000-0000-0000-0000-0000000000a1";

function draft(dedupeKey: string) {
  return {
    title: `Follow up on ${dedupeKey}`,
    description: "Raised by a rule, not by a person.",
    type: "system",
    priority: "high",
    priorityScore: 10,
    status: "pending",
    assignedTo: USER,
    officeId: OFFICE,
    originRule: "stale_deal",
    sourceRule: "stale_deal",
    sourceEvent: "deal.updated",
    dedupeKey,
    reasonCode: "stale_deal",
    entitySnapshot: { entityId: dedupeKey },
    metadata: {},
    dealId: null,
    contactId: null,
    emailId: null,
    dueAt: null,
  } as never;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [tasks]));
  // The raw path also selects a priority_score column that the rules schema carries in prod.
  await pg.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority_score integer;`);
  await pg.exec(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS metadata jsonb;`);
  // THE DEFAULT IS DROPPED HERE ON PURPOSE, and it is what gives these tests teeth.
  //
  // With `DEFAULT 'automated'` in place, a writer that forgets the column produces a row reading
  // 'automated' anyway, and an assertion on the stored value passes identically whether the code set it
  // or the database did — a guard that cannot fire. Removing the default makes an omission a NOT NULL
  // violation instead, so these tests fail loudly for the one thing they exist to catch.
  //
  // It also rehearses the end state: the migration keeps the DEFAULT only to cover the window where the
  // API has migrated and the worker has not, and a follow-up drops it once every writer is deployed.
  // These two paths are proven ready for that here.
  await pg.exec(`ALTER TABLE tasks ALTER COLUMN source DROP DEFAULT;`);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

async function sourceOf(dedupeKey: string) {
  const result = await pg.query<{ source: string }>(
    `SELECT source FROM tasks WHERE dedupe_key = $1`,
    [dedupeKey]
  );
  expect(result.rows, dedupeKey).toHaveLength(1);
  return result.rows[0].source;
}

describe("rules engine task writes are recorded as automated", () => {
  it("the raw-SQL insert path stamps 'automated'", async () => {
    const persistence = createTenantTaskRulePersistence(pg as never, "public");

    await persistence.insertTask(draft("deal:raw-1"));

    expect(await sourceOf("deal:raw-1")).toBe("automated");
  });

  it("the Drizzle insert path stamps 'automated'", async () => {
    const persistence = createDrizzleTaskRulePersistence(tdb);

    await persistence.insertTask(draft("deal:drizzle-1"));

    expect(await sourceOf("deal:drizzle-1")).toBe("automated");
  });

  // The two paths write the same row through different code. If they disagree on this column, the same
  // rule files its task into a different tab depending on which caller ran it.
  it("both paths agree, so a rule's tab does not depend on which caller ran it", async () => {
    expect(await sourceOf("deal:raw-1")).toBe(await sourceOf("deal:drizzle-1"));
  });
});
