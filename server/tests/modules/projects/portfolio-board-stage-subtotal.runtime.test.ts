import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PORTFOLIO_PRODUCTION_ROLLUP_CONSTRUCTION_STAGES,
  PORTFOLIO_PRODUCTION_ROLLUP_SERVICE_STAGES,
  PORTFOLIO_PROJECT_BOARD_STAGES,
} from "@trock-crm/shared/types";
import {
  groupPortfolioProjectsForBoard,
  listPortfolioProjectBoard,
} from "../../../src/modules/projects/service.js";

/**
 * Load-bearing guard for the Projects/Portfolio board stage SUBTOTAL.
 *
 * Each stage column header sums the Contract Value (total_value) of EVERY project in
 * that stage column — the exact same set the column COUNT reflects. This mirrors the
 * deals board's server-computed column.totalValue. The subtotal is computed in the
 * grouping path (groupPortfolioProjectsForBoard) so the total and the count can never
 * disagree: they derive from the same column.projects array.
 *
 * Proven here, against real SQL + the real grouping path:
 *   - subtotal == sum of total_value over every project in the column (== the count set);
 *   - stale / unsynced values are still summed at their last-known number;
 *   - a null / "not synced" value contributes 0 (never NaN);
 *   - an empty stage column is 0 ($0), never NaN;
 *   - board-irrelevant rows are excluded from BOTH the count and the subtotal.
 *
 * Non-numeric / NaN robustness (which a numeric(14,2) column can never store) is proven
 * against the pure grouping function with hand-crafted rows.
 */

// Real-SQL fixtures: numeric(14,2) total_value spread across several stages, exercising
// synced, stale, zero, and null ("not synced") values, plus empty stages.
type SqlRow = { id: string; stage: string; total_value: string | null; synced: string | null };

const SQL_ROWS: SqlRow[] = [
  // "closed": two fresh values + one STALE value + one unsynced (null -> counts as 0)
  { id: "c1", stage: "closed", total_value: "9716.67", synced: "2026-05-25T09:34:15.318Z" },
  { id: "c2", stage: "closed", total_value: "100000.00", synced: "2026-05-25T09:34:15.318Z" },
  { id: "c3", stage: "closed", total_value: "250.33", synced: "2020-01-01T00:00:00.000Z" }, // stale, still summed
  { id: "c4", stage: "closed", total_value: null, synced: null }, // "Value not synced" -> 0
  // "in production": single value
  { id: "p1", stage: "in production", total_value: "500000.00", synced: "2026-05-25T09:34:15.318Z" },
  // "contract executed": a genuine $0
  { id: "e1", stage: "contract executed", total_value: "0.00", synced: "2026-05-25T09:34:15.318Z" },
  // --- the three production roll-up stages, construction track ---
  { id: "b1", stage: "buyout", total_value: "250000.00", synced: "2026-05-25T09:34:15.318Z" },
  { id: "pc1", stage: "pre-construction", total_value: "125000.00", synced: "2026-05-25T09:34:15.318Z" },
  { id: "pc2", stage: "pre-construction", total_value: null, synced: null }, // never synced -> $0
  // --- service track: split out, never folded into "in production" ---
  { id: "s1", stage: "service - in production", total_value: "40000.00", synced: "2020-01-01T00:00:00.000Z" }, // STALE
  { id: "s2", stage: "service - in production", total_value: null, synced: "2026-05-25T09:34:15.318Z" }, // synced, but no value
  // remaining board stages: intentionally EMPTY
];

// Pinned clock so the 7-day staleness cutoff is deterministic: one day after the "fresh"
// fixture syncs, so 2026-05-25 rows are fresh and the 2020 row is stale.
const NOW = new Date("2026-05-26T12:00:00.000Z");

const EXPECTED_ROLLUP = {
  construction: { totalValue: 250000 + 125000 + 500000, projectCount: 4, stale: 0, unsynced: 1 },
  service: { totalValue: 40000, projectCount: 2, stale: 1, unsynced: 1 },
};

// Board-irrelevant row: must NOT appear in the count nor the subtotal even though it
// carries a large value and a board stage.
const IRRELEVANT_ROW: SqlRow = {
  id: "x1",
  stage: "closed",
  total_value: "999999.99",
  synced: null,
};

// Every board stage defaults to an empty column; the entries below are the populated ones.
// Derived from the shared stage list so adding a column cannot leave a hole in this table.
const emptyByStage = () =>
  Object.fromEntries(PORTFOLIO_PROJECT_BOARD_STAGES.map((stage) => [stage, 0])) as Record<string, number>;

