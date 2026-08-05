// Executes Migration 0218 FROM DISK against a real Postgres (PGlite), on top of the REAL `deals` DDL
// taken from 0001_initial FROM DISK.
//
// Retyping the pre-migration table into the test is the failure mode this avoids: a hand copy lets the
// suite go green against a table shape that never shipped (see server/tests/helpers/migration-sql.ts).
// 0001 is the migration that owns `deals`, so its CREATE TABLE is the honest "office schema that exists
// today, without scope_title" — the exact starting state 0218 has to act on.
//
// What is proven here, none of it reachable from a fixture test:
//   1. an EXISTING office schema gains scope_title, nullable, varchar(120), and existing rows survive
//      as NULL — no data loss, no default backfill;
//   2. the DO-loop reaches EVERY office_% schema, not just the first one it finds;
//   3. a half-provisioned office schema (created, `deals` not cloned yet) is SKIPPED, not an abort —
//      its sibling office still gets the column;
//   4. the `LIKE 'office\_%' ESCAPE '\'` guard is literal: a schema named `officex_thing` is NOT
//      touched. Dropping the ESCAPE makes `_` a single-char wildcard and this migration would start
//      altering unrelated schemas;
//   5. re-running is a true no-op — no error, and a value written between runs is not reset;
//   6. the file carries BOTH halves. The DO-loop retro-fits schemas that exist now; the TENANT_SCHEMA
//      block is what the office provisioner replays for schemas created LATER. Either half alone leaves
//      some office without the column, so both are asserted, and the block is executed standalone
//      against a fresh schema and compared column-for-column with the DO-loop's result; and
//   7. the column width IS DEAL_SCOPE_TITLE_MAX_LENGTH, and Postgres genuinely rejects one character
//      past it. This is the tie between the three enforcement layers: the shared constant the form and
//      the API both read, and the column that backstops any writer which skips the route. A shared
//      constant WIDER than the column would turn a clean 400 into a Postgres 22001/500, and nothing
//      else in the repo would catch that drift.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { DEAL_SCOPE_TITLE_MAX_LENGTH } from "@trock-crm/shared/types";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION_SQL = migrationSql("0218_deals_scope_title");

const START_MARKER = "-- TENANT_SCHEMA_START";
const END_MARKER = "-- TENANT_SCHEMA_END";

/** The office provisioner's own extraction, mirrored. (server/src/modules/office/service.ts) */
function tenantBlockFor(sql: string, schema: string): string {
  const startIdx = sql.indexOf(START_MARKER);
  const endIdx = sql.indexOf(END_MARKER);
  return sql
    .substring(startIdx + START_MARKER.length, endIdx)
    .trim()
    .replaceAll("office_dallas", schema);
}

/**
 * The `deals` CREATE TABLE as 0001_initial actually ships it, read from disk.
 *
 * Scoped to the one statement rather than 0001's whole tenant block: that block stands up several dozen
 * tables and enums, and none of them is what 0218 acts on. Throws loudly if the anchor moves — a silent
 * empty string here would create no table at all and every assertion below would be vacuous.
 */
function dealsDdlFromInitialMigration(): string {
  const initialPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../migrations/0001_initial.sql",
  );
  const sql = readFileSync(initialPath, "utf-8");
  const anchor = "CREATE TABLE IF NOT EXISTS deals (";
  const start = sql.indexOf(anchor);
  if (start === -1) {
    throw new Error(`0001_initial.sql no longer contains "${anchor}" — this fixture is stale.`);
  }
  const end = sql.indexOf("\n);", start);
  if (end === -1) {
    throw new Error("Could not find the end of the deals CREATE TABLE in 0001_initial.sql.");
  }
  const ddl = sql.slice(start, end + 3);
  if (ddl.includes("scope_title")) {
    throw new Error("0001_initial already defines scope_title — 0218 would be testing nothing.");
  }
  return ddl;
}

const DEALS_DDL = dealsDdlFromInitialMigration();

/** The five public tables 0001's `deals` FKs into. Ids only — this suite never exercises the graph. */
const PUBLIC_PREREQUISITES = `
  CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY);
  CREATE TABLE public.users (id uuid PRIMARY KEY);
  CREATE TABLE public.project_type_config (id uuid PRIMARY KEY);
  CREATE TABLE public.region_config (id uuid PRIMARY KEY);
  CREATE TABLE public.lost_deal_reasons (id uuid PRIMARY KEY);
`;

