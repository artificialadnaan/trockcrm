import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  buildBidBoardDealUpdateSql,
  updateParams,
  type NormalizedBidBoardRow,
} from "../../../src/modules/bid-board-sync/service.js";

/**
 * Runtime (PGlite) proof that the Bid Board deal-mirror UPDATE PARSES against a real Postgres
 * planner when estimator_user_id ($16) is NULL — the production case for every deal without a
 * mapped estimator.
 *
 * Regression for the P0 ingest outage (2026-06-18): PR #741 rewrote the estimator write from a
 * type-pinned `estimator_user_id = $16` / `... IS DISTINCT FROM $16` into
 * `COALESCE(estimator_user_id, $16)` + a bare `$16 IS NOT NULL`. The bare NullTest gives Postgres
 * no type context, so Parse fails with `could not determine data type of parameter $16` (SQLSTATE
 * 42P18) — aborting the whole ingest transaction → CRM 500 → SyncHub drops every Bid Board push.
 *
 * The pre-existing estimator tests mock `pool.connect`/`query` with string matching, so the UPDATE
 * never reaches a planner and this class of bug is invisible — which is exactly how #741 passed CI.
 * This test runs the REAL exported SQL + params against PGlite so the parse step actually executes.
 */

const SCHEMA = "office_test";
const DEAL_ID = "00000000-0000-4000-8000-0000000000d1";
const ESTIMATOR_ID = "11111111-1111-4111-8111-111111111111";

let pg: PGlite;
let client: {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
};

function normalizedRow(overrides: Partial<NormalizedBidBoardRow> = {}): NormalizedBidBoardRow {
  return {
    name: "Bellamy Executive Park (updated)", // differs from the seed name so the UPDATE's WHERE matches
    bidBoardProjectId: null,
    bidBoardEstimator: null,
    bidBoardOffice: null,
    bidBoardStatus: "Estimate in Progress",
    bidBoardSalesPricePerArea: null,
    bidBoardProjectCost: null,
    bidBoardProfitMarginPct: null,
    bidBoardTotalSales: null,
    bidBoardCreatedAt: null,
    bidBoardDueDate: null,
    bidBoardCustomerName: null,
    bidBoardCustomerContactRaw: null,
    bidBoardProjectNumber: "ATL-4-16326-ab",
    ...overrides,
  };
}

async function seedDeal(estimatorUserId: string | null) {
  await client.query(`DELETE FROM ${SCHEMA}.deals WHERE id = $1`, [DEAL_ID]);
  await client.query(
    `INSERT INTO ${SCHEMA}.deals (id, name, estimator_user_id) VALUES ($1, $2, $3::uuid)`,
    [DEAL_ID, "Bellamy Executive Park", estimatorUserId]
  );
}

async function estimatorOf(id: string): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT estimator_user_id::text AS estimator_user_id FROM ${SCHEMA}.deals WHERE id = $1`,
    [id]
  );
  return rows[0]?.estimator_user_id ?? null;
}

beforeAll(async () => {
  pg = new PGlite();
  // node-pg exposes rowCount; PGlite exposes affectedRows. The production code reads rowCount, so
  // present a node-pg-compatible shape here (harness adapter, not a code change).
  client = {
    query: async (text, params) => {
      const r: any = await pg.query(text, params);
      return { ...r, rowCount: r.affectedRows ?? r.rowCount ?? r.rows?.length ?? 0 };
    },
  };
  await pg.exec(`
    CREATE SCHEMA office_test;
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY,
      name text,
      deal_number text,
      project_number text,
      bid_board_estimator text,
      bid_board_office text,
      bid_board_status text,
      bid_board_sales_price_per_area numeric,
      bid_board_project_cost numeric,
      bid_board_profit_margin_pct numeric,
      bid_board_total_sales numeric,
      bid_board_created_at timestamptz,
      bid_board_due_date date,
      bid_board_customer_name text,
      bid_board_customer_contact_raw text,
      bid_board_project_number text,
      estimator_user_id uuid,
      bid_board_last_updated_at timestamptz,
      updated_at timestamptz DEFAULT now()
    );
  `);
}, 30000); // PGlite cold-start can exceed the default 10s hook timeout when runtime suites start in parallel

afterAll(async () => {
  await pg?.close?.();
});

describe("Bid Board deal-mirror UPDATE — $16 (estimator_user_id) parameter type (runtime)", () => {
  it("PARSES and executes when estimator_user_id ($16) is NULL (the prod default — no mapped estimator)", async () => {
    await seedDeal(null);
    const sql = buildBidBoardDealUpdateSql(SCHEMA);

    // Before the fix this REJECTS at Parse with `could not determine data type of parameter $16`.
    await expect(
      client.query(sql, updateParams(DEAL_ID, normalizedRow(), "2026-06-18T20:32:00Z", null))
    ).resolves.toBeTruthy();

    expect(await estimatorOf(DEAL_ID)).toBeNull();
  });

  it("fills an empty estimator with the incoming id (empties-only COALESCE still works post-cast)", async () => {
    await seedDeal(null);
    const sql = buildBidBoardDealUpdateSql(SCHEMA);

    const res = await client.query(
      sql,
      updateParams(DEAL_ID, normalizedRow(), "2026-06-18T20:32:00Z", ESTIMATOR_ID)
    );

    expect(res.rowCount ?? 0).toBeGreaterThan(0);
    expect(await estimatorOf(DEAL_ID)).toBe(ESTIMATOR_ID);
  });

  it("PRESERVES an existing estimator and ignores the incoming id (empties-only COALESCE is a no-op)", async () => {
    await seedDeal(ESTIMATOR_ID);
    const sql = buildBidBoardDealUpdateSql(SCHEMA);
    const incoming = "22222222-2222-4222-8222-222222222222";

    await client.query(
      sql,
      updateParams(DEAL_ID, normalizedRow(), "2026-06-18T20:32:00Z", incoming)
    );

    expect(await estimatorOf(DEAL_ID)).toBe(ESTIMATOR_ID);
  });
});
