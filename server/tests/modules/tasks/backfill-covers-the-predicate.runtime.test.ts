// The backfill and the eligibility predicate are ONE decision written in two languages, and this is the
// test that stops them drifting apart.
//
// Migration 0235 seeds the acknowledgement table so that nothing already on somebody's plate is treated
// as new. The predicate decides what "new" means. If the predicate admits a status the backfill did not
// seed, then on the morning of the deploy every pre-existing task in that status is suddenly unseen and
// they all pop at once — five per login, for as many logins as it takes to drain. That is exactly the
// failure the backfill exists to prevent, reintroduced by widening one half of a pair.
//
// It is a live risk rather than a hypothetical: first-time visibility was deliberately widened from
// `pending` to also cover in_progress / waiting_on / blocked so that a REASSIGNED active task reaches
// its new assignee. Had the backfill stayed on `WHERE status = 'pending'`, every in-flight task in
// production would have been reclassified as a brand-new assignment.
//
// SO THIS EXECUTES BOTH HALVES AGAINST ONE DATABASE rather than comparing two WHERE clauses by eye.
// A grep-style test that matched the status lists as text would still pass if the two agreed on
// statuses and disagreed on anything else — the assignee column, the source filter, a typo in a status
// name. Seeding one task per status, running the real migration from disk, and then asking the real
// query what it considers new is the only version that cannot be fooled.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { tasks } from "@trock-crm/shared/schema";
import { getPendingAssignmentTasks } from "../../../src/modules/tasks/service.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { migrationSql } from "../../helpers/migration-sql.js";
import { runTaskAssignmentAcknowledgementsMigration } from "../../../src/migrations/task-assignment-acknowledgements.js";
import { runTasksAssignedAtBackfill } from "../../../src/migrations/tasks-assigned-at-backfill.js";

const SCHEMA = "office_dallas";

