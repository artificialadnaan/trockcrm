import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getRegionReport } from "../../../src/modules/reports/region-report-service.js";

/**
 * REAL-SQL (PGlite) proof for the Reports-by-Region service. One deterministic fixture exercises all six
 * sections with hand-computed expectations. Region = region_id → region_config.name, else 'Unassigned'.
 * Won is windowed on canonical won_closed_date; lost on lost_at; pipeline/forecast/stage-matrix are
 * snapshots; movers are week-based (getWtdPeriod + prior week).
 *
 * NOW = 2026-05-27 (Wed) → this week (wtd) = 2026-05-24..27, prior week = 2026-05-17..23.
 * Page window for the test = this week (2026-05-24..27).
 */
// hex-safe deterministic UUIDs: non-hex chars map to a hex digit so any short label is a valid uuid.
const U = (s: string) => {
  const hex = [...s].map((c) => (/[0-9a-f]/i.test(c) ? c : (c.charCodeAt(0) % 16).toString(16))).join("");
  return `00000000-0000-0000-0000-${hex.padStart(12, "0").slice(-12)}`;
};
const RC = { west: U("rc01"), central: U("rc02"), east: U("rc03") };
const ST = { opp: U("57001"), est: U("57002"), sent: U("57003"), won: U("57009"), lost: U("57010") };
const REP = { alice: U("a01"), bob: U("a02") };
const NOW = new Date("2026-05-27T18:00:00Z");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text NOT NULL);
    CREATE TABLE region_config (id uuid PRIMARY KEY, name text NOT NULL, display_order int NOT NULL, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE pipeline_stage_config (
      id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL,
      display_order int NOT NULL DEFAULT 0, workflow_family text NOT NULL DEFAULT 'standard_deal',
      is_terminal boolean NOT NULL DEFAULT false
    );
    CREATE TABLE deals (
      id uuid PRIMARY KEY, deal_number text, name text NOT NULL, stage_id uuid NOT NULL,
      assigned_rep_id uuid, region_id uuid, on_hold boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      won_closed_date date, lost_at timestamptz, actual_close_date date, stage_entered_at timestamptz,
      expected_close_date date, created_at timestamptz NOT NULL DEFAULT now(),
      awarded_amount numeric, bid_estimate numeric, dd_estimate numeric, bid_board_total_sales numeric
    );

    INSERT INTO users (id, display_name) VALUES ('${REP.alice}','Alice'),('${REP.bob}','Bob');
    INSERT INTO region_config (id, name, display_order, is_active) VALUES
      ('${RC.west}','West Coast',1,true),('${RC.central}','Central',2,true),('${RC.east}','East Coast',3,true);
    INSERT INTO pipeline_stage_config (id, name, slug, display_order, is_terminal) VALUES
      ('${ST.opp}','Opportunity','opportunity',2,false),
      ('${ST.est}','Estimating','estimating',3,false),
      ('${ST.sent}','Estimate Sent to Client','estimate_sent_to_client',5,false),
      ('${ST.won}','Won','won',7,true),
      ('${ST.lost}','Lost','lost',8,true);

    -- WON (stage=won, won_closed_date). awarded_amount drives the awarded-first won value.
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, region_id, won_closed_date, awarded_amount) VALUES
      ('${U("w1")}','W1','Won West thisweek','${ST.won}','${REP.alice}','${RC.west}','2026-05-25',100000),
      ('${U("w2")}','W2','Won Central A','${ST.won}','${REP.alice}','${RC.central}','2026-05-26',40000),
      ('${U("w3")}','W3','Won Central B','${ST.won}','${REP.bob}','${RC.central}','2026-05-24',60000),
      ('${U("w4")}','W4','Won West OUTSIDE','${ST.won}','${REP.alice}','${RC.west}','2026-05-10',999000),
      ('${U("wp1")}','WP1','Won West prior','${ST.won}','${REP.alice}','${RC.west}','2026-05-18',30000),
      ('${U("wp2")}','WP2','Won Central prior','${ST.won}','${REP.bob}','${RC.central}','2026-05-19',20000);

    -- LOST (stage=lost, lost_at). bid_estimate drives the value (no awarded).
    INSERT INTO deals (id, deal_number, name, stage_id, region_id, lost_at, bid_estimate) VALUES
      ('${U("l1")}','L1','Lost West','${ST.lost}','${RC.west}','2026-05-25T12:00:00Z',80000),
      ('${U("l2")}','L2','Lost Central A','${ST.lost}','${RC.central}','2026-05-26T12:00:00Z',35000),
      ('${U("l3")}','L3','Lost Central B','${ST.lost}','${RC.central}','2026-05-26T12:00:00Z',45000);

    -- OPEN (non-terminal, is_active). bid_estimate drives the best-estimate value.
    INSERT INTO deals (id, deal_number, name, stage_id, region_id, expected_close_date, created_at, bid_estimate) VALUES
      ('${U("o1")}','O1','Open West opp','${ST.opp}','${RC.west}','2026-06-10','2026-05-26T10:00:00Z',60000),
      ('${U("o2")}','O2','Open Central est','${ST.est}','${RC.central}','2026-07-15','2026-05-01T10:00:00Z',40000),
      ('${U("o3")}','O3','Open Central sent','${ST.sent}','${RC.central}',NULL,'2026-04-01T10:00:00Z',30000),
      ('${U("o4")}','O4','Open East opp past','${ST.opp}','${RC.east}','2026-05-01','2026-03-01T10:00:00Z',20000),
      ('${U("o5")}','O5','Open Unassigned est','${ST.est}',NULL,'2026-09-01','2026-02-01T10:00:00Z',15000);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("getRegionReport — 6-section aggregation", () => {
  it("summary: won windowed, pipeline snapshot, win rate won/(won+lost), unassigned %", async () => {
    const r = await getRegionReport(tdb, { from: "2026-05-24", to: "2026-05-27", now: NOW });
    expect(r.summary.totalWon).toEqual({ value: 200000, count: 3 }); // w1+w2+w3; w4 out-of-window excluded
    expect(r.summary.openPipeline).toEqual({ value: 165000, count: 5 }); // o1..o5 snapshot
    expect(r.summary.winRate).toBeCloseTo(50, 1); // won 3 / (3 + lost 3)
    expect(r.summary.unassignedPct).toBeCloseTo(20, 1); // 1 of 5 open deals has no region
  });

  it("regions: 4 segments ordered West/Central/East/Unassigned with per-region metrics", async () => {
    const r = await getRegionReport(tdb, { from: "2026-05-24", to: "2026-05-27", now: NOW });
    expect(r.regions.map((x) => x.region)).toEqual(["West Coast", "Central", "East Coast", "Unassigned"]);
    expect(r.regions.at(-1)!.isUnassigned).toBe(true);

    const west = r.regions.find((x) => x.region === "West Coast")!;
    expect(west.won).toEqual({ value: 100000, count: 1 });
    expect(west.pipeline).toEqual({ value: 60000, count: 1 });
    expect(west.winRate).toBeCloseTo(50, 1); // won 1 / (1 + lost 1)
    expect(west.avgDeal).toBe(100000);

    const central = r.regions.find((x) => x.region === "Central")!;
    expect(central.won).toEqual({ value: 100000, count: 2 });
    expect(central.pipeline).toEqual({ value: 70000, count: 2 });
    expect(central.winRate).toBeCloseTo(50, 1); // won 2 / (2 + lost 2)
    expect(central.avgDeal).toBe(50000);

    const east = r.regions.find((x) => x.region === "East Coast")!;
    expect(east.won).toEqual({ value: 0, count: 0 });
    expect(east.pipeline).toEqual({ value: 20000, count: 1 });
    expect(east.winRate).toBeNull(); // no won/lost in window
    expect(east.avgDeal).toBeNull();

    const un = r.regions.find((x) => x.region === "Unassigned")!;
    expect(un.pipeline).toEqual({ value: 15000, count: 1 });
  });

  it("forecast: per-region 4 bands + honest N/M coverage (past/NULL stay in M)", async () => {
    const r = await getRegionReport(tdb, { from: "2026-05-24", to: "2026-05-27", now: NOW });
    const west = r.regions.find((x) => x.region === "West Coast")!;
    expect(west.forecast.bands["0_30"]).toEqual({ count: 1, value: 60000 });
    expect(west.forecast.coverage).toEqual({ n: 1, m: 1 });

    const central = r.regions.find((x) => x.region === "Central")!;
    expect(central.forecast.bands["31_60"]).toEqual({ count: 1, value: 40000 }); // o2
    expect(central.forecast.coverage).toEqual({ n: 1, m: 2 }); // o3 NULL date stays in M

    const east = r.regions.find((x) => x.region === "East Coast")!;
    expect(east.forecast.coverage).toEqual({ n: 0, m: 1 }); // o4 past date → not future-dated

    const un = r.regions.find((x) => x.region === "Unassigned")!;
    expect(un.forecast.bands.beyond_90).toEqual({ count: 1, value: 15000 }); // o5
    expect(un.forecast.coverage).toEqual({ n: 1, m: 1 });
  });

  it("stage matrix: open stages as columns, region×stage cells carry count + value", async () => {
    const r = await getRegionReport(tdb, { from: "2026-05-24", to: "2026-05-27", now: NOW });
    expect(r.stageColumns.map((c) => c.slug)).toEqual(["opportunity", "estimating", "estimate_sent_to_client"]);
    const cell = (region: string, slug: string) =>
      r.stageMatrix.find((c) => c.region === region && c.stageSlug === slug) ?? { count: 0, value: 0 };
    expect(cell("West Coast", "opportunity")).toMatchObject({ count: 1, value: 60000 });
    expect(cell("Central", "estimating")).toMatchObject({ count: 1, value: 40000 });
    expect(cell("Central", "estimate_sent_to_client")).toMatchObject({ count: 1, value: 30000 });
    expect(cell("East Coast", "opportunity")).toMatchObject({ count: 1, value: 20000 });
    expect(cell("Unassigned", "estimating")).toMatchObject({ count: 1, value: 15000 });
  });

  it("top reps: per region, ranked by won value in the window (a rep can appear in many regions)", async () => {
    const r = await getRegionReport(tdb, { from: "2026-05-24", to: "2026-05-27", now: NOW });
    const west = r.regions.find((x) => x.region === "West Coast")!;
    expect(west.topReps).toEqual([{ repId: REP.alice, repName: "Alice", wonValue: 100000, wonCount: 1 }]);

    const central = r.regions.find((x) => x.region === "Central")!;
    expect(central.topReps.map((t) => [t.repName, t.wonValue])).toEqual([
      ["Bob", 60000],
      ["Alice", 40000],
    ]);

    expect(r.regions.find((x) => x.region === "East Coast")!.topReps).toEqual([]);
  });

  it("movers: week-based — biggest region Δ, biggest new/win/loss", async () => {
    const r = await getRegionReport(tdb, { from: "2026-05-24", to: "2026-05-27", now: NOW });
    // Central this-week won 100000 vs prior 20000 = +80000; West +70000 → Central biggest mover.
    expect(r.movers.biggestRegionMover).toEqual({ region: "Central", deltaWon: 80000 });
    expect(r.movers.biggestNewDeal).toMatchObject({ name: "Open West opp", value: 60000, region: "West Coast" });
    expect(r.movers.biggestWin).toMatchObject({ name: "Won West thisweek", value: 100000, region: "West Coast" });
    expect(r.movers.biggestLoss).toMatchObject({ name: "Lost West", value: 80000, region: "West Coast" });
  });

  it("sparkline: trailing 8 weekly won values per region (oldest→newest)", async () => {
    const r = await getRegionReport(tdb, { from: "2026-05-24", to: "2026-05-27", now: NOW });
    const west = r.regions.find((x) => x.region === "West Coast")!;
    expect(west.sparkline).toEqual([0, 0, 0, 0, 0, 999000, 30000, 100000]); // wk-2=w4, wk-1=wp1, wk0=w1
    const central = r.regions.find((x) => x.region === "Central")!;
    expect(central.sparkline).toEqual([0, 0, 0, 0, 0, 0, 20000, 100000]); // wk-1=wp2, wk0=w2+w3
  });

  it("reconciles: office summary equals the SUM of the region cards (incl. Unassigned)", async () => {
    const r = await getRegionReport(tdb, { from: "2026-05-24", to: "2026-05-27", now: NOW });
    expect(r.summary.totalWon.value).toBe(r.regions.reduce((s, x) => s + x.won.value, 0));
    expect(r.summary.totalWon.count).toBe(r.regions.reduce((s, x) => s + x.won.count, 0));
    expect(r.summary.openPipeline.value).toBe(r.regions.reduce((s, x) => s + x.pipeline.value, 0));
    expect(r.summary.openPipeline.count).toBe(r.regions.reduce((s, x) => s + x.pipeline.count, 0));
  });
});

