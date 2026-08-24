// Executes migration 0234 FROM DISK against a real Postgres (PGlite).
//
// 0234 is the schema half of the task closed loop: a flat `task_comments` thread per office, three
// denormalised columns on `tasks` that make "who has unread replies" one indexed predicate, and one
// new `public.notification_type` enum value.
//
// Four properties are worth executing rather than reading:
//
//   1. THE ENUM VALUE. `notifications.type` is a Postgres enum, and every reply writes an in-app row
//      with type 'task_replied'. If 0234 forgets the ALTER TYPE, that INSERT throws
//      `invalid input value for enum notification_type` on EVERY reply -- and because the in-app row
//      is written in the worker's `task.replied` handler, the throw takes the whole job with it. The
//      test therefore inserts a real notification rather than reading pg_enum.
//   2. EVERY OFFICE SCHEMA, not just the first. A tenant table that misses a schema breaks the whole
//      feature in that office on "relation does not exist".
//   3. THE CHECKS AND THE FK ACTUALLY CONSTRAIN. A constraint that exists but does not constrain is
//      exactly what reading the catalog cannot tell you, so every one of them is exercised by a
//      failing INSERT.
//   4. THE PARTIAL INDEX PREDICATE. `tasks_creator_awaiting_ack_idx` is partial on the *unacked*
//      condition -- an index on (created_by, last_reply_at) alone would leave the
//      `assigner_ack_at < last_reply_at` half of the predicate filtered after the scan, which is the
//      whole cost the index exists to avoid.
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0234_task_comments";

/**
 * THREE offices, deliberately.
 *
 * office_dallas is ALSO written by the literal TENANT_SCHEMA block at the foot of the file, so it
 * comes out correct even if the tenant loop is broken entirely. A two-office fixture still passes
 * with the loop clamped to a single schema, because between them the one schema the loop reaches and
 * the one the block reaches cover both. office_houston has no second source: only the loop can give
 * it the table, the constraints and the columns.
 */
const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

const ASSIGNEE = "11111111-1111-1111-1111-111111111111";
const ASSIGNER = "22222222-2222-2222-2222-222222222222";
const STRANGER = "33333333-3333-3333-3333-333333333333";
const TASK = "44444444-4444-4444-4444-444444444444";

let pg: PGlite;

async function columnExists(schema: string, table: string, column: string) {
  const result = await pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schema, table, column]
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

async function indexDef(schema: string, name: string) {
  const result = await pg.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
    [schema, name]
  );
  return result.rows[0]?.indexdef ?? null;
}

/**
 * The minimum shape 0234 needs: `public.users` (both new FKs point at it), the notification enum and
 * a `notifications` table typed on it, and a tenant `tasks` table per office.
 */
async function seedOffices(schemas: string[]) {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.users (
      id uuid PRIMARY KEY,
      display_name text,
      is_active boolean NOT NULL DEFAULT true
    );
    INSERT INTO public.users (id, display_name) VALUES
      ('${ASSIGNEE}', 'Assignee'),
      ('${ASSIGNER}', 'Assigner')
    ON CONFLICT DO NOTHING;

    DO $$ BEGIN
      CREATE TYPE public.notification_type AS ENUM ('task_assigned', 'system');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.tasks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title varchar(500) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'pending',
        assigned_to uuid REFERENCES public.users(id),
        created_by uuid REFERENCES public.users(id),
        source varchar(20) NOT NULL DEFAULT 'automated',
        is_test_data boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ${schema}.notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        type public.notification_type NOT NULL,
        title varchar(500) NOT NULL,
        body text,
        link varchar(1000),
        is_read boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
}

async function seedTask(schema: string) {
  await pg.exec(`
    INSERT INTO ${schema}.tasks (id, title, assigned_to, created_by)
    VALUES ('${TASK}', 'Send the roof photos', '${ASSIGNEE}', '${ASSIGNER}');
  `);
}

beforeEach(async () => {
  pg = new PGlite();
});

