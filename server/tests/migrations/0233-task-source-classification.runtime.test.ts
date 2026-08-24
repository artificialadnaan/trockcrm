// Executes migration 0233 FROM DISK against a real Postgres (PGlite).
//
// 0233 adds `tasks.source` ('manual' | 'automated') and backfills it. Three properties are worth proving
// rather than assuming, and one of them is the reason this suite exists at all:
//
//   1. THE BACKFILL MUST NOT TOUCH `updated_at`. `tasks` carries `set_tasks_updated_at` (0001:858), and
//      the contacts list reads MAX(tasks.updated_at) directly as a contact's "Last touch"
//      (contacts/service.ts buildContactLastTouchAtSql), with the "Untouched 30d+" card and its
//      ?card=untouched drill both derived from that same expression. A backfill that lets the trigger
//      fire stamps EVERY contact's last touch with the migration timestamp -- the card, the drill and the
//      aggregate all move together, so nothing looks inconsistent enough to notice, and the original
//      values are gone. There is no undo. Hence the DISABLE TRIGGER wrapper, and hence the seeded row
//      below is deliberately one the backfill DOES rewrite: asserting on a row the backfill skips would
//      pass no matter what the migration did.
//   2. It touches EVERY office schema, not just office_dallas -- a tenant column-add that misses a schema
//      breaks every task write in that office on the unknown column.
//   3. The TENANT_SCHEMA_START/END block matches the loop. The office provisioner replays only that block
//      for offices created after this deploy, so drift leaves new offices silently missing the column.
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0233_task_source_classification";
const INDEX_NAME = "tasks_assigned_source_status_idx";

/**
 * THREE offices, deliberately. office_dallas is also written by the literal TENANT_SCHEMA block at the
 * foot of the file, so it comes out correct even if the tenant loop is broken -- a two-office fixture
 * (dallas + one) still passes with the loop clamped to a single schema, because the one schema the loop
 * does reach and the one the block reaches cover both. A third office has no second source: only the
 * loop can give it the column, the CHECK and the index.
 */
const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

/** A stable stand-in for a real user id, so `created_by IS NOT NULL` means "a human is recorded". */
const HUMAN = "11111111-1111-1111-1111-111111111111";
/** The moment every seeded row was last touched. Any trigger firing during the backfill moves this. */
const SEEDED_UPDATED_AT = "2020-01-02 03:04:05+00";

let pg: PGlite;

async function columnExists(schema: string, table: string, column: string) {
  const result = await pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schema, table, column]
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

/**
 * Keyed on `description`, not on `title` — two of the seeded shapes deliberately share the title
 * 'New Deal Assignment' (that collision is the thing being tested), so title cannot identify a row.
 */
async function sourceOf(schema: string, description: string) {
  const result = await pg.query<{ source: string }>(
    `SELECT source FROM ${schema}.tasks WHERE description = $1`,
    [description]
  );
  expect(result.rows, `fixture row "${description}"`).toHaveLength(1);
  return result.rows[0]?.source;
}

/**
 * The minimum shape 0233 needs: a tenant `tasks` table with the columns the backfill reads, plus BOTH
 * triggers 0001 puts on it. Seeding the triggers is the whole point -- without them the DISABLE/ENABLE
 * wrapper is untested and the updated_at assertion below could not fail.
 */
