import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEffectiveDealValue, isDealValueEffectivelyOnHold } from "@trock-crm/shared/types";
import {
  aliasedDealBestEstimateWithForecastSql,
  aliasedEffectiveDealValueSql,
  aliasedEffectiveWonDealValueSql,
  aliasedEffectiveOnHoldConditionSql,
  aliasedTerminalAwareEffectiveDealValueSql,
  aliasedTerminalDealBySlugSql,
  effectiveDealValueSql,
} from "../../../src/modules/shared/deal-value-sql.js";
import { aliasedStageAwareEffectiveDealValueSql } from "../../../src/modules/deals/deal-filter-predicates.js";
import { buildDealOnHoldCondition } from "../../../src/modules/shared/mine-visibility.js";
import { dealValueSqlForBasis } from "../../../src/modules/reports/foundations.js";
// The worker jobs are outside Drizzle and build raw SQL strings; this is the leaf module (no db/pool
// import) that weekly-digest and rep-performance-rollup both compose, so the reconciliation below runs the
// real production expression rather than a copy of it.
import { workerEffectiveCurrentDealValueSql } from "../../../../worker/src/jobs/deal-value-sql.js";

/**
 * CROSS-SURFACE reconciliation for the estimating bid-due-date hold rule (Adnaan, 2026-07-27).
 *
 * The rule changes what a deal is WORTH, and this codebase's single most recurring bug is a value rule
 * that lands on some surfaces and not others (the deals board says $0, the Director Scorecard says
 * $241k). Every surface reaches the rule through ONE of two shared string builders
 * (effectiveOnHoldSqlPredicate / closeTargetFarOutSqlPredicate), so this file takes the value expression
 * each family of surfaces actually uses and runs them ALL against the SAME rows, requiring one answer.
 *
 * It also pins the deliberate NON-changes: the REALIZED-safe helpers (won/lost value, the property
 * linked-value COLUMN form) must keep zeroing on the stored on_hold flag ONLY. A won deal that is still
 * sitting in the estimating stage in the CRM — 15 of 16 active Dallas estimating deals are Bid Board-owned
 * and can go terminal in the mirror — must never lose its realized revenue to a stale bid date.
 */

const dialect = new PgDialect();
const TERMINAL_STAGE_IDS = ["won", "lost"];

// A far-out bid due date is a timestamptz at UTC midnight (prod's storage shape); a near one is inside the
// 90-day horizon. Close targets are deliberately the OPPOSITE of the bid dates on the two estimating rows,
// so any surface still reading expected_close_date produces the WRONG answer rather than a coincidence.
const FAR = "2099-12-31";
const NEAR = "2026-01-15";
const FAR_TS = `${FAR}T00:00:00.000Z`;
const NEAR_TS = `${NEAR}T00:00:00.000Z`;

type Row = {
  id: string;
  stage_id: string;
  stage_slug: string;
  bid_board_stage_slug: string | null;
  expected_close_date: string | null;
  bid_due_date: string | null;
  bid_board_total_sales: number;
  /** What every OPEN-value surface must report for this row. */
  expectedOpenValue: number;
  /** What every effective-hold predicate must report for this row. */
  expectedHeld: boolean;
};

const ROWS: Row[] = [
  {
    id: "est_far_bid",
    stage_id: "estimating",
    stage_slug: "estimating",
    bid_board_stage_slug: null,
    expected_close_date: NEAR,
    bid_due_date: FAR_TS,
    bid_board_total_sales: 241000,
    expectedOpenValue: 0,
    expectedHeld: true,
  },
  {
    id: "est_near_bid",
    stage_id: "estimating",
    stage_slug: "estimating",
    bid_board_stage_slug: null,
    expected_close_date: FAR,
    bid_due_date: NEAR_TS,
    bid_board_total_sales: 89000,
    expectedOpenValue: 89000,
    expectedHeld: false,
  },
  // The control: the SAME date pair one stage over keeps the close-target rule byte-for-byte.
  {
    id: "sent_far_bid",
    stage_id: "estimate_sent_to_client",
    stage_slug: "estimate_sent_to_client",
    bid_board_stage_slug: null,
    expected_close_date: NEAR,
    bid_due_date: FAR_TS,
    bid_board_total_sales: 500000,
    expectedOpenValue: 500000,
    expectedHeld: false,
  },
];