describe("getRegionReport — exclusions & edge cases", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let edb: any;
  let epg: PGlite;
  const E = { won: U("eb09"), lost: U("eb0a"), opp: U("eb01") };
  const ER = { west: U("ec01") };
  beforeAll(async () => {
    epg = new PGlite();
    await epg.exec(`SET TimeZone='UTC';`);
    await epg.exec(`
      CREATE TABLE users (id uuid PRIMARY KEY, display_name text NOT NULL);
      CREATE TABLE region_config (id uuid PRIMARY KEY, name text NOT NULL, display_order int NOT NULL, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL, display_order int NOT NULL DEFAULT 0, workflow_family text NOT NULL DEFAULT 'standard_deal', is_terminal boolean NOT NULL DEFAULT false);
      CREATE TABLE deals (
        id uuid PRIMARY KEY, deal_number text, name text NOT NULL, stage_id uuid NOT NULL,
        assigned_rep_id uuid, region_id uuid, on_hold boolean NOT NULL DEFAULT false,
        is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
        won_closed_date date, lost_at timestamptz, actual_close_date date, stage_entered_at timestamptz,
        expected_close_date date, created_at timestamptz NOT NULL DEFAULT now(),
        awarded_amount numeric, bid_estimate numeric, dd_estimate numeric, bid_board_total_sales numeric
      );
      INSERT INTO region_config (id, name, display_order, is_active) VALUES ('${ER.west}','West Coast',1,true);
      INSERT INTO pipeline_stage_config (id, name, slug, display_order, is_terminal) VALUES
        ('${E.opp}','Opportunity','opportunity',2,false),('${E.won}','Won','won',7,true),('${E.lost}','Lost','lost',8,true);

      -- West WON, in-window — normal + archived (is_active=false, must COUNT) + boundary on the from-date.
      INSERT INTO deals (id, name, stage_id, region_id, won_closed_date, awarded_amount, is_active, on_hold, is_test_data) VALUES
        ('${U("en1")}','normal','${E.won}','${ER.west}','2026-05-25',100000,true,false,false),
        ('${U("ear")}','archived','${E.won}','${ER.west}','2026-05-26',40000,false,false,false),
        ('${U("ebf")}','boundary-from','${E.won}','${ER.west}','2026-05-24',10000,true,false,false),
        ('${U("eoh")}','onhold','${E.won}','${ER.west}','2026-05-25',50000,true,true,false),
        ('${U("etd")}','testdata','${E.won}','${ER.west}','2026-05-25',70000,true,false,true),
        ('${U("eat")}','after-to','${E.won}','${ER.west}','2026-05-28',999000,true,false,false);
      -- Unassigned WON (region_id NULL) in-window.
      INSERT INTO deals (id, name, stage_id, region_id, won_closed_date, awarded_amount) VALUES
        ('${U("eun")}','unassigned won','${E.won}',NULL,'2026-05-26',25000);
      -- West LOST in-window (for win rate) + a tz-boundary loss: 2026-05-24T02:00Z = 2026-05-23 21:00
      -- Central → business date 05-23, BEFORE the [05-24,05-27] window, so it must be EXCLUDED even though
      -- its UTC ::date (05-24) is in-window (this catches session-tz windowing under PGlite's UTC session).
      INSERT INTO deals (id, name, stage_id, region_id, lost_at, bid_estimate) VALUES
        ('${U("elw")}','lost west','${E.lost}','${ER.west}','2026-05-25T12:00:00Z',5000),
        ('${U("etz")}','lost tz-before-window','${E.lost}','${ER.west}','2026-05-24T02:00:00Z',1000);
      -- LOST with lost_at NULL, actual_close_date on the FROM-date boundary (05-24): counted via the canonical
      -- COALESCE fallback. actual_close_date is a DATE — it must be used as-is (NOT round-tripped through
      -- ::timestamptz, which would shift it to 05-23 under the UTC session and drop it from the window).
      INSERT INTO deals (id, name, stage_id, region_id, lost_at, actual_close_date, bid_estimate) VALUES
        ('${U("elf")}','lost fallback','${E.lost}','${ER.west}',NULL,'2026-05-24',3000);
      -- OPEN: on_hold (excluded from pipeline) + normal.
      INSERT INTO deals (id, name, stage_id, region_id, expected_close_date, bid_estimate, on_hold) VALUES
        ('${U("eo1")}','open onhold','${E.opp}','${ER.west}','2026-06-10',30000,true),
        ('${U("eo2")}','open normal','${E.opp}','${ER.west}','2026-06-10',60000,false);
    `);
    edb = drizzle(epg);
  });
  afterAll(async () => {
    await epg?.close?.();
  });

  it("counts archived (is_active=false) wins, excludes on_hold/test_data, respects window boundaries", async () => {
    const r = await getRegionReport(edb, { from: "2026-05-24", to: "2026-05-27", now: NOW });
    const west = r.regions.find((x) => x.region === "West Coast")!;
    // 100k normal + 40k archived + 10k boundary-from; on_hold/test_data/after-to excluded.
    expect(west.won).toEqual({ value: 150000, count: 3 });
    // West win rate = won 3 / (won 3 + lost 2) = 60%. Lost = elw (lost_at 05-25) + elf (actual_close_date
    // DATE-fallback on the 05-24 from-boundary, used as-is); etz (lost_at → business 05-23) is EXCLUDED by the
    // business-tz window. Proves lost windowing isn't session-tz-dependent AND the DATE arm isn't shifted.
    expect(west.winRate).toBeCloseTo(60, 1);
  });

  it("maps NULL-region wins to the Unassigned segment and reconciles to office", async () => {
    const r = await getRegionReport(edb, { from: "2026-05-24", to: "2026-05-27", now: NOW });
    const un = r.regions.find((x) => x.region === "Unassigned")!;
    expect(un.won).toEqual({ value: 25000, count: 1 });
    expect(r.summary.totalWon.value).toBe(175000); // 150k West + 25k Unassigned
    expect(r.summary.totalWon.value).toBe(r.regions.reduce((s, x) => s + x.won.value, 0));
  });

  it("excludes on_hold open deals from pipeline", async () => {
    const r = await getRegionReport(edb, { from: "2026-05-24", to: "2026-05-27", now: NOW });
    const west = r.regions.find((x) => x.region === "West Coast")!;
    expect(west.pipeline).toEqual({ value: 60000, count: 1 }); // open onhold (30k) excluded
  });
});
