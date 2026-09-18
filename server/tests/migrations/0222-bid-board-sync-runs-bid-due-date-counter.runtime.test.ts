// Executes migration 0222 FROM DISK against a real Postgres (PGlite).
//
// Two suites elsewhere hand-declare `bid_due_date_updated_count` in their own fixture DDL. Those prove the
// ingest works when the column exists — NOT that the migration creates it. That distinction is the whole
// reason this lane exists: with BID_BOARD_DUE_DATE_READBACK on, every ingest run writes this column inside
// the run's BEGIN, so an office the migration missed does not degrade quietly — its entire sync (mirror,
// estimate and stage writebacks included) rolls back on an unknown column.
//
// What is worth proving rather than assuming:
//   1. It touches EVERY office schema, not just office_dallas.
//   2. NOT NULL DEFAULT 0, so existing run rows read as "zero deals moved" instead of NULL.
//   3. It is idempotent, and skips a half-provisioned schema instead of aborting the whole migration.
//   4. The TENANT_SCHEMA block matches the DO-loop for a schema that already has the table.
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0222_bid_board_sync_runs_bid_due_date_counter";
const COLUMN = "bid_due_date_updated_count";

let pg: PGlite;

async function columnRow(schema: string) {
  const result = await pg.query<{ is_nullable: string; column_default: string | null; data_type: string }>(
    `SELECT is_nullable, column_default, data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'bid_board_sync_runs' AND column_name = $2`,
    [schema, COLUMN]
  );
  return result.rows[0] ?? null;
}

/** The minimum shape 0222 needs: a bid_board_sync_runs table per office, as migration 0063 leaves it. */
async function seedOffices(schemas: string[]) {
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.bid_board_sync_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        payload_hash text,
        updated_count integer NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'received',
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
}

beforeEach(async () => {
  pg = new PGlite();
});

describe("migration 0222 — bid_board_sync_runs.bid_due_date_updated_count", () => {
  it("adds the column to EVERY office schema, not just the first", async () => {
    await seedOffices(["office_dallas", "office_atlanta"]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of ["office_dallas", "office_atlanta"]) {
      expect(await columnRow(schema), schema).not.toBeNull();
    }
  });

  it("is NOT NULL DEFAULT 0, so historical run rows read as zero rather than NULL", async () => {
    await seedOffices(["office_dallas"]);
    // A run row that predates the feature — it must survive the ALTER and come out as 0, not NULL.
    await pg.exec(`INSERT INTO office_dallas.bid_board_sync_runs (payload_hash) VALUES ('pre-existing');`);

    await pg.exec(migrationSql(MIGRATION));

    const meta = await columnRow("office_dallas");
    expect(meta?.is_nullable).toBe("NO");
    expect(meta?.column_default).toContain("0");
    expect(meta?.data_type).toBe("integer");

    const row = await pg.query<{ counter: number }>(
      `SELECT ${COLUMN} AS counter FROM office_dallas.bid_board_sync_runs WHERE payload_hash = 'pre-existing'`
    );
    expect(row.rows[0]?.counter).toBe(0);
  });

  // The exact statement the ingest issues with the flag ON. If the migration ever stopped delivering the
  // column, this is the failure the office would actually see — inside its sync transaction.
  it("leaves the run-row UPDATE the ingest performs able to execute", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await pg.exec(`INSERT INTO office_dallas.bid_board_sync_runs (payload_hash) VALUES ('run-1');`);

    await pg.query(
      `UPDATE office_dallas.bid_board_sync_runs SET updated_count = $1, ${COLUMN} = $2 WHERE payload_hash = 'run-1'`,
      [3, 7]
    );

    const row = await pg.query<{ counter: number }>(
      `SELECT ${COLUMN} AS counter FROM office_dallas.bid_board_sync_runs WHERE payload_hash = 'run-1'`
    );
    expect(row.rows[0]?.counter).toBe(7);
  });

  it("is idempotent — re-running changes nothing and does not error", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    const count = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema='office_dallas' AND table_name='bid_board_sync_runs' AND column_name=$1`,
      [COLUMN]
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it("skips a schema without the table instead of failing the whole migration", async () => {
    await seedOffices(["office_dallas"]);
    // A half-provisioned office: the schema exists, the table does not.
    await pg.exec(`CREATE SCHEMA office_empty;`);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(await columnRow("office_dallas")).not.toBeNull();
  });

  // The provisioner replays ONLY the marked block for offices created after this deploy, so it must
  // produce the same column the loop does.
  //
  // NOTE the documented limitation this test deliberately encodes: the block is replayed against a schema
  // that ALREADY has bid_board_sync_runs. For a genuinely brand-new office the table does not exist yet
  // (0063 creates it only inside its own DO-loop, with no TENANT_SCHEMA block), so the block would raise
  // `relation does not exist`. That gap belongs to 0063's provisioning, is shared verbatim with migration
  // 0200, and is called out in 0222's header rather than papered over here.
  it("has a TENANT_SCHEMA block that produces the same column as the loop", async () => {
    const raw = migrationSql(MIGRATION);
    const block = raw.split("-- TENANT_SCHEMA_START")[1]?.split("-- TENANT_SCHEMA_END")[0];
    expect(block, "TENANT_SCHEMA_START/END markers must be present").toBeTruthy();

    await seedOffices(["office_dallas"]);
    await pg.exec(block!);

    const meta = await columnRow("office_dallas");
    expect(meta).not.toBeNull();
    expect(meta?.is_nullable).toBe("NO");
    expect(meta?.column_default).toContain("0");
  });

  it("touches ONLY bid_board_sync_runs — no other tenant table is altered", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(`CREATE TABLE office_dallas.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid());`);

    await pg.exec(migrationSql(MIGRATION));

    const dealsColumns = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema='office_dallas' AND table_name='deals'`
    );
    expect(dealsColumns.rows[0]?.n).toBe(1);
  });
});
