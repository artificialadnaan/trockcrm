// =============================================================================
// The mirror UPDATE's change-guard, against a REAL planner.
//
// The guard has always existed — `WHERE id = $1 AND … AND (name IS DISTINCT FROM $2 OR …)` — and it
// never once declined to write. 838 deals were re-written every sync cycle, each firing the audit
// trigger twice: ~121k audit rows a day asserting nothing, on a table that reached 22.7M rows / 18 GB.
//
// TWO CAUSES, and only the first is a mistake:
//
//   PRECISION  the money columns are numeric(14,2) / numeric(9,4) and the export sends full float
//              precision, so the guard compared a rounded stored value against an unrounded incoming
//              one. In Postgres, 666.67 IS DISTINCT FROM '666.6666666666666' is TRUE; cast to the
//              column's type it is FALSE. Same defect #1151 fixed in the audit comparison.
//   THE CLOCK  `bid_board_last_updated_at` is the sync cycle's own timestamp, so it differs on every
//              run and made the guard pass unconditionally regardless of the above.
//
// THE COLUMN TYPES HERE ARE THE PRODUCTION ONES ON PURPOSE. The sibling estimator test declares
// `bid_board_total_sales numeric` — unconstrained — which never rounds, so this bug is invisible on
// that fixture. A test that cannot round cannot observe the defect it is named for.
//
// And this runs the REAL exported SQL against PGlite rather than string-matching it, for the reason
// that file already documents: a mocked query never reaches a planner, and never answers the only
// question that matters here — did the row actually get written?
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  buildBidBoardDealUpdateSql,
  updateParams,
  type NormalizedBidBoardRow,
} from "../../../src/modules/bid-board-sync/service.js";

const SCHEMA = "office_test";
const DEAL_ID = "00000000-0000-4000-8000-0000000000e1";

let pg: PGlite;
let client: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }> };

/** What the deal already holds — the values Postgres rounded on the PREVIOUS write. */
const STORED = {
  name: "Rowlett Station",
  status: "Estimate in Progress",
  projectNumber: "DFW-4-26026-ag",
  totalSales: "737.70",
  projectCost: "450.00",
  marginPct: "39.0000",
};

/** What the export sends THIS cycle — identical values at full float precision. */
function unchangedRow(overrides: Partial<NormalizedBidBoardRow> = {}): NormalizedBidBoardRow {
  return {
    name: STORED.name,
    bidBoardProjectId: null,
    bidBoardEstimator: null,
    bidBoardOffice: null,
    bidBoardStatus: STORED.status,
    bidBoardSalesPricePerArea: null,
    bidBoardProjectCost: "450",
    bidBoardProfitMarginPct: "39",
    bidBoardTotalSales: "737.7049180327868",
    bidBoardCreatedAt: null,
    bidBoardDueDate: null,
    bidBoardCustomerName: null,
    bidBoardCustomerContactRaw: null,
    bidBoardProjectNumber: STORED.projectNumber,
    ...overrides,
  };
}

async function runMirrorUpdate(row: NormalizedBidBoardRow, cycleClock: string) {
  const sql = buildBidBoardDealUpdateSql(SCHEMA);
  const params = updateParams(DEAL_ID, row, cycleClock, null);
  const r = await client.query(sql, params);
  return r.rowCount ?? 0;
}

async function seed() {
  await client.query(`DELETE FROM ${SCHEMA}.deals WHERE id = $1`, [DEAL_ID]);
  await client.query(
    `INSERT INTO ${SCHEMA}.deals
       (id, name, bid_board_status, bid_board_project_number,
        bid_board_total_sales, bid_board_project_cost, bid_board_profit_margin_pct,
        bid_board_last_updated_at)
     VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$7::numeric,$8::timestamptz)`,
    [DEAL_ID, STORED.name, STORED.status, STORED.projectNumber,
     STORED.totalSales, STORED.projectCost, STORED.marginPct, "2026-09-18T20:00:00Z"]
  );
}

