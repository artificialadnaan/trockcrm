// Executes migration 0223 FROM DISK against a real Postgres (PGlite).
//
// 0223 adds the PROVENANCE stamp the read resolver requires: `bid_due_date_from_bid_board_at`, set by the
// Bid Board sync when it writes `bid_due_date`. It is what makes "flipping the flag changes nothing until
// a sync writes" true — the design it replaced inferred provenance by comparing the column's day against
// `bid_board_due_date`, which has been populated on prod for months and so answers TRUE for coincidences.
//
// Worth proving rather than assuming:
//   1. It reaches EVERY office schema, not just office_dallas.
//   2. It is NULLABLE and backfills NOTHING. A backfilled stamp would assert Bid Board provenance for rows
//      the sync never touched — re-creating, in the data, exactly the false positive the column exists to
//      remove.
//   3. The TENANT_SCHEMA block matches the loop (the provisioner replays only that block).
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0223_deals_bid_due_date_from_bid_board_at";
const COLUMN = "bid_due_date_from_bid_board_at";
const PROJECT_COLUMN = "bid_due_date_bid_board_project_number";

let pg: PGlite;

async function columnRow(schema: string, column: string = COLUMN) {
  const result = await pg.query<{ is_nullable: string; column_default: string | null; data_type: string }>(
    `SELECT is_nullable, column_default, data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'deals' AND column_name = $2`,
    [schema, column]
  );
  return result.rows[0] ?? null;
}

/** The minimum shape 0223 needs: a deals table per office, carrying the two columns the signal reads. */
async function seedOffices(schemas: string[]) {
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.deals (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bid_due_date timestamptz,
        bid_board_due_date date,
        bid_board_project_number text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
}

beforeEach(async () => {
  pg = new PGlite();
});

describe("migration 0223 — deals.bid_due_date_from_bid_board_at", () => {
  it("adds the column to EVERY office schema, not just the first", async () => {
    await seedOffices(["office_dallas", "office_atlanta"]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of ["office_dallas", "office_atlanta"]) {
      expect(await columnRow(schema), schema).not.toBeNull();
      expect(await columnRow(schema, PROJECT_COLUMN), `${schema}.${PROJECT_COLUMN}`).not.toBeNull();
    }
  });

  it("is a NULLABLE timestamptz with no default", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));

    const meta = await columnRow("office_dallas");
    expect(meta?.is_nullable).toBe("YES");
    expect(meta?.column_default).toBeNull();
    expect(meta?.data_type).toBe("timestamp with time zone");

    // The identity half: which Bid Board project the stamp was earned on.
    const projectMeta = await columnRow("office_dallas", PROJECT_COLUMN);
    expect(projectMeta?.is_nullable).toBe("YES");
    expect(projectMeta?.column_default).toBeNull();
    expect(projectMeta?.data_type).toBe("text");
  });

  // ★ The one that matters. A deal whose existing bid_due_date happens to share a calendar day with the
  // mirror is EXACTLY the false positive this column exists to remove, so the migration must not hand it a
  // stamp. Every pre-existing row must come out NULL — "this value did not come from the Bid Board".
  it("backfills NOTHING — not even a row whose column already matches the mirror", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(`
      INSERT INTO office_dallas.deals (bid_due_date, bid_board_due_date)
      VALUES ('2026-09-01T00:00:00Z', '2026-09-01'),
             ('2026-07-01T00:00:00Z', '2026-09-01'),
             (NULL, NULL);
    `);

    await pg.exec(migrationSql(MIGRATION));

    const stamped = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM office_dallas.deals
        WHERE ${COLUMN} IS NOT NULL OR ${PROJECT_COLUMN} IS NOT NULL`
    );
    expect(stamped.rows[0]?.n).toBe(0);
  });

  it("is idempotent — re-running changes nothing and does not error", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    const count = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema='office_dallas' AND table_name='deals' AND column_name=$1`,
      [COLUMN]
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it("skips a schema without the deals table instead of failing the whole migration", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(`CREATE SCHEMA office_empty;`);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(await columnRow("office_dallas")).not.toBeNull();
  });

  // The provisioner replays ONLY the marked block for offices created after this deploy. `deals` IS part
  // of that replayed block (unlike bid_board_sync_runs in 0222), so here both halves genuinely apply.
  it("has a TENANT_SCHEMA block that produces the same column as the loop", async () => {
    const raw = migrationSql(MIGRATION);
    const block = raw.split("-- TENANT_SCHEMA_START")[1]?.split("-- TENANT_SCHEMA_END")[0];
    expect(block, "TENANT_SCHEMA_START/END markers must be present").toBeTruthy();

    await seedOffices(["office_dallas"]);
    await pg.exec(block!);

    const meta = await columnRow("office_dallas");
    expect(meta).not.toBeNull();
    expect(meta?.is_nullable).toBe("YES");
  });

  // The exact write the ingest performs with the flag on: stamp and value set together, in one statement.
  it("leaves the stamped write the ingest performs able to execute", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await pg.exec(
      `INSERT INTO office_dallas.deals (bid_board_due_date, bid_board_project_number) VALUES ('2026-09-01', 'DFW-1-00001-aa');`
    );

    await pg.query(
      `UPDATE office_dallas.deals
          SET bid_due_date = $1::timestamptz,
              ${COLUMN} = NOW(),
              ${PROJECT_COLUMN} = bid_board_project_number`,
      ["2026-09-01T00:00:00.000Z"]
    );

    const row = await pg.query<{ stamped: boolean; landed: boolean; same_project: boolean }>(
      `SELECT ${COLUMN} IS NOT NULL AS stamped,
              ((bid_due_date AT TIME ZONE 'UTC')::date = bid_board_due_date) AS landed,
              (${PROJECT_COLUMN} IS NOT DISTINCT FROM bid_board_project_number) AS same_project
         FROM office_dallas.deals`
    );
    expect(row.rows[0]).toEqual({ stamped: true, landed: true, same_project: true });
  });
});
