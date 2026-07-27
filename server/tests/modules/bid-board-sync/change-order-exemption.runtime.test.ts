import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { findDealIds, normalizeBidBoardRow } from "../../../src/modules/bid-board-sync/service.js";

/**
 * SAFETY REQ A (the linchpin): a change-order CHILD deal shares its parent's project_number, so it MUST
 * be invisible to the Bid Board matcher — otherwise the project_number tier returns parent+child as a
 * multi-match and the sync silently skips the PARENT's writeback (the Onyx desync class). This proves
 * the matcher returns ONLY the parent for the shared project_number, across every match tier.
 */
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const ST = U("57e1");
const PARENT = U("d0001");
const CHILD = U("d0002");
const SHARED_PROJECT = "DFW-4-11826-ab";

let pg: PGlite;
let client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }> };

beforeAll(async () => {
  pg = new PGlite();
  client = {
    query: async (text, params) => {
      const r: any = await pg.query(text, params);
      return { ...r, rowCount: r.affectedRows ?? r.rowCount ?? r.rows?.length ?? 0 };
    },
  };
  await pg.exec(`
    CREATE TABLE public.pipeline_stage_config (
      id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL,
      display_order int, is_terminal boolean NOT NULL DEFAULT false, is_active_pipeline boolean NOT NULL DEFAULT true
    );
    CREATE SCHEMA office_test;
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY, name text, stage_id uuid, stage_entered_at timestamptz,
      on_hold boolean NOT NULL DEFAULT false, on_hold_started_at timestamptz,
      on_hold_accumulated_seconds bigint NOT NULL DEFAULT 0, on_hold_accumulated_seconds_at_stage_entry bigint NOT NULL DEFAULT 0,
      workflow_route text NOT NULL DEFAULT 'normal', deal_number text, project_number text, bid_board_project_number text,
      bid_board_estimator text, estimator_user_id uuid, sales_source_user_id uuid, bid_board_office text, bid_board_status text,
      bid_board_sales_price_per_area text, bid_board_project_cost numeric, bid_board_profit_margin_pct numeric,
      bid_board_total_sales numeric, bid_board_created_at timestamptz, bid_board_due_date date,
      bid_board_customer_name text, bid_board_customer_contact_raw text, bid_board_stage_slug text,
      bid_board_stage_family text, bid_board_stage_status text, bid_board_last_updated_at timestamptz,
      bid_estimate numeric, awarded_amount numeric, won_closed_date date, contract_signed_date date, contract_signed_at timestamptz,
      procore_bid_id bigint, is_active boolean NOT NULL DEFAULT true,
      bid_board_detached_at timestamptz,
      is_change_order boolean NOT NULL DEFAULT false, parent_deal_id uuid
    );
    INSERT INTO public.pipeline_stage_config (id, slug, name, display_order, is_terminal) VALUES ('${ST}','won','Won', 90, true);
    -- Parent (real deal) + a CO child that SHARES the parent's project_number.
    INSERT INTO office_test.deals (id, name, stage_id, deal_number, project_number, is_change_order, parent_deal_id) VALUES
      ('${PARENT}','Acme Tower','${ST}','${SHARED_PROJECT}','${SHARED_PROJECT}', false, NULL),
      ('${CHILD}','Acme Tower — Change Order 1','${ST}','DFW-4-99999-zz','${SHARED_PROJECT}', true, '${PARENT}');
  `);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Bid Board matcher excludes change-order child deals (Safety Req A)", () => {
  it("matching the shared project_number returns ONLY the parent, never the CO child", async () => {
    const normalized = normalizeBidBoardRow({ Name: "Acme Tower", "Project #": SHARED_PROJECT, Status: "Estimate in Progress" });
    const ids = await findDealIds(client, "office_test", normalized);
    expect(ids).toEqual([PARENT]); // single, unique match — the CO child is invisible to the sync
    expect(ids).not.toContain(CHILD);
  });

  it("a CO child whose OWN deal_number matches an incoming Project # is still excluded", async () => {
    // The child's deal_number is DFW-4-99999-zz; even keyed directly, the sync must never match it.
    const normalized = normalizeBidBoardRow({ Name: "x", "Project #": "DFW-4-99999-zz", Status: "Estimate in Progress" });
    const ids = await findDealIds(client, "office_test", normalized);
    expect(ids).not.toContain(CHILD);
  });
});