const STAGE = "00000000-0000-4000-8000-000000000001";
const REP = "00000000-0000-4000-8000-000000000002";

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(PUBLIC_PREREQUISITES);
  await db.exec(`
    INSERT INTO public.pipeline_stage_config (id) VALUES ('${STAGE}');
    INSERT INTO public.users (id) VALUES ('${REP}');
  `);
  return db;
}

/** An office schema as it exists TODAY: the real 0001 deals table, no scope_title. */
async function createOfficeSchema(db: PGlite, schema: string) {
  await db.exec(`CREATE SCHEMA IF NOT EXISTS ${schema};`);
  await db.exec(`SET search_path = '${schema}', 'public'; ${DEALS_DDL}`);
  await db.exec(`SET search_path = 'public';`);
}

async function seedDeal(db: PGlite, schema: string, dealNumber: string) {
  await db.query(
    `INSERT INTO ${schema}.deals (deal_number, name, stage_id, assigned_rep_id)
     VALUES ($1, $2, $3, $4)`,
    [dealNumber, `Deal ${dealNumber}`, STAGE, REP],
  );
}

type ColumnShape = {
  data_type: string;
  character_maximum_length: number | null;
  is_nullable: string;
  column_default: string | null;
};

async function scopeTitleColumn(db: PGlite, schema: string): Promise<ColumnShape | null> {
  const res = await db.query<ColumnShape>(
    `SELECT data_type, character_maximum_length, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'deals' AND column_name = 'scope_title'`,
    [schema],
  );
  return res.rows[0] ?? null;
}

