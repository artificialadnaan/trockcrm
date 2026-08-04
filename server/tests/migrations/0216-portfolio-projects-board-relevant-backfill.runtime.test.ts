// Executes Migration 0216 FROM DISK against a real Postgres (PGlite).
//
// 0216 re-flags `is_board_relevant` for rows the OLD stage classifier wrote as false but whose stage is a
// board stage in this release. Both portfolio read paths filter `WHERE is_board_relevant = true`, so an
// un-flipped row is invisible on the board AND 404s on its detail page.
//
// Proven here against real SQL, none of which a fixture test can reach:
//   1. rows in the newly-mapped stages (Pre-Construction, Estimating, the Service - * track) flip to true;
//   2. the two DELIBERATELY off-board legacy stages stay false — a blanket UPDATE would put ~183 dead
//      Hold/Lost projects on the board;
//   3. rows already true are untouched (updated_at is not churned for every row on every deploy);
//   4. running it TWICE changes nothing, which the migration runner relies on;
//   5. it loops over EVERY office_% schema, and skips a half-provisioned one instead of aborting the whole
//      DO block (which would take 0216 down for every other office too);
//   6. the file carries both the DO-loop and the TENANT_SCHEMA markers; and
//   7. the exclusion literals in the SQL are EXACTLY PORTFOLIO_PROJECT_OFF_BOARD_STAGES. SQL cannot import
//      the constant, so this is the only thing stopping the duplicated list from drifting out of sync with
//      the code that decides the same question at runtime.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  PORTFOLIO_OFF_BOARD_STAGE_ALIASES,
  PORTFOLIO_PROJECT_OFF_BOARD_STAGES,
  isPortfolioProjectOffBoardStage,
} from "@trock-crm/shared/types";

const MIGRATION_PATH = join(__dirname, "../../../migrations/0216_portfolio_projects_board_relevant_backfill.sql");
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf-8");

const START_MARKER = "-- TENANT_SCHEMA_START";
const END_MARKER = "-- TENANT_SCHEMA_END";

/** The office provisioner's own extraction, mirrored. (server/src/modules/office/service.ts) */
function tenantBlockFor(schema: string): string {
  const startIdx = MIGRATION_SQL.indexOf(START_MARKER);
  const endIdx = MIGRATION_SQL.indexOf(END_MARKER);
  return MIGRATION_SQL.substring(startIdx + START_MARKER.length, endIdx)
    .trim()
    .replaceAll("office_dallas", schema);
}

/** Only the columns 0216 reads or writes; 0135 owns the real shape. */
async function createPortfolioTable(pg: PGlite, schema: string) {
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS ${schema};
    CREATE TABLE IF NOT EXISTS ${schema}.portfolio_projects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      procore_company_id text NOT NULL,
      procore_project_id text NOT NULL,
      current_stage text NOT NULL,
      current_stage_normalized text NOT NULL,
      is_board_relevant boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/**
 * `stage` is the RAW Procore string and `normalized` is what the OLD normalizer stored for it —
 * deliberately including "pre - construction", the one canonical form this release changed. 0216 must
 * match on the raw column, so a stale normalized value cannot affect the outcome.
 */
async function insertProject(
  pg: PGlite,
  schema: string,
  args: { id: string; stage: string; normalized: string; boardRelevant: boolean },
) {
  await pg.query(
    `INSERT INTO ${schema}.portfolio_projects
       (procore_company_id, procore_project_id, current_stage, current_stage_normalized,
        is_board_relevant, updated_at)
     VALUES ('co', $1, $2, $3, $4, '2020-01-01T00:00:00.000Z')`,
    [args.id, args.stage, args.normalized, args.boardRelevant],
  );
}

async function flagsFor(pg: PGlite, schema: string): Promise<Record<string, boolean>> {
  const result = await pg.query<{ procore_project_id: string; is_board_relevant: boolean }>(
    `SELECT procore_project_id, is_board_relevant FROM ${schema}.portfolio_projects ORDER BY procore_project_id`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.procore_project_id, row.is_board_relevant]));
}

/**
 * The stage literals from EVERY `off_board constant text[] := ARRAY[ ... ]` in the file — one per
 * copy of the classifier helper (the DO-loop's and the TENANT_SCHEMA block's standalone copy).
 * Returned per-copy so the test can assert both are complete AND identical to each other.
 */
