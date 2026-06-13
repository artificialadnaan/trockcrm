import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getMondayShowcaseEvidence } from "../../../src/modules/reports/monday-showcase-service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

// REAL-SQL (PGlite) proof that the region Won drill reconciles to the region rollup AND that the
// Unassigned identity is airtight: with a large region_id IS NULL bucket, named-region drills must
// exclude NULL, the null bucket must be exactly the NULL deals, and named-regions + Unassigned must sum
// to the office total — no leak, no double-count. Executes the ACTUAL getMondayShowcaseEvidence path so
// the canonical won_closed_date basis + {from,to} window are exercised against real DATE/NUMERIC columns.

const WON = "11111111-1111-1111-1111-1111111111a1";
const OPEN = "11111111-1111-1111-1111-1111111111a2";
const R1 = "22222222-2222-2222-2222-2222222222a1";
const R2 = "22222222-2222-2222-2222-2222222222a2";
const RB = "22222222-2222-2222-2222-2222222222b0"; // a BLANK-named config row — the report folds it into Unassigned
const RU = "22222222-2222-2222-2222-2222222222c0"; // a config row literally named "Unassigned" — also folds in
const REP = "33333333-3333-3333-3333-333333333301";
const CO = "44444444-4444-4444-4444-444444444401";
const WON_SLUG = WON_STAGE_SLUGS[0];
const WINDOW = { from: "2026-06-01", to: "2026-06-13" };
const d = (n: number) => `55555555-5555-5555-5555-${String(n).padStart(12, "0")}`;

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text NOT NULL, name text, is_terminal boolean NOT NULL DEFAULT false);
    CREATE TABLE region_config (id uuid PRIMARY KEY, name text, display_order int, is_active boolean DEFAULT true);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE companies (id uuid PRIMARY KEY, name text, region text);
    CREATE TABLE project_type_config (id uuid PRIMARY KEY, name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, deal_number text, assigned_rep_id uuid, company_id uuid,
      region_id uuid, project_type_id uuid, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false, won_closed_date date, expected_close_date date,
      stage_entered_at timestamptz, project_type text, win_probability int,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    INSERT INTO pipeline_stage_config (id, slug, name, is_terminal) VALUES
      ('${WON}', '${WON_SLUG}', 'Won', true), ('${OPEN}', 'opportunity', 'Opportunity', false);
    INSERT INTO region_config (id, name, display_order) VALUES ('${R1}', 'West Coast', 1), ('${R2}', 'East Coast', 2), ('${RB}', '', 9), ('${RU}', 'Unassigned', 10);
    INSERT INTO users (id, display_name) VALUES ('${REP}', 'Rep One');
    INSERT INTO companies (id, name, region) VALUES ('${CO}', 'Acme', '');
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, company_id, region_id, won_closed_date, awarded_amount, bid_estimate, is_test_data, on_hold) VALUES
      ('${d(1)}', 'R1-A',           '${WON}',  '${REP}', '${CO}', '${R1}', '2026-06-05', 100000, NULL,  false, false),
      ('${d(2)}', 'R1-B',           '${WON}',  '${REP}', '${CO}', '${R1}', '2026-06-10', 50000,  NULL,  false, false),
      ('${d(3)}', 'R2-A',           '${WON}',  '${REP}', '${CO}', '${R2}', '2026-06-07', 80000,  NULL,  false, false),
      ('${d(4)}', 'UA-A',           '${WON}',  '${REP}', '${CO}', NULL,    '2026-06-08', 30000,  NULL,  false, false),
      ('${d(5)}', 'UA-B',           '${WON}',  '${REP}', '${CO}', NULL,    '2026-06-09', NULL,   20000, false, false),
      ('${d(6)}', 'R1-OutOfWindow', '${WON}',  '${REP}', '${CO}', '${R1}', '2026-05-20', 99999,  NULL,  false, false),
      ('${d(7)}', 'R1-TestData',    '${WON}',  '${REP}', '${CO}', '${R1}', '2026-06-06', 99999,  NULL,  true,  false),
      ('${d(8)}', 'R1-OnHold',      '${WON}',  '${REP}', '${CO}', '${R1}', '2026-06-06', 99999,  NULL,  false, true),
      ('${d(9)}', 'R1-Open',        '${OPEN}', '${REP}', '${CO}', '${R1}', NULL,         NULL,   NULL,  false, false),
      ('${d(10)}','BlankCfg',       '${WON}',  '${REP}', '${CO}', '${RB}', '2026-06-08', 12000,  NULL,  false, false),
      ('${d(11)}','UnassignedCfg',  '${WON}',  '${REP}', '${CO}', '${RU}', '2026-06-08', 8000,   NULL,  false, false);
  `);
  tdb = drizzle(pg);
}, 30000); // PGlite cold-start + seed can exceed the default 10s beforeAll timeout under parallel CI
afterAll(async () => { await pg?.close(); });

const won = (regionId: string | null | undefined) =>
  getMondayShowcaseEvidence(tdb, { metric: "won", regionId, from: WINDOW.from, to: WINDOW.to });

describe("region Won drill — canonical basis/window + airtight Unassigned identity (real types)", () => {
  it("a named-region drill returns exactly that region's in-window won deals, valued awarded-first", async () => {
    const r1 = await won(R1);
    expect(r1.total.count).toBe(2);
    expect(r1.total.value).toBe(150000); // 100000 + 50000, awarded-first
    expect(r1.records.map((rec) => rec.name).sort()).toEqual(["R1-A", "R1-B"]);
    expect(r1.scope).toEqual({ kind: "region", regionId: R1, regionName: "West Coast" });

    const r2 = await won(R2);
    expect(r2.total.count).toBe(1);
    expect(r2.total.value).toBe(80000);
  });

  it("the Unassigned bucket matches the report EXACTLY: region_id IS NULL + blank-named + literal-'Unassigned' configs", async () => {
    const ua = await won(null);
    expect(ua.total.count).toBe(4); // UA-A + UA-B (NULL) + BlankCfg (blank name) + UnassignedCfg (name = 'Unassigned')
    expect(ua.total.value).toBe(70000); // 30000 + 20000 (bid) + 12000 + 8000
    expect(ua.records.map((rec) => rec.name).sort()).toEqual(["BlankCfg", "UA-A", "UA-B", "UnassignedCfg"]);
    expect(ua.scope).toEqual({ kind: "region", regionId: null, regionName: "Unassigned" });
  });

  it("a named-region drill EXCLUDES the Unassigned set (no leak from the big NULL / blank / literal-Unassigned bucket)", async () => {
    const r1 = await won(R1);
    expect(r1.records.some((rec) => rec.name.startsWith("UA-"))).toBe(false);
    expect(r1.records.some((rec) => rec.name === "BlankCfg" || rec.name === "UnassignedCfg")).toBe(false);
  });

  it("PARTITION IDENTITY: named regions + Unassigned sum to the office total — no leak, no double-count", async () => {
    const [r1, r2, ua, office] = await Promise.all([won(R1), won(R2), won(null), won(undefined)]);
    // office number this drill must reconcile to
    expect(office.total.count).toBe(7); // out-of-window, test-data, on-hold, and open deals all excluded
    expect(office.total.value).toBe(300000);
    expect(office.scope).toEqual({ kind: "office" });
    // the segments partition the office set exactly
    expect(r1.total.count + r2.total.count + ua.total.count).toBe(office.total.count);
    expect((r1.total.value ?? 0) + (r2.total.value ?? 0) + (ua.total.value ?? 0)).toBe(office.total.value);
    // and they cover the same deal ids (no double-count, no orphan)
    const segmentIds = [...r1.records, ...r2.records, ...ua.records].map((rec) => rec.id).sort();
    const officeIds = office.records.map((rec) => rec.id).sort();
    expect(segmentIds).toEqual(officeIds);
  });

  it("the window is shared: a won deal outside {from,to} is excluded from every cut", async () => {
    const office = await won(undefined);
    expect(office.records.some((rec) => rec.name === "R1-OutOfWindow")).toBe(false);
    expect(office.period.from).toBe(WINDOW.from);
    expect(office.period.to).toBe(WINDOW.to);
  });
});