describe("migration 0218 — deals.scope_title", () => {
  it("adds a nullable varchar(120) to an EXISTING office schema and leaves its rows intact", async () => {
    pg = await freshDb();
    await createOfficeSchema(pg, "office_dallas");
    await seedDeal(pg, "office_dallas", "TR-1001");

    expect(await scopeTitleColumn(pg, "office_dallas")).toBeNull();

    await pg.exec(MIGRATION_SQL);

    expect(await scopeTitleColumn(pg, "office_dallas")).toEqual({
      data_type: "character varying",
      character_maximum_length: DEAL_SCOPE_TITLE_MAX_LENGTH,
      is_nullable: "YES",
      column_default: null,
    });

    // The pre-existing row is still there and its new column is NULL — no backfill, no data loss.
    const rows = await pg.query<{ deal_number: string; scope_title: string | null }>(
      `SELECT deal_number, scope_title FROM office_dallas.deals`,
    );
    expect(rows.rows).toEqual([{ deal_number: "TR-1001", scope_title: null }]);
  });

  it("reaches EVERY office_% schema, not just the first", async () => {
    pg = await freshDb();
    await createOfficeSchema(pg, "office_dallas");
    await createOfficeSchema(pg, "office_atlanta");

    await pg.exec(MIGRATION_SQL);

    expect(await scopeTitleColumn(pg, "office_dallas")).not.toBeNull();
    expect(await scopeTitleColumn(pg, "office_atlanta")).not.toBeNull();
  });

  it("SKIPS a half-provisioned office schema instead of aborting the whole DO block", async () => {
    pg = await freshDb();
    await createOfficeSchema(pg, "office_dallas");
    // Schema exists, `deals` was never cloned into it — the drifted-office case the guard exists for.
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_halfbaked;`);

    await expect(pg.exec(MIGRATION_SQL)).resolves.toBeDefined();

    // The sibling office was still migrated — the skip is a CONTINUE, not an early exit.
    expect(await scopeTitleColumn(pg, "office_dallas")).not.toBeNull();
  });

  it("matches a LITERAL underscore only — `officex_thing` is left alone", async () => {
    pg = await freshDb();
    await createOfficeSchema(pg, "office_dallas");
    // Without `ESCAPE '\'`, the `_` in `office_%` is a single-character wildcard and this schema matches.
    await createOfficeSchema(pg, "officex_thing");

    await pg.exec(MIGRATION_SQL);

    expect(await scopeTitleColumn(pg, "office_dallas")).not.toBeNull();
    expect(await scopeTitleColumn(pg, "officex_thing")).toBeNull();
  });

  it("is idempotent — a replay neither errors nor resets a value written in between", async () => {
    pg = await freshDb();
    await createOfficeSchema(pg, "office_dallas");
    await seedDeal(pg, "office_dallas", "TR-1002");

    await pg.exec(MIGRATION_SQL);
    await pg.query(`UPDATE office_dallas.deals SET scope_title = $1`, ["Balcony Repair"]);

    await expect(pg.exec(MIGRATION_SQL)).resolves.toBeDefined();

    const rows = await pg.query<{ scope_title: string | null }>(
      `SELECT scope_title FROM office_dallas.deals`,
    );
    expect(rows.rows).toEqual([{ scope_title: "Balcony Repair" }]);
  });

  it("carries BOTH halves, and the TENANT_SCHEMA block alone provisions an identical column", async () => {
    // The DO-loop covers offices that exist NOW; the marked block is what the provisioner replays for
    // offices created LATER. A migration with only one of them silently leaves half the estate short.
    expect(MIGRATION_SQL).toContain("DO $tenant$");
    expect(MIGRATION_SQL).toContain(START_MARKER);
    expect(MIGRATION_SQL).toContain(END_MARKER);

    pg = await freshDb();
    await createOfficeSchema(pg, "office_dallas");
    await pg.exec(MIGRATION_SQL);
    const viaDoLoop = await scopeTitleColumn(pg, "office_dallas");

    // A brand-new office: schema + the 0001 tenant DDL, then ONLY the marked block, exactly as
    // provisionOfficeSchema replays it.
    await createOfficeSchema(pg, "office_newoffice");
    await pg.exec(`SET search_path = 'office_newoffice', 'public';`);
    await pg.exec(tenantBlockFor(MIGRATION_SQL, "office_newoffice"));
    await pg.exec(`SET search_path = 'public';`);

    const viaTenantBlock = await scopeTitleColumn(pg, "office_newoffice");
    expect(viaTenantBlock).not.toBeNull();
    expect(viaTenantBlock).toEqual(viaDoLoop);
  });

  it("enforces DEAL_SCOPE_TITLE_MAX_LENGTH at the column, one character past it", async () => {
    // The API rejects an over-length title with a 400 before the column ever sees it. This asserts the
    // backstop under that: a writer that skips the route (a script, a future importer) still cannot
    // widen the field by accident, and the column's width is the SAME number the form and API read.
    pg = await freshDb();
    await createOfficeSchema(pg, "office_dallas");
    await pg.exec(MIGRATION_SQL);

    const atLimit = "x".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH);
    const overLimit = "x".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH + 1);

    await pg.query(
      `INSERT INTO office_dallas.deals (deal_number, name, stage_id, assigned_rep_id, scope_title)
       VALUES ('TR-2001', 'At limit', $1, $2, $3)`,
      [STAGE, REP, atLimit],
    );

    await expect(
      pg.query(
        `INSERT INTO office_dallas.deals (deal_number, name, stage_id, assigned_rep_id, scope_title)
         VALUES ('TR-2002', 'Over limit', $1, $2, $3)`,
        [STAGE, REP, overLimit],
      ),
    ).rejects.toThrow(/too long|value too long for type/i);

    const rows = await pg.query<{ len: number }>(
      `SELECT length(scope_title) AS len FROM office_dallas.deals WHERE deal_number = 'TR-2001'`,
    );
    expect(rows.rows[0]?.len).toBe(DEAL_SCOPE_TITLE_MAX_LENGTH);
  });

  it("round-trips a real title at the column: NULL -> set -> read -> cleared", async () => {
    pg = await freshDb();
    await createOfficeSchema(pg, "office_dallas");
    await pg.exec(MIGRATION_SQL);
    await seedDeal(pg, "office_dallas", "TR-3001");

    const read = async () =>
      (
        await pg!.query<{ scope_title: string | null }>(
          `SELECT scope_title FROM office_dallas.deals WHERE deal_number = 'TR-3001'`,
        )
      ).rows[0]?.scope_title ?? null;

    expect(await read()).toBeNull();

    await pg.query(`UPDATE office_dallas.deals SET scope_title = $1 WHERE deal_number = 'TR-3001'`, [
      "Clear backup clog from bathroom toilet unit 4350-201b",
    ]);
    expect(await read()).toBe("Clear backup clog from bathroom toilet unit 4350-201b");

    await pg.query(`UPDATE office_dallas.deals SET scope_title = NULL WHERE deal_number = 'TR-3001'`);
    expect(await read()).toBeNull();
  });
});