// A Bid Board-won deal whose CRM stage is still `estimating`, with a far-out bid date. Kept out of ROWS
// because it is asserted against the REALIZED helpers, not the open ones.
const BB_WON_ESTIMATING_ID = "est_bb_won";
const BB_WON_ESTIMATING_VALUE = 750000;

let db: PGlite;

/** Evaluate an aliased SQL expression for every row, keyed by deal id. */
async function evaluate(expression: SQL): Promise<Map<string, string>> {
  const compiled = dialect.sqlToQuery(expression);
  const { rows } = await db.query<{ id: string; v: string }>(
    `SELECT d.id, (${compiled.sql})::text AS v
     FROM deals d
     LEFT JOIN pipeline_stage_config ON pipeline_stage_config.id = d.stage_id
     ORDER BY d.id`,
    compiled.params as unknown[]
  );
  return new Map(rows.map((r) => [r.id, r.v]));
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`SET TimeZone='UTC';`);
  await db.exec(`
    -- pipeline_stage_config exists ONLY in \`public\` in prod (verified against the live DB), which is what
    -- the shared predicate's subselect assumes. PGlite's default schema IS public.
    CREATE TABLE pipeline_stage_config (id text PRIMARY KEY, slug text NOT NULL);
    INSERT INTO pipeline_stage_config (id, slug) VALUES
      ('estimating', 'estimating'),
      ('estimate_sent_to_client', 'estimate_sent_to_client'),
      ('won', 'won'),
      ('lost', 'lost');
    CREATE TABLE deals (
      id text PRIMARY KEY,
      stage_id text NOT NULL,
      bid_board_stage_slug text,
      on_hold boolean NOT NULL DEFAULT false,
      expected_close_date date,
      bid_due_date timestamptz,
      forecast_revenue numeric,
      awarded_amount numeric,
      bid_board_total_sales numeric,
      bid_estimate numeric,
      dd_estimate numeric,
      is_active boolean NOT NULL DEFAULT true
    );
  `);
  for (const r of ROWS) {
    await db.query(
      `INSERT INTO deals (id, stage_id, bid_board_stage_slug, expected_close_date, bid_due_date, bid_board_total_sales)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.id, r.stage_id, r.bid_board_stage_slug, r.expected_close_date, r.bid_due_date, r.bid_board_total_sales]
    );
  }
  await db.query(
    `INSERT INTO deals (id, stage_id, bid_board_stage_slug, expected_close_date, bid_due_date, awarded_amount)
     VALUES ($1,'estimating','won',$2,$3,$4)`,
    [BB_WON_ESTIMATING_ID, NEAR, FAR_TS, BB_WON_ESTIMATING_VALUE]
  );
});

afterAll(async () => {
  await db?.close();
});

describe("estimating bid-due hold — every OPEN-value surface returns the same dollars", () => {
  // One entry per FAMILY of surfaces, named by what a user would see move. Each is the exact expression
  // that family builds in production; if a new family stops composing the shared predicate, it lands here.
  const openValueSurfaces: Array<[string, SQL]> = [
    // Deals list / board / stage page (aliasedStageAwareEffectiveDealValueSql), with the estimating stage-id
    // set threaded exactly as getDeals resolves it.
    [
      "deals list + kanban column + stage-page total",
      aliasedStageAwareEffectiveDealValueSql("d", ["won"], ["estimating"], ["lost"]),
    ],
    // Dashboard KPIs, Director Scorecard, region/estimator/monday-showcase report bases.
    ["dashboard + reports open value", aliasedEffectiveDealValueSql("d")],
    ["reports foundations 'open' basis", dealValueSqlForBasis("d", "open")],
    ["reports foundations 'forecast_first' basis", dealValueSqlForBasis("d", "forecast_first")],
    // Company Pipeline$ and the Properties linked-value fold — MIXED populations, so terminal-aware.
    [
      "company pipeline$ + property linked value",
      aliasedTerminalAwareEffectiveDealValueSql(
        "d",
        aliasedDealBestEstimateWithForecastSql("d"),
        aliasedTerminalDealBySlugSql("d", "pipeline_stage_config.slug")
      ),
    ],
  ];

  it.each(openValueSurfaces)("%s", async (_name, expression) => {
    const values = await evaluate(expression);
    for (const r of ROWS) {
      expect(Number(values.get(r.id)), `row ${r.id}`).toBe(r.expectedOpenValue);
    }
  });

  it("the worker's raw-SQL digest/rollup value expression agrees with all of them", async () => {
    // weekly-digest + rep-performance-rollup build their value CASE as a raw STRING (they are outside
    // Drizzle), so they can only inherit the rule through closeTargetFarOutSqlPredicate. This executes the
    // PRODUCTION builder both jobs use — not a hand-copied paste of it (CodeRabbit): a reproduction would
    // keep passing while the real worker SQL drifted, which is the exact failure this file exists to catch.
    // worker/src/jobs/deal-value-sql.ts is a leaf module (no pool/db import), so importing it here is safe.
    const workerValue = workerEffectiveCurrentDealValueSql("d");
    const { rows } = await db.query<{ id: string; v: string }>(
      `SELECT d.id, (${workerValue})::text AS v FROM deals d ORDER BY d.id`
    );
    const values = new Map(rows.map((r) => [r.id, r.v]));
    for (const r of ROWS) {
      expect(Number(values.get(r.id)), `row ${r.id}`).toBe(r.expectedOpenValue);
    }
  });

  it("the client TS resolver returns the same dollars for the same rows", async () => {
    // The card the user clicks must show what the header sums. This is the SQL-vs-TS twin check at the
    // value layer (on-hold-terminal-aware.runtime.test.ts covers it at the predicate layer).
    for (const r of ROWS) {
      const clientValue = getEffectiveDealValue({
        onHold: false,
        stageSlug: r.stage_slug,
        bidBoardStageSlug: r.bid_board_stage_slug,
        workflowRoute: "normal",
        expectedCloseDate: r.expected_close_date,
        bidDueDate: r.bid_due_date,
        bidBoardTotalSales: r.bid_board_total_sales,
      });
      expect(clientValue, `row ${r.id}`).toBe(r.expectedOpenValue);
    }
  });
});

describe("estimating bid-due hold — every effective-hold PREDICATE agrees", () => {
  const holdPredicates: Array<[string, SQL]> = [
    ["On Hold scope pill (buildDealOnHoldCondition)", buildDealOnHoldCondition("d", TERMINAL_STAGE_IDS)],
    ["terminal-aware hold condition", aliasedEffectiveOnHoldConditionSql("d", TERMINAL_STAGE_IDS)],
  ];

  it.each(holdPredicates)("%s", async (_name, expression) => {
    const held = await evaluate(expression);
    for (const r of ROWS) {
      expect(held.get(r.id) === "true", `row ${r.id}`).toBe(r.expectedHeld);
    }
  });

  it("the client TS twin agrees with the predicates", () => {
    for (const r of ROWS) {
      const clientHeld = isDealValueEffectivelyOnHold(
        {
          onHold: false,
          stageSlug: r.stage_slug,
          bidBoardStageSlug: r.bid_board_stage_slug,
          workflowRoute: "normal",
          expectedCloseDate: r.expected_close_date,
          bidDueDate: r.bid_due_date,
        },
        new Date()
      );
      expect(clientHeld, `row ${r.id}`).toBe(r.expectedHeld);
    }
  });
});

describe("estimating bid-due hold — the deliberate NON-changes", () => {
  it("REALIZED (won/lost) value is never auto-parked by a far-out bid due date", async () => {
    // A Bid Board-won deal sitting in the CRM estimating stage with a far-out bid date. Zeroing it would
    // silently drop realized revenue out of won/commission/report totals — the exact P1 the terminal
    // exemption exists to prevent, now reachable through a second date column.
    const won = await evaluate(aliasedEffectiveWonDealValueSql("d"));
    expect(Number(won.get(BB_WON_ESTIMATING_ID))).toBe(BB_WON_ESTIMATING_VALUE);

    const terminalAware = await evaluate(
      aliasedTerminalAwareEffectiveDealValueSql(
        "d",
        aliasedDealBestEstimateWithForecastSql("d"),
        aliasedTerminalDealBySlugSql("d", "pipeline_stage_config.slug")
      )
    );
    expect(Number(terminalAware.get(BB_WON_ESTIMATING_ID))).toBe(BB_WON_ESTIMATING_VALUE);
  });

  it("the OPEN dashboard/report value family preserves a Bid Board-terminal deal too", async () => {
    // These surfaces filter their population CRM-open (psc.slug NOT IN terminal), which leaves exactly one
    // terminal exposure: a deal already won/lost in the Bid Board MIRROR whose CRM stage is still open. The
    // deals board, the On Hold pill, the client resolver and the worker digest all exempted that row from
    // the far-out auto-park; aliasedEffectiveDealValueSql was the last family that did not, so a
    // Director-Scorecard-style query zeroed its realized value off a far-out horizon date (Codex P2). Both
    // date columns are far out on this row, so it fails under the old rule AND the new estimating one.
    for (const [name, expression] of [
      ["dashboard + reports open value", aliasedEffectiveDealValueSql("d")],
      ["reports foundations 'open' basis", dealValueSqlForBasis("d", "open")],
      [
        "deals board estimating branch",
        aliasedStageAwareEffectiveDealValueSql("d", ["won"], ["estimating"], ["lost"]),
      ],
    ] as Array<[string, SQL]>) {
      const values = await evaluate(expression);
      expect(Number(values.get(BB_WON_ESTIMATING_ID)), name).toBe(BB_WON_ESTIMATING_VALUE);
    }
  });

  it("the COLUMN-form value helper still zeroes on stored on_hold ONLY", () => {
    // Its consumer sums MIXED (open + won) linked deals with no terminal filter, so it deliberately carries
    // NO auto-park horizon at all — on either date column.
    const table = {
      onHold: sql.raw("d.on_hold"),
      awardedAmount: sql.raw("d.awarded_amount"),
      bidBoardTotalSales: sql.raw("d.bid_board_total_sales"),
      bidEstimate: sql.raw("d.bid_estimate"),
      ddEstimate: sql.raw("d.dd_estimate"),
    } as unknown as Parameters<typeof effectiveDealValueSql>[0];
    const emitted = dialect.sqlToQuery(effectiveDealValueSql(table)).sql.toLowerCase();
    expect(emitted).toContain("d.on_hold");
    expect(emitted).not.toContain("bid_due_date");
    expect(emitted).not.toContain("expected_close_date");
  });

  it("the COUNT predicate is unchanged — a far-out estimating deal is $0 but STILL COUNTED", async () => {
    // Deliberate, load-bearing asymmetry (PR #798): reportableDealSqlPredicate keys on the STORED flag
    // only, so auto-parked deals keep appearing in active counts while contributing $0. A reviewer
    // "fixing" the count to match the value would silently drop live deals off every dashboard tile.
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM deals d WHERE COALESCE(d.on_hold, false) = false`
    );
    expect(rows[0].n).toBe(ROWS.length + 1);
  });
});
