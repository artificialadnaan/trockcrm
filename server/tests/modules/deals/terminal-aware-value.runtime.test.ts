import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aliasedTerminalAwareEffectiveDealValueSql,
  aliasedDealBestEstimateWithForecastSql,
  aliasedEffectiveLostDealValueSql,
} from "../../../src/modules/shared/deal-value-sql.js";

/**
 * Codex P2 (finding B): aggregates that sum across a MIXED (open + terminal) population without a per-stage
 * value CASE — company pipeline value, Lost Deals by Reason — must preserve realized/terminal value while
 * still auto-parking far-out OPEN deals. Proven against real SQL on PGlite:
 *   - aliasedTerminalAwareEffectiveDealValueSql: terminal (won/lost OR Bid Board-mirrored) -> stored-on_hold
 *     only; open -> additionally zero a far-out close target;
 *   - aliasedEffectiveLostDealValueSql (used by Lost Deals by Reason): always realized-safe (stored only).
 */

const dialect = new PgDialect();
const FAR = "2099-12-31";

type Row = {
  id: string;
  slug: string; // joined pipeline_stage_config.slug
  bid_board_stage_slug: string | null;
  on_hold: boolean;
  expected_close_date: string | null;
  bid_estimate: number;
  expectedTerminalAware: number; // company-stats helper
  expectedLost: number; // lost-by-reason helper
};

const ROWS: Row[] = [
  // open far-out -> auto-parked to 0 by the open branch; lost helper treats it as realized (not lost stage,
  // but the helper is only applied to lost populations — here we just assert its stored-only math = 200000).
  { id: "open_far", slug: "opportunity", bid_board_stage_slug: null, on_hold: false, expected_close_date: FAR, bid_estimate: 200000, expectedTerminalAware: 0, expectedLost: 200000 },
  // open near -> full value both ways
  { id: "open_near", slug: "opportunity", bid_board_stage_slug: null, on_hold: false, expected_close_date: "2026-06-15", bid_estimate: 150000, expectedTerminalAware: 150000, expectedLost: 150000 },
  // won far-out -> PRESERVED by terminal-aware; stored-only zeros nothing here
  { id: "won_far", slug: "won", bid_board_stage_slug: null, on_hold: false, expected_close_date: FAR, bid_estimate: 300000, expectedTerminalAware: 300000, expectedLost: 300000 },
  // lost far-out -> PRESERVED by terminal-aware AND by the lost helper
  { id: "lost_far", slug: "lost", bid_board_stage_slug: null, on_hold: false, expected_close_date: FAR, bid_estimate: 250000, expectedTerminalAware: 250000, expectedLost: 250000 },
  // Bid Board-mirrored terminal (CRM stage open) far-out -> PRESERVED by terminal-aware via the mirror
  { id: "bb_mirror_far", slug: "opportunity", bid_board_stage_slug: "won", on_hold: false, expected_close_date: FAR, bid_estimate: 120000, expectedTerminalAware: 120000, expectedLost: 120000 },
  // terminal but stored on_hold -> zeroed by BOTH (stored flag applies to terminal too)
  { id: "won_onhold", slug: "won", bid_board_stage_slug: null, on_hold: true, expected_close_date: FAR, bid_estimate: 999000, expectedTerminalAware: 0, expectedLost: 0 },
];

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE pipeline_stage_config (id text PRIMARY KEY, slug text NOT NULL);
    CREATE TABLE deals (
      id text PRIMARY KEY,
      stage_id text NOT NULL,
      bid_board_stage_slug text,
      on_hold boolean NOT NULL DEFAULT false,
      expected_close_date date,
      bid_estimate numeric,
      forecast_revenue numeric,
      bid_board_total_sales numeric,
      dd_estimate numeric,
      awarded_amount numeric
    );
    INSERT INTO pipeline_stage_config (id, slug) VALUES ('opportunity','opportunity'), ('won','won'), ('lost','lost');
  `);
  for (const r of ROWS) {
    await db.query(
      `INSERT INTO deals (id, stage_id, bid_board_stage_slug, on_hold, expected_close_date, bid_estimate)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.id, r.slug, r.bid_board_stage_slug, r.on_hold, r.expected_close_date, r.bid_estimate]
    );
  }
});

afterAll(async () => {
  await db?.close();
});

describe("aliasedTerminalAwareEffectiveDealValueSql — mixed-population aggregates (company stats)", () => {
  it("preserves terminal (won/lost/BB-mirror) far-out value, auto-parks open far-out, zeros stored on_hold", async () => {
    const terminalSlugs = sql.join(["won", "lost"].map((s) => sql`${s}`), sql`, `);
    const isTerminal = sql`(psc.slug IN (${terminalSlugs}) OR COALESCE(d.bid_board_stage_slug, '') IN (${terminalSlugs}))`;
    const expr = dialect.sqlToQuery(
      aliasedTerminalAwareEffectiveDealValueSql("d", aliasedDealBestEstimateWithForecastSql("d"), isTerminal)
    );
    const { rows } = await db.query<{ id: string; v: string }>(
      `SELECT d.id, (${expr.sql}) AS v FROM deals d JOIN pipeline_stage_config psc ON psc.id = d.stage_id ORDER BY d.id`,
      expr.params as unknown[]
    );
    const byId = new Map(rows.map((r) => [r.id, Number(r.v)]));
    for (const r of ROWS) expect(byId.get(r.id)).toBe(r.expectedTerminalAware);
  });
});

describe("aliasedEffectiveLostDealValueSql — Lost Deals by Reason (all-lost population)", () => {
  it("is realized-safe: stored on_hold zeros, a far-out date never does", async () => {
    const expr = dialect.sqlToQuery(aliasedEffectiveLostDealValueSql("d"));
    const { rows } = await db.query<{ id: string; v: string }>(
      `SELECT d.id, (${expr.sql}) AS v FROM deals d ORDER BY d.id`,
      expr.params as unknown[]
    );
    const byId = new Map(rows.map((r) => [r.id, Number(r.v)]));
    for (const r of ROWS) expect(byId.get(r.id)).toBe(r.expectedLost);
  });
});