const uid = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, "0")}`;
const ALICE = uid("a1");
const BOB = uid("b1");

/** Every status the schema allows. The point is to seed ALL of them, not a chosen subset. */
const ALL_STATUSES = [
  "pending",
  "scheduled",
  "in_progress",
  "waiting_on",
  "blocked",
  "completed",
  "dismissed",
] as const;

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA};`);
  // The tenant table comes from the REAL Drizzle definition, in a real office_* schema, so the
  // migration's own tenant loop finds it exactly as it would in production.
  await pg.exec(tenantSchemaSql(SCHEMA, [tasks]));
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY, display_name varchar(255));
    INSERT INTO public.users (id, display_name) VALUES ('${BOB}', 'Adam Shaw'), ('${ALICE}', 'Alice Rep');

    -- 0001 puts BOTH of these on every tenant tasks table, and 0239 disables them around its backfill
    -- UNCONDITIONALLY -- deliberately, so a tenant somehow missing them aborts the deploy loudly rather
    -- than letting the backfill run with set_tasks_updated_at live and silently rewrite every contact's
    -- "Last touch". A fixture without them would not be modelling production, and the migration would
    -- fail here for a reason that has nothing to do with what this suite is testing.
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $fn$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $fn$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION audit_trigger_probe() RETURNS TRIGGER AS $fn$
    BEGIN RETURN NEW; END;
    $fn$ LANGUAGE plpgsql;

    CREATE TRIGGER set_tasks_updated_at
      BEFORE UPDATE ON ${SCHEMA}.tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER audit_tasks
      AFTER INSERT OR UPDATE OR DELETE ON ${SCHEMA}.tasks
      FOR EACH ROW EXECUTE FUNCTION audit_trigger_probe();
  `);

  // One PRE-EXISTING task per status, every one of them a genuine assignment from somebody else, and
  // every one urgent and overdue — the shape most likely to be considered eligible. If any status is
  // going to slip past the backfill, this is the fixture that catches it.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  for (const [index, status] of ALL_STATUSES.entries()) {
    await pg.query(
      `INSERT INTO ${SCHEMA}.tasks (id, title, type, priority, status, assigned_to, created_by, due_date, source, is_test_data)
       VALUES ($1, $2, 'manual', 'urgent', $3, $4, $5, $6, 'manual', false)`,
      [uid(String(index + 1)), `pre-existing ${status}`, status, ALICE, BOB, yesterday]
    );
  }

  // Both migrations in the exact order runner.ts applies them — INCLUDING BOTH runner steps. The 0235
  // SQL file deliberately contains only the office-provisioner template; existing offices get their
  // table and historical seed from its per-office step. Omitting that step would exercise a table with
  // no historical acknowledgements, which is not a deployable 0235 state at all.
  await runTaskAssignmentAcknowledgementsMigration(
    pg as unknown as Parameters<typeof runTaskAssignmentAcknowledgementsMigration>[0]
  );
  await pg.exec(migrationSql("0235_task_assignment_acknowledgements"));

  // 0239's step is likewise not optional decoration: its file only adds the column, so skipping it
  // would leave every pre-existing row dated now() by the default, post-date 0235's seed, and make
  // every historical acknowledgement stale. Running without it would prove nothing about the deployed
  // sequence.
  await pg.exec(migrationSql("0239_tasks_assigned_at"));
  await runTasksAssignedAtBackfill(pg as unknown as Parameters<typeof runTasksAssignedAtBackfill>[0]);

  await pg.exec(`SET search_path = ${SCHEMA}, public;`);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg.close();
});

describe("migration 0235's backfill covers everything the predicate calls new", () => {
  it("treats NO pre-existing task as a new assignment, in any status", async () => {
    const result = await getPendingAssignmentTasks(tdb, ALICE);

    const wronglyNew = result.tasks.filter((task) => task.isNew).map((task) => task.title);
    expect(
      wronglyNew,
      "a status the predicate admits but the backfill did not seed — these would all pop on deploy"
    ).toEqual([]);
    expect(result.newTotal).toBe(0);
  });

  it("seeded an ack row for every status first-time visibility can reach", async () => {
    const seeded = await pg.query<{ status: string }>(
      `SELECT t.status
         FROM ${SCHEMA}.task_assignment_acknowledgements a
         JOIN ${SCHEMA}.tasks t ON t.id = a.task_id
        WHERE a.user_id = $1
        ORDER BY t.status`,
      [ALICE]
    );
    const seededStatuses = seeded.rows.map((row) => row.status);

    // Asserted as a SUPERSET rather than an exact match: seeding more than the predicate can reach is
    // harmless (an ack row for a completed task is inert), whereas seeding less is the deploy-day bug.
    for (const status of ["pending", "in_progress", "waiting_on", "blocked"]) {
      expect(seededStatuses, `status ${status} must be seeded`).toContain(status);
    }
  });

  // THE TWO MIGRATIONS HAVE TO AGREE WITH EACH OTHER TOO. 0235 seeds acknowledged_at = now(); 0239
  // dates assigned_at from created_at. If 0239 had used now() instead, every seeded acknowledgement
  // would be older than the assignment it was meant to answer, every pre-existing task would count as
  // a fresh handoff, and the backfill would have caused precisely the flood it exists to prevent.
  it("leaves every seeded acknowledgement NEWER than the assignment it answers", async () => {
    const stale = await pg.query<{ title: string }>(
      `SELECT t.title
         FROM ${SCHEMA}.tasks t
         JOIN ${SCHEMA}.task_assignment_acknowledgements a
           ON a.task_id = t.id AND a.user_id = t.assigned_to
        WHERE a.acknowledged_at < t.assigned_at`
    );
    expect(stale.rows.map((row) => row.title), "0239 post-dated 0235's seed").toEqual([]);
  });

  it("still lets a task created AFTER the migration through as new", async () => {
    // The backfill has to mean "nothing pre-existing", not "nothing ever". A migration that seeded the
    // whole table unconditionally would pass every assertion above and ship a modal that never fires.
    await pg.query(
      `INSERT INTO ${SCHEMA}.tasks (id, title, type, priority, status, assigned_to, created_by, source, is_test_data)
       VALUES ($1, 'assigned after the deploy', 'manual', 'normal', 'pending', $2, $3, 'manual', false)`,
      [uid("99"), ALICE, BOB]
    );

    const result = await getPendingAssignmentTasks(tdb, ALICE);

    expect(result.tasks.filter((task) => task.isNew).map((task) => task.title)).toEqual([
      "assigned after the deploy",
    ]);
    expect(result.newTotal).toBe(1);
  });
});
