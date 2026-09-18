// Executes Migration 0217 FROM DISK against a real Postgres (PGlite), layered on 0135 and 0216 FROM DISK.
//
// 0217 exists because 0216 acted on a blind spot it inherited from the TypeScript classifier: neither
// absorbed SLASH spacing, so "Lost / Cancelled" — one of Procore's two dead legacy buckets, just typed
// with spaces — matched no alias, and `isPortfolioProjectBoardRelevantStage` fails OPEN. 0216's UPDATE
// reads `WHERE is_board_relevant = false AND NOT off_board(current_stage)`, so it did not merely skip
// those rows: it FLIPPED THEM ONTO THE BOARD. Dead work, rendered as live work in "Other / No Column".
//
// The first test below is therefore the whole point of running the real 0216 file rather than describing
// what it did: it asserts the defect happening, then asserts 0217 undoing it. A hand-written "simplified
// 0216" could not have shown that, because the bug lives in 0216's exact predicate.
//
// Also proven here, none of it reachable from a fixture test:
//   1. 0216 flips a spaced-bare legacy row TO true; 0217 flips it back to false;
//   2. 0217 flips ONLY that direction — nothing goes false -> true, so it cannot resurrect a row 0216
//      deliberately left off the board, and cannot substitute for 0216;
//   3. genuinely board-relevant rows (board stages and unrecognised stages alike) are untouched;
//   4. it is idempotent, and does not churn updated_at on a replay — the runner relies on that;
//   5. it works whether or not 0216 has ever run, which is the real deployment case;
//   6. it loops every office_% schema and skips a half-provisioned one instead of aborting the DO block;
//   7. the file carries the DO-loop AND the TENANT_SCHEMA markers, and the block runs standalone;
//   8. the duplicated alias literals in EVERY copy equal PORTFOLIO_OFF_BOARD_STAGE_ALIASES; and
//   9. the SQL mirror agrees with the TypeScript classifier — including on the slash spellings, which is
//      the agreement 0216's mirror no longer has and can no longer be given.
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PORTFOLIO_OFF_BOARD_STAGE_ALIASES,
  isPortfolioProjectBoardRelevantStage,
  isPortfolioProjectOffBoardStage,
} from "@trock-crm/shared/types";
import { migrationSql } from "../helpers/migration-sql.js";
import { toPortfolioSeedCandidate } from "../../src/modules/synchub/portfolio-projects-sync.js";
import { validateSyncHubProjectStageChangedPayload } from "../../src/modules/synchub/procore-project-stage-relay-service.js";

/** The REAL files. 0135 owns the table shape; retyping it here is how a suite ends up green against a
 *  schema that does not ship (see server/tests/helpers/migration-sql.ts). */
const SCHEMA_0135 = migrationSql("0135_portfolio_project_relay_tracking");
const BACKFILL_0216 = migrationSql("0216_portfolio_projects_board_relevant_backfill");
const MIGRATION_SQL = migrationSql("0217_portfolio_projects_off_board_slash_spacing");

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

const TAB = String.fromCharCode(9);
const NBSP = String.fromCharCode(0xa0);

let pg: PGlite;

