import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { searchDeals } from "../../../src/modules/search/service.js";

/**
 * REAL-SQL (PGlite) proof that global search no longer surfaces a soft-deleted (is_active=false)
 * terminal Won deal, while a LIVE terminal Won deal (and live open deals) stay findable.
 * Previously the "findable = active OR terminal-stage" rule, combined with a CO-only inactive
 * exclusion, still surfaced a plain (non-CO) soft-deleted Won deal — deep-linkable to a deleted deal.
 */

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ST = { won: U("57a1"), opp: U("57a2") };
const D = {
  liveWon: U("d01"),
  deletedWon: U("d02"),
  deletedWonCo: U("d03"),
  liveOpp: U("d04"),
  deletedOpp: U("d05"),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text);
    CREATE TABLE companies (id uuid PRIMARY KEY, name text);
    CREATE TABLE contacts (id uuid PRIMARY KEY, first_name text, last_name text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, name text, deal_number text, project_number text, description text,
      property_address text, property_city text, property_state text, bid_board_customer_name text,
      company_id uuid, primary_contact_id uuid, assigned_rep_id uuid,
      on_hold boolean DEFAULT false, is_change_order boolean DEFAULT false,
      is_active boolean NOT NULL DEFAULT true, stage_id uuid, updated_at timestamptz DEFAULT now()
    );

    INSERT INTO pipeline_stage_config (id, slug) VALUES ('${ST.won}','won'), ('${ST.opp}','opportunity');

    -- all share the token 'Zephyr' so buildDealSearchCondition matches each by name
    INSERT INTO deals (id, name, stage_id, is_active, is_change_order) VALUES
      ('${D.liveWon}',     'Zephyr Live Won',     '${ST.won}', true,  false),
      ('${D.deletedWon}',  'Zephyr Deleted Won',  '${ST.won}', false, false),
      ('${D.deletedWonCo}','Zephyr Deleted Won CO','${ST.won}', false, true),
      ('${D.liveOpp}',     'Zephyr Live Opp',     '${ST.opp}', true,  false),
      ('${D.deletedOpp}',  'Zephyr Deleted Opp',  '${ST.opp}', false, false);
  `);
  tdb = drizzle(pg);
  // Give PGlite setup explicit headroom over Vitest's default 10s hook timeout for parallel batches (Codex P2).
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

describe("searchDeals — soft-deleted Won is not findable; live Won stays findable", () => {
  it("returns live Won + live open, excludes every soft-deleted (Won, Won-CO, open) deal", async () => {
    const results = await searchDeals(tdb, "Zephyr", 50);
    const ids = results.map((r) => r.id).sort();

    expect(ids).toEqual([D.liveWon, D.liveOpp].sort());
    expect(ids).not.toContain(D.deletedWon); // the core fix: plain soft-deleted Won no longer surfaced
    expect(ids).not.toContain(D.deletedWonCo);
    expect(ids).not.toContain(D.deletedOpp);
  });
});
