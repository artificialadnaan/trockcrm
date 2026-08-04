import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MIGRATION_SQL = readFileSync(
  join(__dirname, "../../../migrations/0215_backfill_needs_quantity.sql"),
  "utf-8"
);

let pg: PGlite;

async function seed(schema: string) {
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS ${schema};
    CREATE TABLE IF NOT EXISTS ${schema}.estimate_extractions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status text NOT NULL,
      quantity numeric(14,3),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function statuses(schema: string): Promise<Record<string, string>> {
  const { rows } = (await pg.query(
    `SELECT id::text AS id, status FROM ${schema}.estimate_extractions ORDER BY id`
  )) as { rows: Array<{ id: string; status: string }> };
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

beforeEach(async () => {
  pg = new PGlite();
});

afterEach(async () => {
  await pg.close();
});

describe("migration 0215 — parking already-priced rows that never had a usable quantity", () => {
  it("moves ONLY unpriceable processed rows, including NaN", async () => {
    // The reason a migration is needed at all: deploying the fix alone strands these. A `processed` row
    // is outside the worker's `pending` candidate filter, so it is never re-examined; the new promote
    // predicate refuses its recommendation; and its status keeps it out of the needs-quantity bucket.
    // Invisible in every direction, with no edit required to get there.
    await seed("office_dallas");
    await pg.exec(`
      INSERT INTO office_dallas.estimate_extractions (id, status, quantity) VALUES
        ('00000000-0000-4000-8000-000000000001', 'processed', NULL),
        ('00000000-0000-4000-8000-000000000002', 'processed', 0),
        ('00000000-0000-4000-8000-000000000003', 'processed', -5),
        -- NaN is named explicitly in the migration because Postgres orders numeric NaN ABOVE every
        -- finite value: a positive test alone is TRUE for it and would leave it behind.
        ('00000000-0000-4000-8000-000000000004', 'processed', 'NaN'),
        -- Priced and perfectly fine: must not be disturbed.
        ('00000000-0000-4000-8000-000000000005', 'processed', 700),
        -- Human decisions are not this migration's to overwrite.
        ('00000000-0000-4000-8000-000000000006', 'approved', NULL),
        ('00000000-0000-4000-8000-000000000007', 'rejected', NULL),
        ('00000000-0000-4000-8000-000000000008', 'overridden', NULL),
        -- The worker will flag this itself on its next run.
        ('00000000-0000-4000-8000-000000000009', 'pending', NULL);
    `);

    await pg.exec(MIGRATION_SQL);

    const after = await statuses("office_dallas");
    expect(after["00000000-0000-4000-8000-000000000001"]).toBe("needs_quantity");
    expect(after["00000000-0000-4000-8000-000000000002"]).toBe("needs_quantity");
    expect(after["00000000-0000-4000-8000-000000000003"]).toBe("needs_quantity");
    expect(after["00000000-0000-4000-8000-000000000004"]).toBe("needs_quantity");
    expect(after["00000000-0000-4000-8000-000000000005"]).toBe("processed");
    expect(after["00000000-0000-4000-8000-000000000006"]).toBe("approved");
    expect(after["00000000-0000-4000-8000-000000000007"]).toBe("rejected");
    expect(after["00000000-0000-4000-8000-000000000008"]).toBe("overridden");
    expect(after["00000000-0000-4000-8000-000000000009"]).toBe("pending");
  });

  it("is REPLAYABLE — a second run changes nothing", async () => {
    await seed("office_dallas");
    await pg.exec(`
      INSERT INTO office_dallas.estimate_extractions (id, status, quantity) VALUES
        ('00000000-0000-4000-8000-00000000000a', 'processed', NULL);
    `);

    await pg.exec(MIGRATION_SQL);
    const first = await pg.query(
      `SELECT updated_at FROM office_dallas.estimate_extractions LIMIT 1`
    );
    await pg.exec(MIGRATION_SQL);
    const second = await pg.query(
      `SELECT updated_at FROM office_dallas.estimate_extractions LIMIT 1`
    );

    // Already at needs_quantity, so the predicate no longer matches and even updated_at is untouched.
    expect((second.rows[0] as any).updated_at).toEqual((first.rows[0] as any).updated_at);
  });

  it("runs across EVERY office, and skips a half-provisioned schema", async () => {
    await seed("office_dallas");
    await seed("office_atlanta");
    await pg.exec(`CREATE SCHEMA office_halfbuilt;`);
    await pg.exec(`
      INSERT INTO office_dallas.estimate_extractions (id, status, quantity)
        VALUES ('00000000-0000-4000-8000-00000000000b', 'processed', NULL);
      INSERT INTO office_atlanta.estimate_extractions (id, status, quantity)
        VALUES ('00000000-0000-4000-8000-00000000000c', 'processed', 0);
    `);

    await pg.exec(MIGRATION_SQL);

    expect((await statuses("office_dallas"))["00000000-0000-4000-8000-00000000000b"]).toBe(
      "needs_quantity"
    );
    expect((await statuses("office_atlanta"))["00000000-0000-4000-8000-00000000000c"]).toBe(
      "needs_quantity"
    );
  });
});