/** 0135's own tenant DDL, so the table under test is the one that ships. */
async function createOfficeSchema(schema: string) {
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS ${schema};`);
  await pg.exec(tenantBlockFor(SCHEMA_0135, schema));
}

async function insertProject(
  schema: string,
  args: { id: string; stage: string; normalized?: string; boardRelevant: boolean },
) {
  await pg.query(
    `INSERT INTO ${schema}.portfolio_projects
       (procore_company_id, procore_project_id, name, current_stage, current_stage_normalized,
        is_board_relevant, updated_at)
     VALUES ('co', $1, 'Project ' || $1, $2, $3, $4, '2020-01-01T00:00:00.000Z')`,
    [args.id, args.stage, args.normalized ?? "whatever-the-old-normalizer-wrote", args.boardRelevant],
  );
}

async function flagsFor(schema: string): Promise<Record<string, boolean>> {
  const result = await pg.query<{ procore_project_id: string; is_board_relevant: boolean }>(
    `SELECT procore_project_id, is_board_relevant FROM ${schema}.portfolio_projects ORDER BY procore_project_id`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.procore_project_id, row.is_board_relevant]));
}

async function updatedAtFor(schema: string): Promise<Record<string, string>> {
  const result = await pg.query<{ procore_project_id: string; updated_at: Date }>(
    `SELECT procore_project_id, updated_at FROM ${schema}.portfolio_projects ORDER BY procore_project_id`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.procore_project_id, row.updated_at.toISOString()]));
}

/** 0217's own SQL classifier, driven directly. */
async function sqlIsOffBoard(value: string | null): Promise<boolean> {
  const result = await pg.query<{ off: boolean }>(
    `SELECT pg_temp.portfolio_stage_is_off_board_slash_aware($1) AS off`,
    [value],
  );
  return result.rows[0].off;
}

/**
 * The stage literals from EVERY `off_board constant text[] := ARRAY[ ... ]` in a file — one per copy of
 * the classifier helper (the DO-loop's and the TENANT_SCHEMA block's standalone copy). Returned per-copy
 * so the test can require both complete AND identical to each other.
 */
function offBoardArrayLiteralsPerCopy(sql: string): string[][] {
  return [...sql.matchAll(/off_board constant text\[\] := ARRAY\[([\s\S]*?)\]/g)].map((match) =>
    [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'")),
  );
}

/**
 * Every spaced spelling of the bare legacy bucket, plus the two that ALREADY worked. Each row states what
 * 0216 alone does with it, so the fixture itself records which ones are the regression.
 */
const LEGACY_SPELLINGS: Array<{ id: string; stage: string; flippedOnBoardBy0216: boolean }> = [
  { id: "slash-spaced", stage: "Lost / Cancelled", flippedOnBoardBy0216: true },
  { id: "slash-doubled", stage: "Lost  /  Cancelled", flippedOnBoardBy0216: true },
  { id: "slash-left", stage: "Lost /Cancelled", flippedOnBoardBy0216: true },
  { id: "slash-right", stage: "Lost/ Cancelled", flippedOnBoardBy0216: true },
  { id: "slash-upper", stage: "LOST / CANCELLED", flippedOnBoardBy0216: true },
  { id: "slash-tabbed", stage: `Lost${TAB}/${TAB}Cancelled`, flippedOnBoardBy0216: true },
  { id: "slash-nbsp", stage: `Lost${NBSP}/${NBSP}Cancelled`, flippedOnBoardBy0216: true },
  { id: "slash-underscore", stage: "Lost_/_Cancelled", flippedOnBoardBy0216: true },
  // The spellings 0216 already handled — they must stay off the board, and 0217 must not need to act.
  { id: "compact", stage: "Lost/Cancelled", flippedOnBoardBy0216: false },
  { id: "compact-legacy", stage: "Lost/Cancelled (Legacy)", flippedOnBoardBy0216: false },
  { id: "spaced-legacy", stage: "Lost / Cancelled (Legacy)", flippedOnBoardBy0216: false },
  { id: "hold", stage: "Hold", flippedOnBoardBy0216: false },
];

/** Rows that genuinely belong on the board and must survive 0217 untouched. */
const BOARD_ROWS = [
  { id: "pre", stage: "Pre-Construction" },
  { id: "closed", stage: "Closed" },
  { id: "svc", stage: "Service - In Production" },
  { id: "warranty", stage: "Warranty - Punch List" }, // unrecognised != excluded
  { id: "underscore-hold", stage: "_Hold" }, // -> " hold": NOT off-board, and must stay on the board
];

describe("migration 0217 — slash-spaced legacy stages back off the portfolio board", () => {
  beforeEach(async () => {
    pg = new PGlite();
    await createOfficeSchema("office_dallas");
    await createOfficeSchema("office_atlanta");

    for (const row of LEGACY_SPELLINGS) {
      await insertProject("office_dallas", { id: row.id, stage: row.stage, boardRelevant: false });
    }
    for (const row of BOARD_ROWS) {
      await insertProject("office_dallas", { id: row.id, stage: row.stage, boardRelevant: false });
    }
    await insertProject("office_atlanta", { id: "atl-slash", stage: "Lost / Cancelled", boardRelevant: false });
    await insertProject("office_atlanta", { id: "atl-pre", stage: "Pre-Construction", boardRelevant: false });
  });

  afterEach(async () => {
    await pg.close();
  });

  it("0216 puts the spaced legacy rows ON the board, and 0217 takes them back off", async () => {
    await pg.exec(BACKFILL_0216);
    const after0216 = await flagsFor("office_dallas");

    // THE DEFECT, in situ, through the file that shipped it. Not a description of it.
    for (const row of LEGACY_SPELLINGS) {
      expect({ stage: row.stage, onBoard: after0216[row.id] })
        .toEqual({ stage: row.stage, onBoard: row.flippedOnBoardBy0216 });
    }
    // Non-vacuous: 0216 really did mis-flip a majority of the spellings.
    expect(LEGACY_SPELLINGS.filter((row) => after0216[row.id]).length).toBeGreaterThanOrEqual(8);

    await pg.exec(MIGRATION_SQL);
    const after0217 = await flagsFor("office_dallas");

    // ...and every legacy spelling is off the board, however it was punctuated.
    for (const row of LEGACY_SPELLINGS) {
      expect({ stage: row.stage, onBoard: after0217[row.id] })
        .toEqual({ stage: row.stage, onBoard: false });
    }
  });

  it("leaves board stages and unrecognised stages on the board", async () => {
    await pg.exec(BACKFILL_0216);
    await pg.exec(MIGRATION_SQL);
    const flags = await flagsFor("office_dallas");
    for (const row of BOARD_ROWS) {
      expect({ stage: row.stage, onBoard: flags[row.id] }).toEqual({ stage: row.stage, onBoard: true });
    }
  });

  it("only ever flips true -> false, so it can neither resurrect a row nor replace 0216", async () => {
    // Run WITHOUT 0216: every row is still false. 0217 must widen nothing.
    await pg.exec(MIGRATION_SQL);
    const flags = await flagsFor("office_dallas");
    expect(Object.values(flags).filter(Boolean)).toEqual([]);
  });

  it("works whether or not 0216 has run, and reaches the same end state either way", async () => {
    // Path A — a FRESH database: the runner applies 0216 then 0217, in filename order.
    await pg.exec(BACKFILL_0216);
    await pg.exec(MIGRATION_SQL);
    const freshDatabase = await flagsFor("office_dallas");

    // Path B — a database where 0216 ran weeks ago, so 0217 deploys ALONE onto the state 0216 left
    // behind. Rebuilt from scratch in the second office and seeded with exactly that state.
    await pg.exec(`DROP SCHEMA office_atlanta CASCADE;`);
    await createOfficeSchema("office_atlanta");
    const legacyStateAfter0216 = new Map(LEGACY_SPELLINGS.map((row) => [row.id, row.flippedOnBoardBy0216]));
    for (const row of [...LEGACY_SPELLINGS, ...BOARD_ROWS]) {
      await insertProject("office_atlanta", {
        id: row.id,
        stage: row.stage,
        // 0216 flipped everything it did not call off-board to true; BOARD_ROWS are all in that set.
        boardRelevant: legacyStateAfter0216.get(row.id) ?? true,
      });
    }
    await pg.exec(MIGRATION_SQL);
    const alreadyMigrated = await flagsFor("office_atlanta");

    expect(alreadyMigrated).toEqual(freshDatabase);
    // Non-vacuous: the end state is a real mix, not "everything false".
    expect(Object.values(freshDatabase).filter(Boolean).length).toBe(BOARD_ROWS.length);
    expect(Object.values(freshDatabase).filter((flag) => !flag).length).toBe(LEGACY_SPELLINGS.length);
  });

  it("is idempotent — a replay updates nothing and churns no updated_at", async () => {
    await pg.exec(BACKFILL_0216);
    await pg.exec(MIGRATION_SQL);
    const first = await updatedAtFor("office_dallas");

    await pg.exec(MIGRATION_SQL);
    expect(await updatedAtFor("office_dallas")).toEqual(first);
    expect(await flagsFor("office_dallas")).toEqual(await flagsFor("office_dallas"));
  });

  it("leaves an untouched row's updated_at alone", async () => {
    await pg.exec(MIGRATION_SQL); // nothing to correct: every fixture row starts false
    const stamps = await updatedAtFor("office_dallas");
    for (const [id, stamp] of Object.entries(stamps)) {
      expect({ id, stamp }).toEqual({ id, stamp: "2020-01-01T00:00:00.000Z" });
    }
  });

  it("corrects every office schema, not only the first", async () => {
    await pg.exec(BACKFILL_0216);
    expect((await flagsFor("office_atlanta"))["atl-slash"]).toBe(true); // 0216 mis-flipped it here too

    await pg.exec(MIGRATION_SQL);
    const atlanta = await flagsFor("office_atlanta");
    expect(atlanta["atl-slash"]).toBe(false);
    expect(atlanta["atl-pre"]).toBe(true);
  });

  it("skips a half-provisioned office schema instead of aborting every office", async () => {
    await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_halfbuilt;`); // no portfolio_projects table
    await pg.exec(BACKFILL_0216);
    await expect(pg.exec(MIGRATION_SQL)).resolves.toBeDefined();
    expect((await flagsFor("office_dallas"))["slash-spaced"]).toBe(false);
  });

  it("carries BOTH the DO-loop and the TENANT_SCHEMA block, and the block runs standalone", async () => {
    expect(MIGRATION_SQL).toContain("DO $tenant$");
    expect(MIGRATION_SQL).toContain("LIKE 'office\\_%' ESCAPE '\\'");
    expect(MIGRATION_SQL).toContain(START_MARKER);
    expect(MIGRATION_SQL).toContain(END_MARKER);

    await createOfficeSchema("office_newtenant");
    await insertProject("office_newtenant", { id: "np", stage: "Lost / Cancelled", boardRelevant: true });
    await insertProject("office_newtenant", { id: "board", stage: "Closed", boardRelevant: true });
    await pg.exec(tenantBlockFor(MIGRATION_SQL, "office_newtenant"));

    const flags = await flagsFor("office_newtenant");
    expect(flags.np).toBe(false);
    expect(flags.board).toBe(true);
  });

  it("pins the duplicated alias list against PORTFOLIO_OFF_BOARD_STAGE_ALIASES in every copy", () => {
    // SQL cannot import the module, so this is the only thing stopping the copies from drifting from the
    // map that decides the same question at runtime — and from each other.
    const copies = offBoardArrayLiteralsPerCopy(MIGRATION_SQL);
    expect(copies.length).toBe(2); // DO-loop + standalone TENANT_SCHEMA copy

    const expected = [...PORTFOLIO_OFF_BOARD_STAGE_ALIASES].sort();
    for (const copy of copies) expect([...copy].sort()).toEqual(expected);
    expect(copies[0]).toEqual(copies[1]);

    // The fix deliberately added NO alias key — that is what keeps 0216's own drift test passing against
    // a file that can no longer be edited. So 0217's list is 0216's list, unchanged.
    expect(offBoardArrayLiteralsPerCopy(BACKFILL_0216)[0]).toEqual(copies[0]);
  });

  it("uses no POSIX character class — the mirror must not depend on the server locale", () => {
    // PostgreSQL evaluates POSIX classes per the ACTIVE COLLATION; JS \s is a fixed set of code points.
    // Both sides of the parity test below run against the same backend, so that divergence is invisible
    // to it on every possible input. The only testable thing is the decision not to depend on a locale.
    const executableSql = MIGRATION_SQL.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect([...executableSql.matchAll(/\[:[a-z]+:\]/g)].map((m) => m[0])).toEqual([]);
  });

  it("declares `ws` identically to 0216, in explicit code points, in every copy", async () => {
    // Pinned to 0216's declaration rather than retyped: 0216's own suite asserts that literal IS JS \s,
    // character for character, so tying the two together makes one pin serve both files and makes a
    // well-meaning "simplify to [[:space:]]" fail in both places.
    const pattern = /ws constant text := ('[^']*')/g;
    const here = [...MIGRATION_SQL.matchAll(pattern)].map((m) => m[1]);
    const there = [...BACKFILL_0216.matchAll(pattern)].map((m) => m[1]);
    expect(here.length).toBe(2);
    expect(new Set([...here, ...there]).size).toBe(1);

    // ...and the class the SQL actually applies matches JS \s character for character.
    await pg.exec(MIGRATION_SQL);
    const jsWhitespace = [
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
      0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
      0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
    ].map((code) => String.fromCodePoint(code));
    // Not whitespace in JS, and not collapsed by either implementation. NUL is omitted (Postgres text
    // cannot store it) and so is U+005F: the underscore is NOT JS \s, but BOTH implementations collapse
    // it deliberately (`/[_\s]+/g` in TypeScript, `[_ || ws]+` in SQL), so it belongs with the padding
    // that DOES normalize away — asserted separately below.
    const notJsWhitespace = [0x0e, 0x1f, 0x61, 0x2d, 0x200b, 0x2060, 0x180e]
      .map((code) => String.fromCodePoint(code));

    for (const char of jsWhitespace) {
      expect({ cp: char.codePointAt(0), js: /\s/.test(char) }).toEqual({ cp: char.codePointAt(0), js: true });
      // Padding the SLASH with it must still compact away to the alias.
      expect(await sqlIsOffBoard(`Lost${char}/${char}Cancelled`)).toBe(true);
    }
    for (const char of notJsWhitespace) {
      expect({ cp: char.codePointAt(0), js: /\s/.test(char) }).toEqual({ cp: char.codePointAt(0), js: false });
      // ...and a non-whitespace padding must NOT be stripped, so it stays unrecognised.
      expect(await sqlIsOffBoard(`Lost${char}/${char}Cancelled`)).toBe(false);
    }

    // The underscore, both ways round: collapsed to a space by the explicit `_` in the class, so it
    // normalizes away exactly like whitespace even though JS \s does not match it.
    expect(/\s/.test("_")).toBe(false);
    expect(await sqlIsOffBoard("Lost_/_Cancelled")).toBe(true);
    expect(isPortfolioProjectOffBoardStage("Lost_/_Cancelled")).toBe(true);
  });

  /**
   * PARITY — 0217's mirror against the classifier it mirrors. The assertion is AGREEMENT, not a hardcoded
   * expectation, so it stays honest as either side changes. The slash rows are the ones 0216's mirror can
   * no longer satisfy; the rest are carried over from 0216's adversarial set so the fourth lookup form
   * cannot have quietly changed an answer somewhere else.
   */
  const PARITY_INPUTS: Array<[label: string, value: string | null]> = [
    ["spaced bare legacy", "Lost / Cancelled"],
    ["doubled-space slash", "Lost  /  Cancelled"],
    ["left-spaced slash", "Lost /Cancelled"],
    ["right-spaced slash", "Lost/ Cancelled"],
    ["tabbed slash", `Lost${TAB}/${TAB}Cancelled`],
    ["NBSP slash", `Lost${NBSP}/${NBSP}Cancelled`],
    ["underscored slash", "Lost_/_Cancelled"],
    ["upper spaced", "LOST / CANCELLED"],
    ["spaced legacy suffix", "Lost / Cancelled (Legacy)"],
    ["compact", "Lost/Cancelled"],
    ["compact legacy", "Lost/Cancelled (Legacy)"],
    ["surrounding spaces", "  Lost / Cancelled  "],
    ["bare hold", "Hold"],
    ["canonical hold", "Hold (LEGACY)"],
    ["tabs around hold", `${TAB}Hold${TAB}`],
    ["NBSP around hold", `${NBSP}Hold${NBSP}`],
    ["leading underscore (becomes a space, so NOT off-board)", "_Hold"],
    ["trailing underscore", "Hold_"],
    ["board stage", "Closed"],
    ["hyphen stage", "Pre-Construction"],
    ["spaced hyphen stage", "Pre - Construction"],
    ["service stage", "Service - In Production"],
    ["service final invoice", "Service - Close Out Final Invoice"],
    ["unknown stage", "Warranty - Punch List"],
    ["unknown SLASH stage", "Design / Build"],
    ["unknown compact slash stage", "Design/Build"],
    ["non-ASCII lower()", "HÖLD (LEGACY)"],
    ["kelvin sign", `HOL${String.fromCodePoint(0x212a)}`],
    ["empty", ""],
    ["only whitespace", ` ${TAB} `],
    ["null", null],
  ];

  it("agrees with isPortfolioProjectOffBoardStage on every slash and whitespace input", async () => {
    await pg.exec(MIGRATION_SQL);

    const disagreements: Array<{ label: string; value: string | null; sql: boolean; ts: boolean }> = [];
    const tsVerdicts: boolean[] = [];
    for (const [label, value] of PARITY_INPUTS) {
      const sql = await sqlIsOffBoard(value);
      const ts = isPortfolioProjectOffBoardStage(value);
      tsVerdicts.push(ts);
      if (sql !== ts) disagreements.push({ label, value, sql, ts });
    }
    expect(disagreements).toEqual([]);

    // NOT VACUOUS: agreement is worthless if every input lands on the same answer.
    expect(tsVerdicts.filter(Boolean).length).toBeGreaterThanOrEqual(15);
    expect(tsVerdicts.filter((verdict) => !verdict).length).toBeGreaterThanOrEqual(10);
  });

  it("agrees with every off-board alias spelling, and does not over-match", async () => {
    await pg.exec(MIGRATION_SQL);
    for (const alias of PORTFOLIO_OFF_BOARD_STAGE_ALIASES) {
      expect({ alias, off: await sqlIsOffBoard(alias) }).toEqual({ alias, off: true });
    }
    for (const stage of ["Pre-Construction", "Service - In Production", "Closed", "Buy Out", "Design / Build", ""]) {
      expect({ stage, off: await sqlIsOffBoard(stage) })
        .toEqual({ stage, off: isPortfolioProjectOffBoardStage(stage) });
    }
  });

  /**
   * THREE-WAY WRITER PARITY, restricted to the spellings this release changed.
   *
   * `is_board_relevant` has three writers — the seed CLI, the webhook relay and the migration — and a fix
   * applied to the shared classifier only helps if all three now say the same thing about a spaced legacy
   * stage. Any input where they disagree is a defect whichever one is "right".
   */
  const WRITER_PARITY_INPUTS = [
    "Lost / Cancelled",
    "Lost  /  Cancelled",
    "Lost /Cancelled",
    "Lost/ Cancelled",
    "LOST / CANCELLED",
    "Lost_/_Cancelled",
    "Lost / Cancelled (Legacy)",
    "Lost/Cancelled",
    "Hold",
    "_Hold",
    "Design / Build",
    "Pre-Construction",
    "Closed",
  ];

  it("seed, relay and migration agree on is_board_relevant for every slash spelling", async () => {
    await pg.exec(MIGRATION_SQL);

    const disagreements: Array<Record<string, unknown>> = [];
    const relevantVerdicts: boolean[] = [];
    for (const rawStage of WRITER_PARITY_INPUTS) {
      // 1. SEED — relevant unless it is rejected as a non-board-relevant stage.
      const seeded = toPortfolioSeedCandidate({
        procore_id: "p1", project_number: "PN-1", name: "P", display_name: null,
        stage: null, project_stage_name: rawStage, active: true,
        company_id: "598134325683880", company_name: "T", estimated_value: null, total_value: null,
        last_synced_at: null, procore_updated_at: null, updated_at: null, properties: {},
      } as any);
      const seedRelevant = !("reason" in seeded && seeded.reason === "non_board_relevant_stage");

      // 2. RELAY — the flag it writes onto the row.
      const relayRelevant = validateSyncHubProjectStageChangedPayload({
        eventType: "procore.project.stage_changed",
        procore: { companyId: "598134325683880", portfolioProjectId: "1", currentStage: rawStage },
        stageChange: { previousStage: null, newStage: rawStage },
      }).stage.current.isBoardRelevant;

      // 3. MIGRATION — relevant iff its SQL classifier does not call the raw stage off-board.
      const migrationRelevant = !(await sqlIsOffBoard(rawStage));

      relevantVerdicts.push(migrationRelevant);
      if (new Set([seedRelevant, relayRelevant, migrationRelevant]).size > 1) {
        disagreements.push({
          rawStage, seedRelevant, relayRelevant, migrationRelevant,
          classifier: isPortfolioProjectBoardRelevantStage(rawStage),
        });
      }
    }
    expect(disagreements).toEqual([]);

    // Non-vacuous: the slash spellings really do resolve to "not relevant" now.
    expect(relevantVerdicts.filter((relevant) => !relevant).length).toBeGreaterThanOrEqual(8);
    expect(relevantVerdicts.filter(Boolean).length).toBeGreaterThanOrEqual(4);
  });
});
