import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  // "bidding" / "buyout" / "close out" / "close out - final invoice": intentionally EMPTY
];

// Board-irrelevant row: must NOT appear in the count nor the subtotal even though it
// carries a large value and a board stage.
const IRRELEVANT_ROW: SqlRow = {
  id: "x1",
  stage: "closed",
  total_value: "999999.99",
  synced: null,
};

const EXPECTED_TOTAL: Record<string, number> = {
  bidding: 0,
  buyout: 0,
  "close out": 0,
  "close out - final invoice": 0,
  closed: 9716.67 + 100000 + 250.33 + 0, // 109,967.00 (irrelevant 999,999.99 excluded)
  "contract executed": 0,
  "in production": 500000,
};

const EXPECTED_COUNT: Record<string, number> = {
  bidding: 0,
  buyout: 0,
  "close out": 0,
  "close out - final invoice": 0,
  closed: 4,
  "contract executed": 1,
  "in production": 1,
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
    const board = await listPortfolioProjectBoard(tenantClient());

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
    const board = await listPortfolioProjectBoard(tenantClient());
    const closed = board.stages.find((column) => column.stage === "closed");

    expect(closed).toBeDefined();
    expect(closed!.projects.some((project) => project.id === "x1")).toBe(false);
    // 999,999.99 of the irrelevant row is NOT folded into the subtotal
    expect(closed!.totalValue).toBeCloseTo(109967.0, 2);
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
