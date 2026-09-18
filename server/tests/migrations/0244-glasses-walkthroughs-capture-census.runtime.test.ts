// Executes migration 0244 FROM DISK against a real Postgres (PGlite).
//
// 0244 adds `glasses_walkthroughs.capture_census` — the phone's own count of what its recorder wrote during
// a walk, filed beside the walk so a lost-narration diagnosis is one row read rather than 400 MB of video.
//
// The column is a nullable jsonb with no constraint, so there is little SQL to prove wrong. What this suite
// exists for is the TENANT SHAPE, which is where a per-office migration fails silently:
//   1. the file carries BOTH the `DO $tenant$` loop over office_% schemas AND the TENANT_SCHEMA block the
//      office provisioner clones — a migration with only one leaves either today's offices or every future
//      one without the column, and the ingest's INSERT then 42703s in an office nobody can reproduce in;
//   2. the loop reaches EVERY office, not only the one the literal block names (three offices, and the
//      third is the witness);
//   3. running it twice is a no-op, which the migration runner relies on when a recording fails;
//   4. an office provisioned before 0214 — no glasses table at all — is skipped rather than aborting the
//      single transaction for every other tenant.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const TABLE_MIGRATION = "0214_glasses_walkthroughs";
const MIGRATION = "0244_glasses_walkthroughs_capture_census";
const MIGRATION_SQL = migrationSql(MIGRATION);

const START_MARKER = "-- TENANT_SCHEMA_START";
const END_MARKER = "-- TENANT_SCHEMA_END";

/** The office provisioner's own extraction, mirrored: the block between the markers with the
 *  office_dallas placeholder rewritten to the target schema. (server/src/modules/office/service.ts) */
function tenantBlockFor(schema: string): string {
  const startIdx = MIGRATION_SQL.indexOf(START_MARKER);
  const endIdx = MIGRATION_SQL.indexOf(END_MARKER);
  return MIGRATION_SQL.substring(startIdx + START_MARKER.length, endIdx)
    .trim()
    .replaceAll("office_dallas", schema);
}

/** Three offices: office_dallas is also written by the literal TENANT_SCHEMA block, so only the third
 *  proves the DO-loop reached beyond the first schema. */
const OFFICES = ["office_dallas", "office_atlanta", "office_houston"] as const;

const DEAL = "00000000-0000-4000-8000-0000000000d1";
const USER = "00000000-0000-4000-8000-0000000000a1";

/** Only what 0214's two FKs need, then 0214 itself from disk so the table under test is the shipped one. */
async function seedGlassesTables(pg: PGlite, schemas: readonly string[]) {
  await pg.exec(`CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY);`);
  await pg.query(`INSERT INTO public.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [USER]);
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE IF NOT EXISTS ${schema}.deals (id uuid PRIMARY KEY);
    `);
    await pg.query(`INSERT INTO ${schema}.deals (id) VALUES ($1) ON CONFLICT DO NOTHING`, [DEAL]);
  }
  await pg.exec(migrationSql(TABLE_MIGRATION));
}

async function captureCensusColumn(pg: PGlite, schema: string) {
  const { rows } = await pg.query<{ data_type: string; is_nullable: string }>(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'glasses_walkthroughs' AND column_name = 'capture_census'`,
    [schema],
  );
  return rows[0] ?? null;
}

describe("migration 0244 — glasses_walkthroughs.capture_census", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
  });

  afterEach(async () => {
    await pg.close();
  });

  it("carries BOTH the DO-loop over office_% schemas and a TENANT_SCHEMA block for new tenants", () => {
    expect(MIGRATION_SQL).toContain("DO $tenant$");
    expect(MIGRATION_SQL).toContain("LIKE 'office\\_%'");
    expect(MIGRATION_SQL).toContain(START_MARKER);
    expect(MIGRATION_SQL).toContain(END_MARKER);

    // Parity, not merely presence: the block the provisioner clones must add the same column the loop adds.
    const block = tenantBlockFor("office_dallas");
    expect(block).toContain("ALTER TABLE office_dallas.glasses_walkthroughs");
    expect(block).toContain("ADD COLUMN IF NOT EXISTS capture_census jsonb");
  });

  it("adds a NULLABLE jsonb column to EVERY existing office, and is replayable", async () => {
    await seedGlassesTables(pg, OFFICES);

    await pg.exec(MIGRATION_SQL);
    // Twice: the migration runner replays a file whose recording failed, and a second run must be a no-op
    // rather than a 42701.
    await pg.exec(MIGRATION_SQL);

    for (const schema of OFFICES) {
      // Nullable MUST hold: every walk from a client that does not send a census — every walk before the
      // mobile change, every older app build after it — is filed with NULL here.
      expect(await captureCensusColumn(pg, schema), schema).toEqual({ data_type: "jsonb", is_nullable: "YES" });
    }
  });

  it("gives a NEW office the same column through the provisioner's tenant block", async () => {
    await seedGlassesTables(pg, ["office_dallas", "office_newco"]);
    // 0214's own tenant block already ran for office_dallas via its file; office_newco has the table from
    // 0214's loop. Apply only THIS migration's block to it, exactly as the provisioner would.
    await pg.exec(tenantBlockFor("office_newco"));

    expect(await captureCensusColumn(pg, "office_newco")).toEqual({ data_type: "jsonb", is_nullable: "YES" });
  });

  it("skips an office schema that has no glasses_walkthroughs table, instead of failing the whole migration", async () => {
    // An office provisioned before 0214 has no glasses table for this ALTER to find. One such schema must
    // not take the migration down for every other office in the install.
    await seedGlassesTables(pg, ["office_dallas"]);
    await pg.exec(`CREATE SCHEMA office_pre0214;`);

    await expect(pg.exec(MIGRATION_SQL)).resolves.toBeDefined();
    expect(await captureCensusColumn(pg, "office_dallas")).not.toBeNull();
    expect(await captureCensusColumn(pg, "office_pre0214")).toBeNull();
  });

  it("stores the phone's document verbatim and reads it back, and still accepts a walk with none", async () => {
    await seedGlassesTables(pg, ["office_dallas"]);
    await pg.exec(MIGRATION_SQL);

    const census = {
      walkMs: 1_800_000,
      video: { framesReceived: 54_000, framesAppended: 1_800, framesDropped: 52_200, secondsSinceLastFrameArrived: 1_740.5 },
      audio: {
        buffersReceived: 90_000,
        buffersAppended: 78_600,
        buffersDropped: 11_400,
        longestDropRun: 11_400,
        secondsAppended: 1_572,
        engineRestarts: 2,
        standaloneSecondsRecorded: 1_500,
        events: [{ atMs: 60_000, kind: "video-stalled" }],
      },
    };
    await pg.query(
      `INSERT INTO office_dallas.glasses_walkthroughs (deal_id, walk_id, captured_at, captured_by_user_id, capture_census)
       VALUES ($1, 'walk-with-census', '2026-09-02T14:00:00.000Z', $2, $3),
              ($1, 'walk-without',     '2026-09-02T15:00:00.000Z', $2, NULL)`,
      [DEAL, USER, JSON.stringify(census)],
    );

    const { rows } = await pg.query<{ walk_id: string; capture_census: unknown }>(
      `SELECT walk_id, capture_census FROM office_dallas.glasses_walkthroughs ORDER BY walk_id`,
    );
    expect(rows).toEqual([
      { walk_id: "walk-with-census", capture_census: census },
      { walk_id: "walk-without", capture_census: null },
    ]);
  });
});