function offBoardArrayLiteralsPerCopy(sql: string): string[][] {
  return [...sql.matchAll(/off_board constant text\[\] := ARRAY\[([\s\S]*?)\]/g)]
    .map((match) => [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'")));
}

describe("migration 0216 — portfolio_projects board-relevant backfill", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await createPortfolioTable(pg, "office_dallas");
    await createPortfolioTable(pg, "office_atlanta");

    // Newly-mapped stages, written false by the OLD classifier.
    await insertProject(pg, "office_dallas", { id: "pre", stage: "Pre-Construction", normalized: "pre - construction", boardRelevant: false });
    await insertProject(pg, "office_dallas", { id: "est", stage: "Estimating ", normalized: "estimating", boardRelevant: false });
    await insertProject(pg, "office_dallas", { id: "svc-prod", stage: "Service - In Production", normalized: "service - in production", boardRelevant: false });
    await insertProject(pg, "office_dallas", { id: "svc-inv", stage: "Service - Close Out Final Invoice", normalized: "service - close out final invoice", boardRelevant: false });
    // Deliberately off-board.
    await insertProject(pg, "office_dallas", { id: "hold", stage: "Hold (LEGACY)", normalized: "hold (legacy)", boardRelevant: false });
    await insertProject(pg, "office_dallas", { id: "lost", stage: "Lost/Cancelled (Legacy)", normalized: "lost/cancelled (legacy)", boardRelevant: false });
    // Already on the board.
    await insertProject(pg, "office_dallas", { id: "closed", stage: "Closed", normalized: "closed", boardRelevant: true });
    // A stage nobody anticipated: not off-board, so it flips too — the classifier fails open.
    await insertProject(pg, "office_dallas", { id: "warranty", stage: "Warranty - Punch List", normalized: "warranty - punch list", boardRelevant: false });

    // Second office proves the DO-loop is per-schema, not just the first one it finds.
    await insertProject(pg, "office_atlanta", { id: "atl-pre", stage: "Pre-Construction", normalized: "pre - construction", boardRelevant: false });
    await insertProject(pg, "office_atlanta", { id: "atl-hold", stage: "Hold (LEGACY)", normalized: "hold (legacy)", boardRelevant: false });
  });

  it("flips the newly-mapped stages to board-relevant and leaves the legacy buckets off the board", async () => {
    await pg.exec(MIGRATION_SQL);
    const flags = await flagsFor(pg, "office_dallas");

    expect(flags.pre).toBe(true);
    expect(flags.est).toBe(true);
    expect(flags["svc-prod"]).toBe(true);
    expect(flags["svc-inv"]).toBe(true);
    expect(flags.warranty).toBe(true); // unknown != excluded
    expect(flags.closed).toBe(true);

    // The whole reason this is not a blanket UPDATE.
    expect(flags.hold).toBe(false);
    expect(flags.lost).toBe(false);
  });

  it("matches on the RAW stage, so a stale current_stage_normalized cannot change the outcome", async () => {
    // "pre - construction" is the value the OLD normalizer stored; this release emits "pre-construction".
    // Matching on the normalized column would have missed this row entirely.
    await pg.exec(MIGRATION_SQL);
    const flags = await flagsFor(pg, "office_dallas");
    expect(flags.pre).toBe(true);
  });

  it("re-flags every office schema, not only the first", async () => {
    await pg.exec(MIGRATION_SQL);
    const atlanta = await flagsFor(pg, "office_atlanta");
    expect(atlanta["atl-pre"]).toBe(true);
    expect(atlanta["atl-hold"]).toBe(false);
  });

  it("is idempotent — a replay updates nothing and churns no updated_at", async () => {
    await pg.exec(MIGRATION_SQL);
    const after = await pg.query<{ procore_project_id: string; updated_at: Date }>(
      `SELECT procore_project_id, updated_at FROM office_dallas.portfolio_projects ORDER BY procore_project_id`,
    );

    await pg.exec(MIGRATION_SQL);
    const replayed = await pg.query<{ procore_project_id: string; updated_at: Date }>(
      `SELECT procore_project_id, updated_at FROM office_dallas.portfolio_projects ORDER BY procore_project_id`,
    );

    expect(replayed.rows.map((r) => r.updated_at.toISOString()))
      .toEqual(after.rows.map((r) => r.updated_at.toISOString()));
    expect(await flagsFor(pg, "office_dallas")).toEqual(await flagsFor(pg, "office_dallas"));
  });

  it("leaves an already-relevant row's updated_at alone", async () => {
    await pg.exec(MIGRATION_SQL);
    const result = await pg.query<{ updated_at: Date }>(
      `SELECT updated_at FROM office_dallas.portfolio_projects WHERE procore_project_id = 'closed'`,
    );
    // Still the 2020 timestamp the fixture wrote: the WHERE clause excluded it.
    expect(result.rows[0].updated_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("skips a half-provisioned office schema instead of aborting every office", async () => {
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_halfbuilt;`); // no portfolio_projects table
    await expect(pg.exec(MIGRATION_SQL)).resolves.toBeDefined();
    expect((await flagsFor(pg, "office_dallas")).pre).toBe(true);
  });

  it("carries BOTH the DO-loop and the TENANT_SCHEMA block, and the block runs standalone", async () => {
    expect(MIGRATION_SQL).toContain("DO $tenant$");
    expect(MIGRATION_SQL).toContain("LIKE 'office\\_%' ESCAPE '\\'");
    expect(MIGRATION_SQL).toContain(START_MARKER);
    expect(MIGRATION_SQL).toContain(END_MARKER);

    await createPortfolioTable(pg, "office_newtenant");
    await insertProject(pg, "office_newtenant", { id: "np", stage: "Pre-Construction", normalized: "pre - construction", boardRelevant: false });
    await pg.exec(tenantBlockFor("office_newtenant"));
    expect((await flagsFor(pg, "office_newtenant")).np).toBe(true);
  });

  it("excludes every off-board ALIAS spelling, not just the two canonical values", () => {
    // THE TEST THAT WOULD HAVE CAUGHT THE BUG. The previous version compared the SQL literals against
    // PORTFOLIO_PROJECT_OFF_BOARD_STAGES — the two CANONICAL strings — and passed happily while the
    // migration was missing 'hold', 'lost/cancelled' and 'lost / cancelled (legacy)', every one of
    // which the classifier maps into a legacy bucket. Pinned against the alias KEYS instead, derived
    // from the map itself, so adding an off-board spelling in TypeScript fails here until the
    // migration covers it too.
    const copies = offBoardArrayLiteralsPerCopy(MIGRATION_SQL);
    expect(copies.length).toBe(2); // DO-loop + standalone TENANT_SCHEMA copy

    const expected = [...PORTFOLIO_OFF_BOARD_STAGE_ALIASES].sort();
    expect(expected).toEqual(expect.arrayContaining([...PORTFOLIO_PROJECT_OFF_BOARD_STAGES]));
    for (const copy of copies) {
      expect([...copy].sort()).toEqual(expected);
    }
    // ...and the two copies are identical to each other, not merely each valid.
    expect(copies[0]).toEqual(copies[1]);
  });

  it("leaves every raw legacy SPELLING off the board, not just the canonical two", async () => {
    // The real hazard: rows carry RAW Procore text, and the classifier maps all of these into the
    // dead buckets. Flipping any of them puts genuinely dead work on the board.
    const rawLegacySpellings = [
      "Hold (LEGACY)",
      "Hold",
      "hold",
      "  HOLD  ",
      "Lost/Cancelled (Legacy)",
      "Lost / Cancelled (Legacy)",
      "Lost/Cancelled",
      "LOST/CANCELLED (LEGACY)",
      "lost_cancelled (legacy)".replace("_", "/"), // underscore/spacing variants normalize in
    ];
    for (const [index, stage] of rawLegacySpellings.entries()) {
      await insertProject(pg, "office_dallas", {
        id: `raw-legacy-${index}`,
        stage,
        normalized: "whatever-the-old-normalizer-wrote",
        boardRelevant: false,
      });
    }

    await pg.exec(MIGRATION_SQL);
    const flags = await flagsFor(pg, "office_dallas");
    for (const [index, stage] of rawLegacySpellings.entries()) {
      expect({ stage, relevant: flags[`raw-legacy-${index}`] }).toEqual({ stage, relevant: false });
    }
  });

  it("agrees with the TypeScript classifier on every off-board alias spelling", async () => {
    // Drive the SQL helper directly with each alias key and require it to say off-board, which is what
    // isPortfolioProjectOffBoardStage says for the same input.
    await pg.exec(MIGRATION_SQL); // defines pg_temp.portfolio_stage_is_off_board
    for (const alias of PORTFOLIO_OFF_BOARD_STAGE_ALIASES) {
      const sqlSays = await pg.query<{ off: boolean }>(
        `SELECT pg_temp.portfolio_stage_is_off_board($1) AS off`,
        [alias],
      );
      expect({ alias, off: sqlSays.rows[0].off }).toEqual({ alias, off: isPortfolioProjectOffBoardStage(alias) });
      expect(sqlSays.rows[0].off).toBe(true);
    }

    // ...and does NOT over-match: board stages and unknown stages are both "not off-board".
    for (const stage of ["Pre-Construction", "Service - In Production", "Closed", "Buy Out", "Warranty - Punch List", ""]) {
      const sqlSays = await pg.query<{ off: boolean }>(
        `SELECT pg_temp.portfolio_stage_is_off_board($1) AS off`,
        [stage],
      );
      expect({ stage, off: sqlSays.rows[0].off }).toEqual({ stage, off: isPortfolioProjectOffBoardStage(stage) });
    }
  });
});