async function seedOffices(schemas: string[]) {
  await pg.exec(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $fn$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    CREATE TABLE IF NOT EXISTS public.audit_log_probe (
      id bigserial PRIMARY KEY,
      table_name text NOT NULL,
      action text NOT NULL
    );

    -- Stands in for audit_trigger_func(): 0001's real one writes a jsonb row per INSERT/UPDATE/DELETE.
    -- All this suite needs to know is whether it FIRED during the backfill.
    CREATE OR REPLACE FUNCTION audit_trigger_probe()
    RETURNS TRIGGER AS $fn$
    BEGIN
      INSERT INTO public.audit_log_probe (table_name, action) VALUES (TG_TABLE_NAME, TG_OP);
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);

  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title varchar(500) NOT NULL,
        description text,
        type varchar(50) NOT NULL DEFAULT 'manual',
        priority varchar(20) NOT NULL DEFAULT 'normal',
        status varchar(20) NOT NULL DEFAULT 'pending',
        assigned_to uuid,
        created_by uuid,
        origin_rule varchar(120),
        entity_snapshot jsonb,
        contact_id uuid,
        due_date date,
        is_test_data boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TRIGGER set_tasks_updated_at
        BEFORE UPDATE ON ${schema}.tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      CREATE TRIGGER audit_tasks
        AFTER INSERT OR UPDATE OR DELETE ON ${schema}.tasks
        FOR EACH ROW EXECUTE FUNCTION audit_trigger_probe();
    `);
  }
}

/**
 * One row per production write shape, titled after the site that writes it.
 *
 * `updated_at` is set in the INSERT, never by a follow-up UPDATE: `set_tasks_updated_at` is BEFORE
 * UPDATE and overwrites NEW.updated_at unconditionally, so an UPDATE could not put a past timestamp
 * there at all -- the fixture would silently seed NOW() and the assertion below would then be comparing
 * two values that only differ by however long the migration took.
 */
async function seedTaskShapes(schema: string) {
  await pg.exec(`
    INSERT INTO ${schema}.tasks (description, title, type, created_by, origin_rule, entity_snapshot, updated_at) VALUES
      -- rules engine (rules/persistence.ts): machine, no human recorded
      ('rule-engine', 'Deal has stalled', 'system', NULL, 'deal_stalled', NULL, '${SEEDED_UPDATED_AT}'),
      -- email assignment queue (worker email-sync.ts): machine, but stamps a REAL human on created_by
      ('email-queue', 'Classify email: Re: roof', 'inbound_email', '${HUMAN}', 'email_assignment_queue', NULL, '${SEEDED_UPDATED_AT}'),
      -- AI-disconnect cron (worker ai-disconnect-admin-tasks.ts): machine, and writes type 'manual'
      ('ai-disconnect', 'AI disconnect follow-up', 'manual', NULL, 'ai_disconnect_admin_task', NULL, '${SEEDED_UPDATED_AT}'),
      -- estimate-revision routing (deals/scoping-service.ts): machine, human created_by, type 'system'
      ('revision-routing', 'Address estimate revision', 'system', '${HUMAN}', 'deal_estimate_revision_requested', NULL, '${SEEDED_UPDATED_AT}'),
      -- a person typing a task into the New Task form (tasks/service.ts createTask)
      ('hand-typed', 'Call the roofer back', 'manual', '${HUMAN}', NULL, NULL, '${SEEDED_UPDATED_AT}'),
      -- reassignment task (assignment-tasks/service.ts): byte-identical to hand-typed EXCEPT for the
      -- fixed title and the assignedAt marker in entity_snapshot -- the two markers C4 separates it by
      ('assignment-task', 'New Deal Assignment', 'manual', '${HUMAN}', NULL,
        '{"entityType":"deal","assignedAt":"2024-05-01T00:00:00.000Z","actorUserId":"${HUMAN}"}',
        '${SEEDED_UPDATED_AT}'),
      -- a HUMAN task that merely happens to share the assignment title. It carries no assignedAt, so the
      -- entity_snapshot conjunct is what keeps it manual; without that conjunct this row misfiles.
      ('human-titled-like-assignment', 'New Lead Assignment', 'manual', '${HUMAN}', NULL, '{"note":"typed by hand"}', '${SEEDED_UPDATED_AT}'),
      -- the three-valued-logic trap: same title, but entity_snapshot IS NULL, so the jsonb key test is
      -- NULL rather than false. Without COALESCE the NOT(...) exclusion evaluates to NULL, the row
      -- matches nothing, and a person's task silently keeps the automated default.
      ('human-titled-null-snapshot', 'New Deal Assignment', 'manual', '${HUMAN}', NULL, NULL, '${SEEDED_UPDATED_AT}'),
      -- neither a rule nor a human: nothing identifies it, so it must keep the safe default
      ('orphan', 'Imported from somewhere', 'manual', NULL, NULL, NULL, '${SEEDED_UPDATED_AT}');

    DELETE FROM public.audit_log_probe;
  `);
}

beforeEach(async () => {
  pg = new PGlite();
});

describe("migration 0233 — tasks.source classification", () => {
  it("adds the column to EVERY office schema, not just the first", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      expect(await columnExists(schema, "tasks", "source"), schema).toBe(true);
    }
  });

  // The index this column serves is built by 0237, NOT here, and that separation is load-bearing: the
  // runner's CONCURRENTLY pre-step cannot build an index on a column that does not exist yet, so an
  // index in THIS file would be built inline — inside the single transaction the runner sends it as,
  // holding write-blocking locks across every office, on API boot. Asserted as an absence so the
  // blocking build cannot quietly come back. See 0237-tasks-assigned-source-status-index.runtime.test.
  it("builds NO index — that is 0237's job, for lock-safety reasons", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));

    const found = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_indexes WHERE indexname = $1`,
      [INDEX_NAME]
    );
    expect(found.rows[0]?.n).toBe(0);
  });

  // Executed, not grepped: a CHECK constraint that exists but does not constrain is the failure this
  // catches, and reading its definition out of the catalog could not tell the difference.
  //
  // Asserted in office_atlanta as well as office_dallas, and that is not padding. The TENANT_SCHEMA
  // block at the foot of the file is literal SQL against office_dallas, so it hands office_dallas the
  // constraint no matter what the tenant loop does -- a dallas-only assertion here stays green with the
  // loop's CHECK deleted, and then every office except the first ships unconstrained. office_atlanta can
  // only have got it from the loop.
  it("REJECTS a source outside the two allowed values, in EVERY office schema", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      await expect(
        pg.exec(`INSERT INTO ${schema}.tasks (title, source) VALUES ('bogus', 'imported')`),
        schema
      ).rejects.toThrow();

      // ...and still accepts both legitimate values.
      await expect(
        pg.exec(`INSERT INTO ${schema}.tasks (title, source) VALUES ('a', 'manual'), ('b', 'automated')`),
        schema
      ).resolves.toBeDefined();
    }
  });

  // Two offices for the same reason as the CHECK above: only office_atlanta exercises the loop.
  it("defaults new rows to 'automated' — the safer wrong answer for an unclassified row", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      await pg.exec(
        `INSERT INTO ${schema}.tasks (title, description) VALUES ('t', 'no source supplied')`
      );
      expect(await sourceOf(schema, "no source supplied"), schema).toBe("automated");
    }
  });

  it("classifies every known production task shape", async () => {
    await seedOffices(["office_dallas"]);
    await seedTaskShapes("office_dallas");
    await pg.exec(migrationSql(MIGRATION));

    // Four machine shapes. Note email-queue and revision-routing both carry a real human on created_by,
    // so `created_by IS NULL` could never have separated them -- origin_rule is what does.
    expect(await sourceOf("office_dallas", "rule-engine"), "rule-engine").toBe("automated");
    expect(await sourceOf("office_dallas", "email-queue"), "email-queue").toBe("automated");
    expect(await sourceOf("office_dallas", "ai-disconnect"), "ai-disconnect").toBe("automated");
    expect(await sourceOf("office_dallas", "revision-routing"), "revision-routing").toBe("automated");

    // The one shape a person actually typed.
    expect(await sourceOf("office_dallas", "hand-typed"), "hand-typed").toBe("manual");

    // C4: reassignment tasks are separable after all, by title AND the assignedAt snapshot marker.
    expect(await sourceOf("office_dallas", "assignment-task"), "assignment task").toBe("automated");

    // ...but the title ALONE must not be enough, or a human's task gets misfiled by its wording.
    expect(
      await sourceOf("office_dallas", "human-titled-like-assignment"),
      "human task, assignment title"
    ).toBe("manual");
    expect(
      await sourceOf("office_dallas", "human-titled-null-snapshot"),
      "human task, assignment title, NULL snapshot"
    ).toBe("manual");

    // Nothing identifies this row, so it keeps the default rather than being guessed into the manual tab.
    expect(await sourceOf("office_dallas", "orphan"), "orphan").toBe("automated");
  });

  // THE ONE THAT MATTERS. `hand-typed` is a row the backfill genuinely rewrites (automated -> manual), so
  // the UPDATE definitely touches it; if the DISABLE TRIGGER wrapper is missing, set_tasks_updated_at
  // stamps NOW() and every contact linked to a task reports the migration timestamp as its "Last touch".
  it("leaves updated_at untouched on rows the backfill rewrites", async () => {
    await seedOffices(["office_dallas"]);
    await seedTaskShapes("office_dallas");

    const before = await pg.query<{ updated_at: Date }>(
      `SELECT updated_at FROM office_dallas.tasks ORDER BY title`
    );

    await pg.exec(migrationSql(MIGRATION));

    const after = await pg.query<{ title: string; updated_at: Date }>(
      `SELECT title, updated_at FROM office_dallas.tasks ORDER BY title`
    );

    // Every row, not just the rewritten one -- a wrapper that covers one statement and not the next
    // would still corrupt the rows the second statement touches.
    expect(after.rows.map((r) => r.updated_at.toISOString())).toEqual(
      before.rows.map((r) => r.updated_at.toISOString())
    );
    const seeded = new Date(SEEDED_UPDATED_AT).toISOString();
    for (const row of after.rows) {
      expect(row.updated_at.toISOString(), row.title).toBe(seeded);
    }
  });

  // The same wrapper's other half. The audit trigger fires ~30 dynamic EXECUTEs per row; letting the
  // backfill run through it writes an audit row per task in every office, for a column nobody edited.
  it("writes no audit rows for the backfill", async () => {
    await seedOffices(["office_dallas"]);
    await seedTaskShapes("office_dallas");
    await pg.exec(migrationSql(MIGRATION));

    const audited = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM public.audit_log_probe WHERE table_name = 'tasks'`
    );
    expect(audited.rows[0]?.n).toBe(0);
  });

  // Both triggers must be live again afterwards, or the migration silently turns off the contacts
  // last-touch signal and the tasks audit trail for good.
  it("re-enables both triggers when it is done", async () => {
    await seedOffices(["office_dallas"]);
    await seedTaskShapes("office_dallas");
    await pg.exec(migrationSql(MIGRATION));

    const enabled = await pg.query<{ tgname: string; tgenabled: string }>(
      `SELECT t.tgname, t.tgenabled
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'office_dallas' AND c.relname = 'tasks' AND NOT t.tgisinternal
        ORDER BY t.tgname`
    );
    expect(enabled.rows.map((r) => r.tgname)).toEqual(["audit_tasks", "set_tasks_updated_at"]);
    // 'O' = fires in origin/local mode, i.e. enabled. 'D' = disabled.
    for (const row of enabled.rows) {
      expect(row.tgenabled, row.tgname).toBe("O");
    }

    // Proven by behaviour, not just by the catalog letter: a normal UPDATE must move updated_at again.
    await pg.exec(`UPDATE office_dallas.tasks SET title = 'edited' WHERE description = 'hand-typed'`);
    const touched = await pg.query<{ updated_at: Date }>(
      `SELECT updated_at FROM office_dallas.tasks WHERE description = 'hand-typed'`
    );
    expect(touched.rows[0]!.updated_at.toISOString()).not.toBe(new Date(SEEDED_UPDATED_AT).toISOString());
  });

  it("is idempotent — re-running changes nothing and does not error", async () => {
    await seedOffices(["office_dallas"]);
    await seedTaskShapes("office_dallas");
    await pg.exec(migrationSql(MIGRATION));

    const first = await pg.query<{ title: string; source: string; updated_at: Date }>(
      `SELECT title, source, updated_at FROM office_dallas.tasks ORDER BY title`
    );

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    const second = await pg.query<{ title: string; source: string; updated_at: Date }>(
      `SELECT title, source, updated_at FROM office_dallas.tasks ORDER BY title`
    );
    expect(second.rows.map((r) => `${r.title}:${r.source}:${r.updated_at.toISOString()}`)).toEqual(
      first.rows.map((r) => `${r.title}:${r.source}:${r.updated_at.toISOString()}`)
    );

    const columns = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema='office_dallas' AND table_name='tasks' AND column_name='source'`
    );
    expect(columns.rows[0]?.n).toBe(1);
  });

  // C1's second half: "touch only rows whose value actually changes". The trigger wrapper is what
  // protects updated_at, but it is one line away from being deleted, so the backfill must ALSO not
  // rewrite rows pointlessly. xmin changes whenever a row version is written, which is how this can tell
  // "left alone" from "rewritten to the value it already held" -- a distinction no SELECT of `source`
  // could make. This is what catches classifying reassignment tasks in two passes instead of one.
  it("rewrites no row twice — a converged schema is left physically untouched", async () => {
    await seedOffices(["office_dallas"]);
    await seedTaskShapes("office_dallas");
    await pg.exec(migrationSql(MIGRATION));

    const first = await pg.query<{ description: string; xmin: string }>(
      `SELECT description, xmin::text AS xmin FROM office_dallas.tasks ORDER BY description`
    );
    await pg.exec(migrationSql(MIGRATION));
    const second = await pg.query<{ description: string; xmin: string }>(
      `SELECT description, xmin::text AS xmin FROM office_dallas.tasks ORDER BY description`
    );

    expect(second.rows.map((r) => `${r.description}:${r.xmin}`)).toEqual(
      first.rows.map((r) => `${r.description}:${r.xmin}`)
    );
  });

  // The repair statement's own guard. It matches nothing on a converged schema (proved directly above),
  // so without a case that puts a reassignment row back on 'manual' it would be a statement that can
  // never fire -- indistinguishable from the two no-op UPDATEs the review deleted from this design.
  it("repairs a reassignment task an interrupted run left classified as manual", async () => {
    await seedOffices(["office_dallas"]);
    await seedTaskShapes("office_dallas");
    await pg.exec(migrationSql(MIGRATION));

    // Stand in for a dump taken between the two statements of a partially-applied backfill.
    await pg.exec(
      `UPDATE office_dallas.tasks SET source = 'manual' WHERE description = 'assignment-task'`
    );
    expect(await sourceOf("office_dallas", "assignment-task")).toBe("manual");

    await pg.exec(migrationSql(MIGRATION));

    expect(await sourceOf("office_dallas", "assignment-task")).toBe("automated");
    // ...and the repair must not have dragged the genuinely-manual rows back with it.
    expect(await sourceOf("office_dallas", "hand-typed")).toBe("manual");
  });

  // The deliberate counterpart to the to_regclass skip below: a schema with a tasks table but WITHOUT
  // set_tasks_updated_at must abort, not quietly backfill with the trigger live. Skipping the disable
  // and carrying on is the irreversible outcome; aborting before anything is written is recoverable.
  it("REFUSES to run against a tasks table missing the updated_at trigger", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(`DROP TRIGGER set_tasks_updated_at ON office_dallas.tasks;`);

    await expect(pg.exec(migrationSql(MIGRATION))).rejects.toThrow(/set_tasks_updated_at/);
  });

  it("skips a schema that has no tasks table, instead of failing the whole migration", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(`CREATE SCHEMA office_empty;`);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(await columnExists("office_dallas", "tasks", "source")).toBe(true);
  });

  // The provisioner replays ONLY the marked block for offices created after this deploy. If it drifts
  // from the loop, a new office comes up missing the column and every task write there 500s.
  it("has a TENANT_SCHEMA block that produces the same column and CHECK as the loop", async () => {
    const raw = migrationSql(MIGRATION);
    const block = raw.split("-- TENANT_SCHEMA_START")[1]?.split("-- TENANT_SCHEMA_END")[0];
    expect(block, "TENANT_SCHEMA_START/END markers must be present").toBeTruthy();

    // The provisioner takes indexOf on the FIRST occurrence of the marker, so a marker mentioned in a
    // prose comment above the real block would truncate what a new office gets.
    expect(raw.split("-- TENANT_SCHEMA_START")).toHaveLength(2);
    expect(raw.split("-- TENANT_SCHEMA_END")).toHaveLength(2);

    // Replay the block alone against a fresh schema standing in for a newly provisioned office.
    await seedOffices(["office_dallas"]);
    await pg.exec(block!);

    expect(await columnExists("office_dallas", "tasks", "source")).toBe(true);
    // No index here either — a new office gets it from 0237's block, which the provisioner replays too.
    const index = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_indexes WHERE schemaname='office_dallas' AND indexname=$1`,
      [INDEX_NAME]
    );
    expect(index.rows[0]?.n).toBe(0);
    await expect(
      pg.exec(`INSERT INTO office_dallas.tasks (title, source) VALUES ('bogus', 'imported')`)
    ).rejects.toThrow();
  });
});