describe("migration 0234 — task_comments and the closed-loop columns", () => {
  it("creates task_comments in EVERY office schema, not just the first", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      expect(await columnExists(schema, "task_comments", "body"), schema).toBe(true);
    }
  });

  it("adds last_reply_at / last_reply_by / assigner_ack_at to tasks in EVERY office schema", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      for (const column of ["last_reply_at", "last_reply_by", "assigner_ack_at"]) {
        expect(await columnExists(schema, "tasks", column), `${schema}.${column}`).toBe(true);
      }
    }
  });

  // Executed, not grepped. Asserted in office_houston as well as office_dallas because the literal
  // TENANT_SCHEMA block hands office_dallas its constraints regardless of what the loop does.
  it("REJECTS a blank comment body, in EVERY office schema", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      await seedTask(schema);

      for (const blank of ["''", "'   '", `E'\\n\\t '`]) {
        await expect(
          pg.exec(
            `INSERT INTO ${schema}.task_comments (task_id, author_id, body)
             VALUES ('${TASK}', '${ASSIGNEE}', ${blank})`
          ),
          `${schema} / ${blank}`
        ).rejects.toThrow();
      }

      // ...and still accepts a real one.
      await expect(
        pg.exec(
          `INSERT INTO ${schema}.task_comments (task_id, author_id, body)
           VALUES ('${TASK}', '${ASSIGNEE}', 'On my way')`
        ),
        schema
      ).resolves.toBeDefined();
    }
  });

  it("REJECTS a kind outside reply/note/system, in EVERY office schema", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      await seedTask(schema);

      await expect(
        pg.exec(
          `INSERT INTO ${schema}.task_comments (task_id, author_id, body, kind)
           VALUES ('${TASK}', '${ASSIGNEE}', 'hi', 'escalation')`
        ),
        schema
      ).rejects.toThrow();

      for (const kind of ["reply", "note", "system"]) {
        await expect(
          pg.exec(
            `INSERT INTO ${schema}.task_comments (task_id, author_id, body, kind)
             VALUES ('${TASK}', '${ASSIGNEE}', 'hi', '${kind}')`
          ),
          `${schema} / ${kind}`
        ).resolves.toBeDefined();
      }
    }
  });

  it("defaults kind to 'reply' — the shape that actually raises the loop", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await seedTask("office_dallas");

    await pg.exec(
      `INSERT INTO office_dallas.task_comments (task_id, author_id, body)
       VALUES ('${TASK}', '${ASSIGNEE}', 'Done')`
    );
    const result = await pg.query<{ kind: string }>(
      `SELECT kind FROM office_dallas.task_comments`
    );
    expect(result.rows[0]?.kind).toBe("reply");
  });

  // `now()` is transaction-START in Postgres, and comment ordering is what decides "unread". Two
  // overlapping reply requests are enough to lose one: T1 opens (now() = t1) and stalls, T2 posts a
  // reply at t2 > t1, the assigner reads and acknowledges up to t2, and only THEN does T1 commit its
  // insert carrying created_at = t1. The reply is older than the acknowledgement that never saw it, so
  // it never re-enters "Needs your attention". clock_timestamp() reads the wall clock at INSERT rather
  // than at BEGIN, which shrinks that window from the whole transaction to the gap between the insert
  // and its commit.
  it("stamps created_at at INSERT time, not at transaction start", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await seedTask("office_dallas");

    // Both rows are inserted inside ONE transaction. Under now() they are byte-identical; under
    // clock_timestamp() they are not — which is the entire distinction, and it cannot be read off a
    // catalog default string with any confidence.
    await pg.exec(`
      BEGIN;
      INSERT INTO office_dallas.task_comments (task_id, author_id, body) VALUES ('${TASK}', '${ASSIGNEE}', 'first');
      INSERT INTO office_dallas.task_comments (task_id, author_id, body) VALUES ('${TASK}', '${ASSIGNEE}', 'second');
      COMMIT;
    `);

    const rows = await pg.query<{ body: string; created_at: Date }>(
      `SELECT body, created_at FROM office_dallas.task_comments ORDER BY body`
    );
    expect(rows.rows).toHaveLength(2);
    const [first, second] = rows.rows;
    expect(
      first!.created_at.getTime(),
      "two inserts in one transaction must not share a timestamp"
    ).not.toBe(second!.created_at.getTime());
  });

  // C9: author_id mirrors tasks.created_by, which HAS a FK. Without one, a comment can name a user
  // that never existed and the timeline's LEFT JOIN silently renders it as "System".
  it("REFUSES an author_id that is not a real user", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await seedTask("office_dallas");

    await expect(
      pg.exec(
        `INSERT INTO office_dallas.task_comments (task_id, author_id, body)
         VALUES ('${TASK}', '${STRANGER}', 'ghost')`
      )
    ).rejects.toThrow();

    // NULL is still allowed — that is how a platform-written row is recorded.
    await expect(
      pg.exec(
        `INSERT INTO office_dallas.task_comments (task_id, author_id, body, kind)
         VALUES ('${TASK}', NULL, 'Task auto-closed by email association', 'system')`
      )
    ).resolves.toBeDefined();
  });

  it("cascades comment deletion when the task is deleted", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await seedTask("office_dallas");

    await pg.exec(
      `INSERT INTO office_dallas.task_comments (task_id, author_id, body)
       VALUES ('${TASK}', '${ASSIGNEE}', 'first'), ('${TASK}', '${ASSIGNER}', 'second')`
    );
    await pg.exec(`DELETE FROM office_dallas.tasks WHERE id = '${TASK}'`);

    const remaining = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM office_dallas.task_comments`
    );
    expect(remaining.rows[0]?.n).toBe(0);
  });

  it("builds task_comments_task_created_idx in EVERY office schema", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      const def = await indexDef(schema, "task_comments_task_created_idx");
      expect(def, `${schema}.task_comments_task_created_idx`).toBeTruthy();
      expect(def!).toContain("task_id");
      expect(def!).toContain("created_at");
    }
  });

  // The predicate is the point. An index on (created_by, last_reply_at) with no WHERE clause would
  // still be "present" while leaving the assigner_ack_at comparison to a post-scan filter — which is
  // precisely the work /tasks/awaiting-me runs on every page load.
  it("builds tasks_creator_awaiting_ack_idx PARTIAL on the unacked condition, in EVERY office", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      const def = await indexDef(schema, "tasks_creator_awaiting_ack_idx");
      expect(def, `${schema}.tasks_creator_awaiting_ack_idx`).toBeTruthy();
      expect(def!, schema).toMatch(/created_by/);
      expect(def!, schema).toMatch(/last_reply_at/);
      // Both halves of the "needs attention" predicate must be IN the index, not applied after it.
      expect(def!.toLowerCase(), schema).toContain("where");
      expect(def!, schema).toMatch(/assigner_ack_at/);
    }
  });

  // C1. Executed as a real INSERT rather than read out of pg_enum: what actually breaks is the
  // notification write, and only running it proves the value is usable.
  it("adds 'task_replied' to public.notification_type so the in-app row can be written", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of OFFICES) {
      await expect(
        pg.exec(
          `INSERT INTO ${schema}.notifications (user_id, type, title, body, link)
           VALUES ('${ASSIGNER}', 'task_replied', 'Assignee replied to: Send the roof photos',
                   'On my way', '/tasks/${TASK}')`
        ),
        schema
      ).resolves.toBeDefined();
    }

    // ...and an undeclared value is still rejected, so the enum is doing its job.
    await expect(
      pg.exec(
        `INSERT INTO office_dallas.notifications (user_id, type, title)
         VALUES ('${ASSIGNER}', 'task_shouted', 'nope')`
      )
    ).rejects.toThrow();
  });

  it("skips a schema that has no tasks table, instead of failing the whole migration", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(`CREATE SCHEMA office_empty;`);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(await columnExists("office_dallas", "task_comments", "body")).toBe(true);
    expect(await columnExists("office_empty", "task_comments", "body")).toBe(false);
  });

  it("is idempotent — re-running changes nothing and does not error", async () => {
    await seedOffices([...OFFICES]);
    await pg.exec(migrationSql(MIGRATION));
    await seedTask("office_dallas");
    await pg.exec(
      `INSERT INTO office_dallas.task_comments (task_id, author_id, body)
       VALUES ('${TASK}', '${ASSIGNEE}', 'survives a re-run')`
    );

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    const rows = await pg.query<{ body: string }>(
      `SELECT body FROM office_dallas.task_comments`
    );
    expect(rows.rows.map((r) => r.body)).toEqual(["survives a re-run"]);

    const columns = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'office_dallas' AND table_name = 'tasks'
          AND column_name IN ('last_reply_at', 'last_reply_by', 'assigner_ack_at')`
    );
    expect(columns.rows[0]?.n).toBe(3);
  });

  // The provisioner replays ONLY the marked block for offices created after this deploy. If it drifts
  // from the loop, a new office comes up without the thread table and every reply there 500s.
  it("has a TENANT_SCHEMA block that produces the same table, constraints and indexes as the loop", async () => {
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
    await seedTask("office_dallas");

    expect(await columnExists("office_dallas", "task_comments", "body")).toBe(true);
    expect(await columnExists("office_dallas", "tasks", "assigner_ack_at")).toBe(true);
    expect(await indexDef("office_dallas", "task_comments_task_created_idx")).toBeTruthy();
    const ackIndex = await indexDef("office_dallas", "tasks_creator_awaiting_ack_idx");
    expect(ackIndex).toBeTruthy();
    expect(ackIndex!).toMatch(/assigner_ack_at/);
    await expect(
      pg.exec(
        `INSERT INTO office_dallas.task_comments (task_id, author_id, body) VALUES ('${TASK}', '${ASSIGNEE}', '  ')`
      )
    ).rejects.toThrow();
  });
});