const EXPECTED_TOTAL: Record<string, number> = {
  ...emptyByStage(),
  closed: 9716.67 + 100000 + 250.33 + 0, // 109,967.00 (irrelevant 999,999.99 excluded)
  "in production": 500000,
  "contract executed": 0,
  buyout: 250000,
  "pre-construction": 125000,
  "service - in production": 40000, // service value is NOT folded into "in production"
};

const EXPECTED_COUNT: Record<string, number> = {
  ...emptyByStage(),
  closed: 4,
  "contract executed": 1,
  "in production": 1,
  buyout: 1,
  "pre-construction": 2,
  "service - in production": 2,
};

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE portfolio_projects (
      id text PRIMARY KEY,
      procore_company_id text NOT NULL,
      procore_project_id text NOT NULL,
      project_number text,
      name text NOT NULL,
      current_stage text NOT NULL,
      current_stage_normalized text NOT NULL,
      current_stage_entered_at timestamptz,
      total_value numeric(14,2),
      value_synced_at timestamptz,
      is_board_relevant boolean NOT NULL DEFAULT false,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const insert = async (r: SqlRow, boardRelevant: boolean) => {
    await db.query(
      `INSERT INTO portfolio_projects
         (id, procore_company_id, procore_project_id, project_number, name,
          current_stage, current_stage_normalized, current_stage_entered_at,
          total_value, value_synced_at, is_board_relevant, first_seen_at, updated_at)
       VALUES ($1, 'co', 'pj-' || $1, 'PN-' || $1, 'Project ' || $1, $2, $2,
          '2026-05-20T12:00:00.000Z', $3, $4, $5,
          '2026-05-18T12:00:00.000Z', '2026-05-21T12:00:00.000Z')`,
      [r.id, r.stage, r.total_value, r.synced, boardRelevant],
    );
  };

  for (const r of SQL_ROWS) await insert(r, true);
  await insert(IRRELEVANT_ROW, false);
});

afterAll(async () => {
  await db?.close();
});

// listPortfolioProjectBoard only needs a `query` executor; PGlite supplies real Postgres.
const tenantClient = () =>
  ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

describe("portfolio board stage subtotal — real SQL", () => {
  it("sums every project's contract value per stage (stale included, null -> 0) and matches the counted set", async () => {
    const board = await listPortfolioProjectBoard(tenantClient(), NOW);

    for (const column of board.stages) {
      // count and subtotal must describe the same set of projects
      expect(column.projects.length).toBe(EXPECTED_COUNT[column.stage]);
      expect(column.totalValue).toBeCloseTo(EXPECTED_TOTAL[column.stage], 2);

      // the subtotal is exactly the sum over the column's own (counted) projects
      const handSum = column.projects.reduce(
        (sum, project) => sum + (Number(project.totalValue) || 0),
        0,
      );
      expect(column.totalValue).toBeCloseTo(handSum, 2);

      // robustness: never NaN, even for the empty / null-value columns
      expect(Number.isFinite(column.totalValue)).toBe(true);
    }
  });

  it("excludes board-irrelevant rows from both the count and the subtotal", async () => {
    const board = await listPortfolioProjectBoard(tenantClient(), NOW);
    const closed = board.stages.find((column) => column.stage === "closed");

    expect(closed).toBeDefined();
    expect(closed!.projects.some((project) => project.id === "x1")).toBe(false);
    // 999,999.99 of the irrelevant row is NOT folded into the subtotal
    expect(closed!.totalValue).toBeCloseTo(109967.0, 2);
  });
});

