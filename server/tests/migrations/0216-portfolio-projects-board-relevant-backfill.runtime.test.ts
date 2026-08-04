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
  isPortfolioProjectBoardRelevantStage,
  isPortfolioProjectOffBoardStage,
  normalizePortfolioProjectStage,
} from "@trock-crm/shared/types";
import { toPortfolioSeedCandidate } from "../../src/modules/synchub/portfolio-projects-sync.js";
import { validateSyncHubProjectStageChangedPayload } from "../../src/modules/synchub/procore-project-stage-relay-service.js";

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

  /** The migration's own SQL classifier, driven directly. */
  async function sqlIsOffBoard(value: string | null): Promise<boolean> {
    const result = await pg.query<{ off: boolean }>(
      `SELECT pg_temp.portfolio_stage_is_off_board($1) AS off`,
      [value],
    );
    return result.rows[0].off;
  }

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
    await pg.exec(MIGRATION_SQL); // defines pg_temp.portfolio_stage_is_off_board
    for (const alias of PORTFOLIO_OFF_BOARD_STAGE_ALIASES) {
      expect({ alias, off: await sqlIsOffBoard(alias) })
        .toEqual({ alias, off: isPortfolioProjectOffBoardStage(alias) });
      expect(await sqlIsOffBoard(alias)).toBe(true);
    }

    // ...and does NOT over-match: board stages and unknown stages are both "not off-board".
    for (const stage of ["Pre-Construction", "Service - In Production", "Closed", "Buy Out", "Warranty - Punch List", ""]) {
      expect({ stage, off: await sqlIsOffBoard(stage) })
        .toEqual({ stage, off: isPortfolioProjectOffBoardStage(stage) });
    }
  });

  /**
   * THE PARITY TEST — the one that would have caught `btrim`, and the one that will catch the next
   * near-miss. Every entry is driven through BOTH implementations and required to agree; the assertion
   * is agreement, not a hardcoded expectation, so it stays honest as either side changes.
   *
   * Each input targets a specific primitive where a SQL spelling merely RESEMBLES the JS one:
   * whitespace character classes (POSIX [[:space:]] omits U+00A0 and the U+2000 block that JS \s
   * matches), trim semantics (btrim strips spaces only), lower() collation vs full-Unicode
   * toLowerCase, and hyphen-padding greediness.
   */
  const ADVERSARIAL_INPUTS: Array<[label: string, value: string | null]> = [
    ["plain canonical", "Hold (LEGACY)"],
    ["bare alias", "Hold"],
    ["upper", "HOLD"],
    ["surrounding spaces", "  Hold  "],
    ["TABS around", "\tHold\t"],                       // btrim leaves these -> the shipped bug
    ["newlines around", "\nHold\n"],
    ["CR around", "\rHold\r"],
    ["vertical tab / form feed", "\v\fHold\f\v"],
    ["NBSP around", " Hold "],               // POSIX [[:space:]] does NOT match NBSP
    ["ogham space mark", " Hold "],
    ["en/em quad block", " Hold "],
    ["line/para separator", " Hold "],
    ["narrow NBSP", " Hold "],
    ["medium mathematical space", " Hold "],
    ["ideographic space", "　Hold　"],
    ["BOM / zero-width nbsp", "﻿Hold﻿"],
    ["mixed leading+trailing", "\t  Hold　 \n"],
    ["internal tab", "Lost/Cancelled\t(Legacy)"],
    ["internal NBSP", "Lost/Cancelled (Legacy)"],
    ["internal doubled space", "Hold  (LEGACY)"],
    ["underscore separated", "LOST_CANCELLED (Legacy)"],
    ["LEADING underscore (becomes a space, so NOT off-board)", "_Hold"],
    ["TRAILING underscore", "Hold_"],
    ["spaced slash variant", "Lost / Cancelled (Legacy)"],
    ["tabbed slash variant", "Lost\t/\tCancelled (Legacy)"],
    ["bare lost/cancelled", "Lost/Cancelled"],
    ["doubled hyphen", "Pre--Construction"],
    ["spaced hyphen", "Pre - Construction"],
    ["tabbed hyphen", "Pre\t-\tConstruction"],
    ["hyphen with NBSP padding", "Pre - Construction"],
    ["board stage", "Closed"],
    ["service stage", "Service - In Production"],
    ["service final invoice", "Service - Close Out Final Invoice"],
    ["unknown stage", "Warranty - Punch List"],
    ["non-ASCII (lower() collation vs toLowerCase)", "HÖLD (LEGACY)"],
    ["turkish dotted capital I", "HOLDİ"],
    ["kelvin sign", "HOLK"],
    ["empty", ""],
    ["only whitespace", " \t  "],
    ["null", null],
  ];

  it("matches isPortfolioProjectOffBoardStage on every adversarial whitespace/unicode input", async () => {
    await pg.exec(MIGRATION_SQL);

    const disagreements: Array<{ label: string; value: string | null; sql: boolean; ts: boolean }> = [];
    const tsVerdicts: boolean[] = [];
    for (const [label, value] of ADVERSARIAL_INPUTS) {
      const sql = await sqlIsOffBoard(value);
      const ts = isPortfolioProjectOffBoardStage(value);
      tsVerdicts.push(ts);
      if (sql !== ts) disagreements.push({ label, value, sql, ts });
    }
    expect(disagreements).toEqual([]);

    // NOT VACUOUS: "they agree" is worthless if every input lands on the same answer. The whitespace
    // and unicode wrappers must genuinely still resolve to the legacy buckets, and the board/unknown
    // stages must genuinely not.
    expect(tsVerdicts.filter(Boolean).length).toBeGreaterThanOrEqual(15);
    expect(tsVerdicts.filter((verdict) => !verdict).length).toBeGreaterThanOrEqual(10);
  });

  /**
   * LOCALE-INDEPENDENCE GUARD — and the only kind of check that can cover this class of bug.
   *
   * PostgreSQL evaluates POSIX character classes per the active collation/locale; JS \s is a fixed set
   * of code points. So a POSIX class in the mirror is correct-under-the-locale-we-tested rather than
   * correct. The parity test above CANNOT catch that: both sides run against the same backend, so they
   * agree in CI on every possible input and would diverge only in production.
   *
   * There is therefore no behavioural test to write. What is testable is the decision itself: the SQL
   * must not reach for a locale-defined class at all.
   */
  it("uses no POSIX character class — the mirror must not depend on the server locale", () => {
    // Executable SQL only: the header discusses [:space:] at length, and prose is not a dependency.
    const executableSql = MIGRATION_SQL.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    const posixClasses = [...executableSql.matchAll(/\[:[a-z]+:\]/g)].map((m) => m[0]);
    expect(posixClasses).toEqual([]);
  });

  it("defines `ws` as exactly JS \\s, in explicit code points, in every copy", async () => {
    // Pinned literally so a well-meaning "simplify" back to [:space:], or to the tempting
    // U+0009-U+0020 range (which swallows the C0 controls U+000E-U+001F that JS \s excludes),
    // fails here rather than in production.
    const expected = "'\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'";
    const declarations = [...MIGRATION_SQL.matchAll(/ws constant text := ('[^']*')/g)].map((m) => m[1]);
    expect(declarations.length).toBe(2);
    for (const declaration of declarations) expect(declaration).toBe(expected);

    // ...and the class the SQL actually applies matches JS \s character for character.
    await pg.exec(MIGRATION_SQL);
    const jsWhitespace = [
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
      0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
      0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
    ].map((code) => String.fromCodePoint(code));
    // Not whitespace in JS. NUL is omitted: Postgres text cannot store it.
    const notJsWhitespace = [0x0e, 0x1f, 0x61, 0x2d, 0x5f, 0x200b, 0x2060, 0x180e]
      .map((code) => String.fromCodePoint(code));

    for (const char of jsWhitespace) {
      expect({ cp: char.codePointAt(0), js: /\s/.test(char) }).toEqual({ cp: char.codePointAt(0), js: true });
      // Wrapping a legacy stage in it must still normalize away to the alias.
      expect(await sqlIsOffBoard(`${char}Hold${char}`)).toBe(true);
    }
    for (const char of notJsWhitespace) {
      expect({ cp: char.codePointAt(0), js: /\s/.test(char) }).toEqual({ cp: char.codePointAt(0), js: false });
      // ...and a non-whitespace wrapper must NOT be stripped, so it stays unrecognised.
      expect(await sqlIsOffBoard(`${char}Hold${char}`)).toBe(false);
    }
  });

  /**
   * THREE-WAY WRITER PARITY.
   *
   * `is_board_relevant` has three writers — the seed CLI, the webhook relay, and this migration —
   * and until now only the migration had been checked against the classifier. The relay had drifted:
   * it classified from the ALREADY-NORMALIZED stage, and normalizePortfolioProjectStage is not
   * idempotent for every input. `_Hold` normalizes to " hold" (JS trims before collapsing, so the
   * underscore becomes a leading space); feed that back in and the second pass trims it to "hold",
   * which IS a legacy alias. So the relay wrote false — the project vanished — while the seed and
   * the migration both called the same raw value unknown-but-relevant.
   *
   * The assertion is AGREEMENT, not correctness against a fourth opinion. Any input where the three
   * disagree is a defect whichever one is "right", and that is what catches the next one.
   */
  const WRITER_PARITY_INPUTS = [
    "Hold (LEGACY)", "Hold", "hold", "  Hold  ", "\tHold\t", " Hold ",
    "Lost/Cancelled (Legacy)", "Lost / Cancelled (Legacy)", "Lost/Cancelled",
    "_Hold",            // -> " hold": NOT off-board. The regression.
    "Hold_",            // -> "hold ": likewise not off-board.
    "_Lost/Cancelled",
    "Pre-Construction", "Estimating ", "Service - In Production",
    "Service - Close Out Final Invoice", "Closed", "Buy Out", "Bidding",
    "Warranty - Punch List", "",
  ];

  it("seed, relay and migration agree on is_board_relevant for every input", async () => {
    await pg.exec(MIGRATION_SQL);

    const disagreements: Array<Record<string, unknown>> = [];
    for (const rawStage of WRITER_PARITY_INPUTS) {
      // 1. SEED — a stage is relevant iff it is not excluded as non_board_relevant_stage.
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
        procore: { companyId: "598134325683880", portfolioProjectId: "1", currentStage: rawStage || "x" },
        stageChange: { previousStage: null, newStage: rawStage || "x" },
      }).stage.current.isBoardRelevant;

      // 3. MIGRATION — relevant iff the SQL classifier does not call it off-board.
      const migrationRelevant = !(await sqlIsOffBoard(rawStage));

      // ...and the shared classifier, for context in the failure output.
      const classifier = isPortfolioProjectBoardRelevantStage(rawStage);

      if (rawStage === "") continue; // the relay rejects an empty stage at validation, not here
      if (new Set([seedRelevant, relayRelevant, migrationRelevant]).size > 1) {
        disagreements.push({ rawStage, seedRelevant, relayRelevant, migrationRelevant, classifier });
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("a `_Hold` webhook stays board-relevant, matching the seed and the migration", async () => {
    // The regression in its own right: normalize -> " hold" -> re-normalize -> "hold" -> legacy.
    expect(normalizePortfolioProjectStage("_Hold")).toBe(" hold");
    expect(isPortfolioProjectOffBoardStage(normalizePortfolioProjectStage("_Hold"))).toBe(true); // the trap
    expect(isPortfolioProjectBoardRelevantStage("_Hold")).toBe(true);                            // the truth

    const relayed = validateSyncHubProjectStageChangedPayload({
      eventType: "procore.project.stage_changed",
      procore: { companyId: "598134325683880", portfolioProjectId: "1", currentStage: "_Hold" },
      stageChange: { previousStage: "Closed", newStage: "_Hold" },
    });
    expect(relayed.stage.current.isBoardRelevant).toBe(true);
  });

  it("keeps a tab-wrapped legacy stage OFF the board end to end", async () => {
    // The regression in its actual shape: a row, through the real migration, not just the helper.
    await insertProject(pg, "office_dallas", {
      id: "tabbed-hold",
      stage: "\tHold\t",
      normalized: "hold (legacy)",
      boardRelevant: false,
    });
    await insertProject(pg, "office_dallas", {
      id: "nbsp-lost",
      stage: " Lost/Cancelled (Legacy) ",
      normalized: "lost/cancelled (legacy)",
      boardRelevant: false,
    });

    await pg.exec(MIGRATION_SQL);
    const flags = await flagsFor(pg, "office_dallas");
    expect(flags["tabbed-hold"]).toBe(false);
    expect(flags["nbsp-lost"]).toBe(false);
  });
});