beforeAll(async () => {
  pg = new PGlite();
  client = {
    query: async (text, params) => {
      const r: any = await pg.query(text, params);
      return { ...r, rowCount: r.affectedRows ?? r.rowCount ?? r.rows?.length ?? 0 };
    },
  };
  await pg.exec(`
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.deals (
      id uuid PRIMARY KEY,
      name text,
      deal_number text,
      project_number text,
      bid_board_estimator text,
      bid_board_office text,
      bid_board_status text,
      bid_board_sales_price_per_area text,
      -- PRODUCTION PRECISION. Unconstrained numeric here would never round, and the bug would vanish.
      bid_board_project_cost numeric(14,2),
      bid_board_profit_margin_pct numeric(9,4),
      bid_board_total_sales numeric(14,2),
      bid_board_created_at timestamptz,
      bid_board_due_date date,
      bid_board_customer_name text,
      bid_board_customer_contact_raw text,
      bid_board_project_number text,
      bid_board_last_updated_at timestamptz,
      bid_board_detached_at timestamptz,
      estimator_user_id uuid,
      sales_source_user_id uuid,
      updated_at timestamptz
    );
  `);
});

afterAll(async () => { await pg.close(); });

describe("bid-board mirror UPDATE — the change-guard actually declines to write", () => {
  it("writes NOTHING when the cycle changed nothing, even though the export sends full precision", async () => {
    // The production case, 838 times a cycle: same values, more decimal places, and a fresh clock.
    await seed();
    const written = await runMirrorUpdate(unchangedRow(), "2026-09-18T21:46:00Z");
    expect(written).toBe(0);
  });

  it("still writes when a value genuinely moved", async () => {
    // Suppression must be about NO CHANGE, never about money being quiet.
    await seed();
    const written = await runMirrorUpdate(
      unchangedRow({ bidBoardTotalSales: "999.99" }),
      "2026-09-18T21:46:00Z"
    );
    expect(written).toBe(1);
    const { rows } = await client.query(
      `SELECT bid_board_total_sales::text AS v FROM ${SCHEMA}.deals WHERE id = $1`, [DEAL_ID]
    );
    expect(rows[0].v).toBe("999.99");
  });

  it("writes when a rounded-but-real cent moves, which the precision cast must not swallow", async () => {
    await seed();
    // 737.7049… rounds to 737.70 (no write); 737.7149… rounds to 737.71 (a real cent).
    expect(await runMirrorUpdate(unchangedRow({ bidBoardTotalSales: "737.7149180327868" }), "2026-09-18T21:46:00Z")).toBe(1);
  });

  it("does not write for the clock alone — and leaves the stored clock untouched", async () => {
    await seed();
    const before = await client.query(
      `SELECT bid_board_last_updated_at::text AS v FROM ${SCHEMA}.deals WHERE id = $1`, [DEAL_ID]
    );
    await runMirrorUpdate(unchangedRow(), "2026-09-19T05:00:00Z");
    const after = await client.query(
      `SELECT bid_board_last_updated_at::text AS v FROM ${SCHEMA}.deals WHERE id = $1`, [DEAL_ID]
    );
    expect(after.rows[0].v).toBe(before.rows[0].v);
  });

  it("DOES advance the clock when a real change carries the write", async () => {
    // The clock is still SET — it is only barred from being the reason a write happens.
    await seed();
    await runMirrorUpdate(unchangedRow({ bidBoardStatus: "Submitted" }), "2026-09-19T05:00:00Z");
    // Compare the INSTANT, not its rendering: ::text prints in the session zone, so a correct
    // 2026-09-19T05:00Z reads as "2026-09-18 23:00:00-06" and a naive substring check calls it wrong.
    const { rows } = await client.query(
      `SELECT (bid_board_last_updated_at = '2026-09-19T05:00:00Z'::timestamptz) AS advanced
         FROM ${SCHEMA}.deals WHERE id = $1`, [DEAL_ID]
    );
    expect(rows[0].advanced).toBe(true);
  });
});