describe("production revenue roll-up — real SQL", () => {
  it("reconciles EXACTLY with the stage columns it summarises", async () => {
    const board = await listPortfolioProjectBoard(tenantClient(), NOW);
    const { productionRollup: rollup } = board;
    const columnTotal = (stage: string) =>
      board.stages.find((column) => column.stage === stage)?.totalValue ?? 0;
    const columnCount = (stage: string) =>
      board.stages.find((column) => column.stage === stage)?.projects.length ?? 0;

    // The card's construction number is the sum of ITS OWN columns on the board below it.
    const constructionFromColumns = PORTFOLIO_PRODUCTION_ROLLUP_CONSTRUCTION_STAGES
      .reduce((sum, stage) => sum + columnTotal(stage), 0);
    const serviceFromColumns = PORTFOLIO_PRODUCTION_ROLLUP_SERVICE_STAGES
      .reduce((sum, stage) => sum + columnTotal(stage), 0);

    expect(rollup.construction.totalValue).toBeCloseTo(constructionFromColumns, 2);
    expect(rollup.service.totalValue).toBeCloseTo(serviceFromColumns, 2);
    expect(rollup.totalValue).toBeCloseTo(constructionFromColumns + serviceFromColumns, 2);

    // ...and the counts describe the same set as those columns.
    expect(rollup.construction.projectCount).toBe(
      PORTFOLIO_PRODUCTION_ROLLUP_CONSTRUCTION_STAGES.reduce((sum, stage) => sum + columnCount(stage), 0),
    );
    expect(rollup.service.projectCount).toBe(
      PORTFOLIO_PRODUCTION_ROLLUP_SERVICE_STAGES.reduce((sum, stage) => sum + columnCount(stage), 0),
    );
  });

  it("totals Buy Out + Pre-Construction + In Production, with service split out (never merged)", async () => {
    const { productionRollup: rollup } = await listPortfolioProjectBoard(tenantClient(), NOW);

    expect(rollup.construction.totalValue).toBeCloseTo(EXPECTED_ROLLUP.construction.totalValue, 2);
    expect(rollup.construction.projectCount).toBe(EXPECTED_ROLLUP.construction.projectCount);
    expect(rollup.service.totalValue).toBeCloseTo(EXPECTED_ROLLUP.service.totalValue, 2);
    expect(rollup.service.projectCount).toBe(EXPECTED_ROLLUP.service.projectCount);

    // Combined, but still individually addressable — service is never silently absorbed.
    expect(rollup.totalValue).toBeCloseTo(875000 + 40000, 2);
    expect(rollup.projectCount).toBe(6);
    expect(rollup.service.totalValue).not.toBe(0);
    expect(rollup.construction.totalValue).not.toBe(rollup.totalValue);

    // Stages OUTSIDE the roll-up contribute nothing: "closed" holds 109,967.00 on the board
    // and none of it is in the card.
    expect(rollup.totalValue).toBe(915000);
    expect(rollup.totalValue).not.toBeCloseTo(915000 + 109967, 2);
  });

  it("counts stale and never-synced values as the caveat the card has to show", async () => {
    const { productionRollup: rollup } = await listPortfolioProjectBoard(tenantClient(), NOW);

    // pc2 has no value at all; s2 has a sync timestamp but a NULL value — both count as $0
    // in the total, so both belong in the "no synced value" caveat.
    expect(rollup.construction.unsyncedValueCount).toBe(EXPECTED_ROLLUP.construction.unsynced);
    expect(rollup.service.unsyncedValueCount).toBe(EXPECTED_ROLLUP.service.unsynced);
    expect(rollup.unsyncedValueCount).toBe(2);

    // s1's value IS counted, but it was last synced in 2020 — stale, not missing.
    expect(rollup.construction.staleValueCount).toBe(EXPECTED_ROLLUP.construction.stale);
    expect(rollup.service.staleValueCount).toBe(EXPECTED_ROLLUP.service.stale);
    expect(rollup.staleValueCount).toBe(1);

    // Stale and unsynced never double-count the same project.
    expect(rollup.staleValueCount + rollup.unsyncedValueCount).toBeLessThanOrEqual(rollup.projectCount);
    expect(rollup.staleAfterDays).toBe(7);
  });

  it("counts a null-valued project as $0 in the total AND in the not-synced caveat", async () => {
    const { productionRollup: rollup, stages } = await listPortfolioProjectBoard(tenantClient(), NOW);
    const preConstruction = stages.find((column) => column.stage === "pre-construction");

    // pc2 (null value) is counted as a project...
    expect(preConstruction?.projects.length).toBe(2);
    // ...contributes 0 to the money...
    expect(preConstruction?.totalValue).toBeCloseTo(125000, 2);
    // ...and is declared as missing rather than passed off as a real $0.
    expect(rollup.construction.unsyncedValueCount).toBe(1);
  });
});

