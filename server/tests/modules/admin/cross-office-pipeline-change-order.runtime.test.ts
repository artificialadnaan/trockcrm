import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * REAL-SQL (PGlite) proof for the cross-office pipeline report's two value aggregates, run against the
 * PRODUCTION query lifted out of admin/routes.ts rather than a retyped copy.
 *
 * total_awarded_value is the shape that differs from every other site on this branch: `awarded_amount > 0`
 * there is a ROW FILTER, not a fallback candidate — a non-positive awarded amount drops the row from the
 * SUM entirely. A deductive CO must now be summed (negative and all) while on-hold and inactive deals stay
 * excluded, which is what the on_hold/is_active halves of these assertions pin.
 */

function crossOfficePipelineQuery(): string {
  const source = readFileSync(resolve(__dirname, "../../../src/modules/admin/routes.ts"), "utf8");
  // `[^\`]` keeps the match inside ONE template literal, so a neighbouring query can't be spliced in.
  const match = source.match(/`(SELECT\s+COUNT\(\*\) AS total_deals[^`]*?psc\.id = deals\.stage_id)`/);
  if (!match) {
    throw new Error("could not locate the cross-office pipeline query in server/src/modules/admin/routes.ts");
  }
  return match[1];
}

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`SET TimeZone='UTC';`);
  await db.exec(`
    CREATE TABLE public.pipeline_stage_config (id text PRIMARY KEY, slug text NOT NULL, is_terminal boolean NOT NULL DEFAULT false);
    INSERT INTO public.pipeline_stage_config (id, slug, is_terminal) VALUES
      ('won', 'won', true),
      ('opportunity', 'opportunity', false);
    CREATE TABLE deals (
      id text PRIMARY KEY,
      stage_id text,
      is_change_order boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      awarded_amount numeric(14,2),
      bid_board_total_sales numeric(14,2),
      bid_estimate numeric(14,2),
      dd_estimate numeric(14,2)
    );
    INSERT INTO deals (id, stage_id, is_change_order, on_hold, is_active, awarded_amount, bid_estimate) VALUES
      -- open, non-CO: the only contributor to total_pipeline_value from the normal chain
      ('open_normal',   'opportunity', false, false, true,  NULL,      3000.00),
      -- won parent: terminal, so it is OUT of pipeline value but IN awarded value
      ('won_parent',    'won',         false, false, true,  100000.00, NULL),
      -- the deductive CO child: terminal, so awarded value only
      ('co_deduct',     'won',         true,  false, true,  -25000.00, NULL),
      -- a CO that has not reached a terminal stage: exercises the branch inside the PIPELINE chain too
      ('co_deduct_open','opportunity', true,  false, true,  -5000.00,  NULL),
      -- on-hold and soft-deleted rows must stay excluded from BOTH sums, CO or not
      ('co_on_hold',    'won',         true,  true,  true,  -9999.00,  NULL),
      ('co_inactive',   'won',         true,  false, false, -8888.00,  NULL),
      -- NON-terminal twins of those two. Without these, psc.is_terminal alone would mask a dropped
      -- on_hold / is_active guard on total_pipeline_value and only the source-string test would notice.
      ('co_on_hold_open',  'opportunity', true, true,  true,  -7777.00, NULL),
      ('co_inactive_open', 'opportunity', true, false, false, -6666.00, NULL);
  `);
}, 30000);

afterAll(async () => {
  await db?.close();
});

describe("cross-office pipeline report — deductive change orders", () => {
  it("sums a deductive CO into total_awarded_value while still excluding on-hold and inactive deals", async () => {
    const { rows } = await db.query<{ total_awarded_value: string; total_pipeline_value: string; total_deals: string }>(
      crossOfficePipelineQuery()
    );

    // 100000 (won parent) - 25000 (terminal deductive CO) - 5000 (open deductive CO; this sum is
    // deliberately NOT terminal-filtered). All four on-hold/inactive COs stay out.
    expect(Number(rows[0].total_awarded_value)).toBe(70000);
  });

  it("prices a non-terminal change order from awarded_amount inside total_pipeline_value", async () => {
    const { rows } = await db.query<{ total_pipeline_value: string }>(crossOfficePipelineQuery());

    // 3000 (open non-CO, bid_estimate) + -5000 (open deductive CO, awarded verbatim). The terminal rows
    // (won parent, terminal CO) are excluded by the psc.is_terminal guard, which must survive this change,
    // and the two NON-terminal on-hold/inactive COs (-7777, -6666) are excluded by their own guards — so
    // this number independently proves all three still hold on the pipeline sum.
    expect(Number(rows[0].total_pipeline_value)).toBe(-2000);
  });
});
