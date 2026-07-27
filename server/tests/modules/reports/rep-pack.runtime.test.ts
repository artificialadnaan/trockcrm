import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getRepPackData } from "../../../src/modules/reports/rep-pack-service.js";
import { SENT_STAGE_SLUGS } from "../../../src/modules/reports/foundations.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

/**
 * REAL-SQL (PGlite) coverage for the Rep 1:1 Pack: the rep's slice must equal their showcase numbers and
 * their 8-week trend's current (capped) Won bucket must equal their period Won (rep.closed.count) -- i.e.
 * the pack reconciles to the canonical per-rep aggregate, by reusing getMondayShowcaseData + the shared
 * computeWeeklyTrend.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const REP_A = U("a01");
const REP_B = U("b01");
const ST = { won: U("57001"), open: U("57002"), sent: U("57003"), lead: U("57004") };
const D = { wa1: U("11001"), wa2: U("11002"), wb1: U("11003"), sa: U("11004"), pa: U("11005"), la: U("11006") };
const NOW = new Date("2026-05-27T18:00:00Z");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text NOT NULL);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL, workflow_family text NOT NULL DEFAULT 'standard_deal', is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, deal_number text, name text NOT NULL, stage_id uuid NOT NULL, assigned_rep_id uuid,
      is_test_data boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true,
      won_closed_date date, expected_close_date date, bid_due_date timestamptz, bid_board_stage_slug text, stage_entered_at timestamptz,
      dd_estimate numeric, bid_estimate numeric, awarded_amount numeric, bid_board_total_sales numeric
    );
    CREATE TABLE deal_stage_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL, to_stage_id uuid NOT NULL, created_at timestamptz NOT NULL);
    CREATE TABLE leads (id uuid PRIMARY KEY, name text NOT NULL, stage_id uuid NOT NULL, assigned_rep_id uuid, status text NOT NULL DEFAULT 'open', is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());

    INSERT INTO users (id, display_name) VALUES ('${REP_A}','Alice'), ('${REP_B}','Bob');
    INSERT INTO pipeline_stage_config (id, name, slug, workflow_family, is_terminal) VALUES
      ('${ST.won}','Won','${WON_STAGE_SLUGS[0]}','standard_deal', true),
      ('${ST.open}','Opportunity','opportunity','standard_deal', false),
      ('${ST.sent}','Estimate Sent','${SENT_STAGE_SLUGS[0]}','standard_deal', false),
      ('${ST.lead}','New','lead_new','lead', false);

    -- Won: Alice 2 (100k + 80k), Bob 1 (50k), all in [05-24,05-27]
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, won_closed_date, awarded_amount) VALUES
      ('${D.wa1}','W-A1','Alice win 1','${ST.won}','${REP_A}','2026-05-25', 100000),
      ('${D.wa2}','W-A2','Alice win 2','${ST.won}','${REP_A}','2026-05-26', 80000),
      ('${D.wb1}','W-B1','Bob win','${ST.won}','${REP_B}','2026-05-26', 50000);
    -- Alice sent-cohort deal + projection deal
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, expected_close_date, bid_board_total_sales) VALUES
      ('${D.sa}','S-A','Alice sent','${ST.open}','${REP_A}', NULL, 30000),
      ('${D.pa}','P-A','Alice proj','${ST.open}','${REP_A}', (now() AT TIME ZONE 'America/Chicago')::date + 10, 20000);
    INSERT INTO deal_stage_history (deal_id, to_stage_id, created_at) VALUES ('${D.sa}','${ST.sent}','2026-05-25T15:00:00Z');
    INSERT INTO leads (id, name, stage_id, assigned_rep_id) VALUES ('${D.la}','Alice lead','${ST.lead}','${REP_A}');
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("Rep 1:1 Pack reconciles to the canonical per-rep numbers", () => {
  it("the selected rep's slice + 8-week trend tie to their Won/Sent/Projection", async () => {
    const pack = await getRepPackData(tdb, { repId: REP_A, mode: "to_date", now: NOW });
    expect(pack).not.toBeNull();
    if (!pack) return;
    expect(pack.rep.repId).toBe(REP_A);
    expect(pack.rep.closed.count).toBe(2);
    expect(pack.rep.closed.value.amount).toBeCloseTo(180000, 2);
    expect(pack.rep.sentThisWeek.count).toBe(1);
    expect(pack.rep.projection.bands.reduce((s, b) => s + b.count, 0)).toBe(1);
    // the trend is exactly 8 weeks; the current (capped) week's Won === the rep's period Won.
    expect(pack.trend).toHaveLength(8);
    expect(pack.trend[7].won).toBe(pack.rep.closed.count);
    // selector lists the named reps (not Unassigned)
    expect(pack.allReps.map((r) => r.repId).sort()).toEqual([REP_A, REP_B].sort());
  });

  it("defaults to the top rep by closed value when no repId is given", async () => {
    const pack = await getRepPackData(tdb, { mode: "to_date", now: NOW });
    expect(pack?.rep.repId).toBe(REP_A); // Alice 180k > Bob 50k
  });

  it("falls back to a valid rep (never collapses) when the requested rep has no activity this period", async () => {
    // A rep that exists in the roster but has zero activity this period -> must NOT return null (which
    // would hide the selector and strand the user); fall back to a rep that IS in allReps.
    const ghost = U("c99");
    const pack = await getRepPackData(tdb, { repId: ghost, mode: "to_date", now: NOW });
    expect(pack).not.toBeNull();
    if (!pack) return;
    expect(pack.allReps.some((r) => r.repId === pack.rep.repId)).toBe(true); // the resolved rep is selectable
    // the trend belongs to the RESOLVED rep, not the empty requested one
    expect(pack.trend[7].won).toBe(pack.rep.closed.count);
  });
});