describe("portfolio board — unmapped stages never vanish", () => {
  it("keeps a stage nobody anticipated in the board's project list and in an Other column", () => {
    const board = groupPortfolioProjectsForBoard([
      {
        id: "known",
        procore_project_id: "pj-known",
        procore_company_id: "co",
        project_number: null,
        name: "Known",
        current_stage: "Closed",
        current_stage_normalized: "closed",
        current_stage_entered_at: null,
        total_value: 1000,
        value_synced_at: null,
        first_seen_at: "2026-05-18T12:00:00.000Z",
        updated_at: "2026-05-21T12:00:00.000Z",
      },
      {
        id: "surprise",
        procore_project_id: "pj-surprise",
        procore_company_id: "co",
        project_number: null,
        name: "Brand New Procore Stage",
        current_stage: "Warranty - Punch List",
        current_stage_normalized: "warranty - punch list",
        current_stage_entered_at: null,
        total_value: 777,
        value_synced_at: null,
        first_seen_at: "2026-05-18T12:00:00.000Z",
        updated_at: "2026-05-21T12:00:00.000Z",
      },
    ], NOW);

    // Present in the flat list (the board header's "N projects" count).
    expect(board.projects.map((project) => project.id).sort()).toEqual(["known", "surprise"]);

    // AND visible in a column, with its money counted.
    const other = board.stages.find((column) => column.stage === "unmapped");
    expect(other).toBeDefined();
    expect(other!.label).toBe("Other / No Column");
    expect(other!.projects.map((project) => project.id)).toEqual(["surprise"]);
    expect(other!.totalValue).toBe(777);
    expect(other!.projects[0].currentStageNormalized).toBe("warranty - punch list");
  });

  it("omits the Other column entirely when every stage maps to a real column", () => {
    const board = groupPortfolioProjectsForBoard([], NOW);
    expect(board.stages.some((column) => column.stage === "unmapped")).toBe(false);
    expect(board.stages.map((column) => column.stage)).toEqual([...PORTFOLIO_PROJECT_BOARD_STAGES]);
  });
});

describe("portfolio board stage subtotal — grouping robustness (pure)", () => {
  const row = (over: { id: string; stage: string; total_value: unknown; synced?: string | null }) => ({
    id: over.id,
    procore_project_id: `pj-${over.id}`,
    procore_company_id: "co",
    project_number: null,
    name: `Project ${over.id}`,
    current_stage: over.stage,
    current_stage_normalized: over.stage,
    current_stage_entered_at: null,
    total_value: over.total_value,
    value_synced_at: over.synced ?? null,
    first_seen_at: "2026-05-18T12:00:00.000Z",
    updated_at: "2026-05-21T12:00:00.000Z",
  });

  it("coalesces null / non-numeric / NaN / undefined contract values to 0 without NaN-ing the total", () => {
    const board = groupPortfolioProjectsForBoard([
      row({ id: "a", stage: "closed", total_value: 1000 }),
      row({ id: "b", stage: "closed", total_value: null }),
      row({ id: "c", stage: "closed", total_value: "not-a-number" }),
      row({ id: "d", stage: "closed", total_value: NaN }),
      row({ id: "e", stage: "closed", total_value: undefined }),
    ]);

    const closed = board.stages.find((column) => column.stage === "closed");
    expect(closed).toBeDefined();
    expect(closed!.projects.length).toBe(5); // every project still counted
    expect(closed!.totalValue).toBe(1000); // only the one valid value contributes
    expect(Number.isNaN(closed!.totalValue)).toBe(false);
  });

  it("coalesces non-finite (Infinity / -Infinity) contract values to 0", () => {
    const board = groupPortfolioProjectsForBoard([
      row({ id: "v", stage: "closed", total_value: 1000 }),
      row({ id: "inf", stage: "closed", total_value: Infinity }),
      row({ id: "ninf", stage: "closed", total_value: -Infinity }),
      row({ id: "infstr", stage: "closed", total_value: "Infinity" }),
    ]);
    const closed = board.stages.find((column) => column.stage === "closed");
    expect(closed).toBeDefined();
    expect(closed!.totalValue).toBe(1000); // non-finite values contribute 0, never Infinity
    expect(Number.isFinite(closed!.totalValue)).toBe(true);
  });

  it("returns 0 (never NaN) for every empty stage column", () => {
    const board = groupPortfolioProjectsForBoard([]);
    for (const column of board.stages) {
      expect(column.projects).toEqual([]);
      expect(column.totalValue).toBe(0);
    }
  });

  it("keeps stale values in the subtotal at their last-known number", () => {
    const board = groupPortfolioProjectsForBoard([
      row({ id: "fresh", stage: "in production", total_value: 200, synced: "2026-05-25T00:00:00.000Z" }),
      row({ id: "stale", stage: "in production", total_value: 300, synced: "2019-01-01T00:00:00.000Z" }),
    ]);
    const col = board.stages.find((column) => column.stage === "in production");
    expect(col).toBeDefined();
    expect(col!.totalValue).toBe(500);
  });
});
