import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getMondayShowcaseEvidence } from "../../../src/modules/reports/monday-showcase-service.js";
import { getRegionReport } from "../../../src/modules/reports/region-report-service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

// REAL-SQL (PGlite) proof that a region Won drill reconciles to the region report row it was clicked on.
// The drill keys on the report's DISPLAYED-region expression (COALESCE(NULLIF(rc.name,''),'Unassigned')),
// NOT a single region_id — because region_config.name is not unique, so two same-named config rows fold
// into ONE report row and a region_id predicate would undercount. This proves: dup-named configs fold
// together, the Unassigned bucket = NULL + blank + literal-"Unassigned" configs, named drills exclude
// Unassigned, and named + Unassigned = office (count, value, same deal-ids — no leak / double-count).

const WON = "11111111-1111-1111-1111-1111111111a1";
const OPEN = "11111111-1111-1111-1111-1111111111a2";
const R1 = "22222222-2222-2222-2222-2222222222a1"; // "West Coast"
const R1B = "22222222-2222-2222-2222-2222222222a3"; // ALSO "West Coast" (duplicate name) — must fold with R1
const R2 = "22222222-2222-2222-2222-2222222222a2"; // "East Coast"
const RB = "22222222-2222-2222-2222-2222222222b0"; // BLANK name -> Unassigned
const RU = "22222222-2222-2222-2222-2222222222c0"; // literally "Unassigned" -> Unassigned
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
      id uuid PRIMARY KEY, sales_source_user_id uuid, name text, deal_number text, project_number text, assigned_rep_id uuid, company_id uuid,
      region_id uuid, project_type_id uuid, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false, won_closed_date date, expected_close_date date,
      stage_entered_at timestamptz, project_type text, win_probability int,
      awarded_amount numeric, bid_board_total_sales numeric, bid_estimate numeric, dd_estimate numeric
    );
    INSERT INTO pipeline_stage_config (id, slug, name, is_terminal) VALUES
      ('${WON}', '${WON_SLUG}', 'Won', true), ('${OPEN}', 'opportunity', 'Opportunity', false);
    INSERT INTO region_config (id, name, display_order) VALUES
      ('${R1}', 'West Coast', 1), ('${R1B}', 'West Coast', 2), ('${R2}', 'East Coast', 3), ('${RB}', '', 9), ('${RU}', 'Unassigned', 10);
    INSERT INTO users (id, display_name) VALUES ('${REP}', 'Rep One');
    INSERT INTO companies (id, name, region) VALUES ('${CO}', 'Acme', '');
    INSERT INTO deals (id, name, stage_id, assigned_rep_id, company_id, region_id, won_closed_date, awarded_amount, bid_estimate, is_test_data, on_hold) VALUES
      ('${d(1)}', 'WC-A',           '${WON}',  '${REP}', '${CO}', '${R1}',  '2026-06-05', 100000, NULL,  false, false),
      ('${d(2)}', 'WC-B',           '${WON}',  '${REP}', '${CO}', '${R1}',  '2026-06-10', 50000,  NULL,  false, false),
      ('${d(12)}','WC-C-DupCfg',    '${WON}',  '${REP}', '${CO}', '${R1B}', '2026-06-11', 25000,  NULL,  false, false),
      ('${d(3)}', 'EC-A',           '${WON}',  '${REP}', '${CO}', '${R2}',  '2026-06-07', 80000,  NULL,  false, false),
      ('${d(4)}', 'UA-A',           '${WON}',  '${REP}', '${CO}', NULL,     '2026-06-08', 30000,  NULL,  false, false),
      ('${d(5)}', 'UA-B',           '${WON}',  '${REP}', '${CO}', NULL,     '2026-06-09', NULL,   20000, false, false),
      ('${d(10)}','BlankCfg',       '${WON}',  '${REP}', '${CO}', '${RB}',  '2026-06-08', 12000,  NULL,  false, false),
      ('${d(11)}','UnassignedCfg',  '${WON}',  '${REP}', '${CO}', '${RU}',  '2026-06-08', 8000,   NULL,  false, false),
      ('${d(6)}', 'WC-OutOfWindow', '${WON}',  '${REP}', '${CO}', '${R1}',  '2026-05-20', 99999,  NULL,  false, false),
      ('${d(7)}', 'WC-TestData',    '${WON}',  '${REP}', '${CO}', '${R1}',  '2026-06-06', 99999,  NULL,  true,  false),
      ('${d(8)}', 'WC-OnHold',      '${WON}',  '${REP}', '${CO}', '${R1}',  '2026-06-06', 99999,  NULL,  false, true),
      ('${d(9)}', 'WC-Open',        '${OPEN}', '${REP}', '${CO}', '${R1}',  NULL,         NULL,   5000,  false, false),
      ('${d(20)}','WC-Open2-Dup',   '${OPEN}', '${REP}', '${CO}', '${R1B}', NULL,         NULL,   7000,  false, false),
      ('${d(21)}','UA-Open',        '${OPEN}', '${REP}', '${CO}', NULL,     NULL,         NULL,   3000,  false, false);
  `);
  tdb = drizzle(pg);
}, 30000); // PGlite cold-start + seed can exceed the default 10s beforeAll timeout under parallel CI
afterAll(async () => { await pg?.close(); });

const won = (regionName: string | undefined) =>
  getMondayShowcaseEvidence(tdb, { metric: "won", regionName, from: WINDOW.from, to: WINDOW.to });

describe("region Won drill — keyed on the displayed-region name; dup configs fold; airtight partition", () => {
  it("a region drill folds ALL same-named configs into the clicked row (dup-name safe), valued awarded-first", async () => {
    const wc = await won("West Coast");
    // WC-A + WC-B (region R1) + WC-C-DupCfg (region R1B, a DIFFERENT config row also named 'West Coast')
    expect(wc.total.count).toBe(3);
    expect(wc.total.value).toBe(175000); // 100000 + 50000 + 25000
    expect(wc.records.map((rec) => rec.name).sort()).toEqual(["WC-A", "WC-B", "WC-C-DupCfg"]);
    expect(wc.scope).toEqual({ kind: "region", regionName: "West Coast" });
    // every row displays the CLICKED region (not the company's looser text region), so a correctly-scoped
    // row never looks mis-scoped in the drawer
    expect(wc.records.every((rec) => rec.region === "West Coast")).toBe(true);

    const ec = await won("East Coast");
    expect(ec.total.count).toBe(1);
    expect(ec.total.value).toBe(80000);
  });

  it("the Unassigned bucket = region_id IS NULL + blank-named + literal-'Unassigned' configs (matches the report)", async () => {
    const ua = await won("Unassigned");
    expect(ua.total.count).toBe(4); // UA-A + UA-B (NULL) + BlankCfg (blank name) + UnassignedCfg (name='Unassigned')
    expect(ua.total.value).toBe(70000); // 30000 + 20000 + 12000 + 8000
    expect(ua.records.map((rec) => rec.name).sort()).toEqual(["BlankCfg", "UA-A", "UA-B", "UnassignedCfg"]);
    expect(ua.scope).toEqual({ kind: "region", regionName: "Unassigned" });
  });

  it("a named-region drill EXCLUDES the Unassigned set (no leak)", async () => {
    const wc = await won("West Coast");
    expect(wc.records.some((rec) => rec.name.startsWith("UA-") || rec.name === "BlankCfg" || rec.name === "UnassignedCfg")).toBe(false);
  });

  it("PARTITION IDENTITY: every named region + Unassigned sum to the office total — no leak, no double-count", async () => {
    const [wc, ec, ua, office] = await Promise.all([won("West Coast"), won("East Coast"), won("Unassigned"), won(undefined)]);
    expect(office.total.count).toBe(8); // out-of-window, test-data, on-hold, and open deals all excluded
    expect(office.total.value).toBe(325000);
    expect(office.scope).toEqual({ kind: "office" });
    expect(wc.total.count + ec.total.count + ua.total.count).toBe(office.total.count);
    expect((wc.total.value ?? 0) + (ec.total.value ?? 0) + (ua.total.value ?? 0)).toBe(office.total.value);
    const segmentIds = [...wc.records, ...ec.records, ...ua.records].map((rec) => rec.id).sort();
    const officeIds = office.records.map((rec) => rec.id).sort();
    expect(segmentIds).toEqual(officeIds);
  });

  it("the window is shared: a won deal outside {from,to} is excluded from every cut", async () => {
    const office = await won(undefined);
    expect(office.records.some((rec) => rec.name === "WC-OutOfWindow")).toBe(false);
    expect(office.period.from).toBe(WINDOW.from);
    expect(office.period.to).toBe(WINDOW.to);
  });
});

const pipe = (regionName: string | undefined, stageSlug?: string) =>
  getMondayShowcaseEvidence(tdb, { metric: "pipeline", regionName, stageSlug, from: WINDOW.from, to: WINDOW.to });

describe("region Pipeline drill — all open deals, name-folded, region-scoped, optional heatmap stage", () => {
  it("pipeline = open deals in the region (dup configs fold), best-estimate value — NOT future-dated only", async () => {
    const wc = await pipe("West Coast");
    expect(wc.total.count).toBe(2); // WC-Open (R1) + WC-Open2-Dup (R1B, same display name) fold together
    expect(wc.total.value).toBe(12000); // 5000 + 7000
    const ua = await pipe("Unassigned");
    expect(ua.total.count).toBe(1);
    expect(ua.total.value).toBe(3000);
  });
  it("pipeline partition: West Coast + Unassigned = office open total (no leak/double-count)", async () => {
    const [wc, ua, office] = await Promise.all([pipe("West Coast"), pipe("Unassigned"), pipe(undefined)]);
    expect(office.total.count).toBe(3);
    expect(office.total.value).toBe(15000);
    expect(wc.total.count + ua.total.count).toBe(office.total.count);
    expect((wc.total.value ?? 0) + (ua.total.value ?? 0)).toBe(office.total.value); // value partitions too, not just count
  });
  it("a stageSlug narrows the pipeline drill to one region×stage heatmap cell", async () => {
    const inStage = await pipe("West Coast", "opportunity");
    expect(inStage.total.count).toBe(2); // both WC open deals are in the 'opportunity' stage
    const otherStage = await pipe("West Coast", "estimating");
    expect(otherStage.total.count).toBe(0); // none in 'estimating'
  });
});

// FIX 4 (the load-bearing one) — the region Won CARD (getRegionReport) and the click-to-records DRAWER
// (getMondayShowcaseEvidence → buildWonEvidenceSql) must count the SAME Won set. PR #733 added
// `is_active = true` to the drawer but NOT to the region card, so a SOFT-DELETED (is_active=false) Won deal
// showed in the card number but vanished from its records — half-applied, the worst outcome. This proves
// both surfaces now exclude the soft-deleted Won, and that the card number byte-reconciles to the drawer.
describe("region Won CARD ↔ DRAWER reconcile — soft-deleted (is_active=false) Won excluded from BOTH", () => {
  const WIN = { from: "2026-06-01", to: "2026-06-13" };
  const NOW = new Date("2026-06-13T18:00:00Z");
  const RW = "66666666-6666-6666-6666-66666666cc01"; // "West Coast"
  const SW = "66666666-6666-6666-6666-66666666cc09"; // Won stage
  const RP = "66666666-6666-6666-6666-66666666cc0a"; // rep
  const liveA = "66666666-6666-6666-6666-0000000000a1";
  const liveB = "66666666-6666-6666-6666-0000000000a2";
  const soft = "66666666-6666-6666-6666-0000000000a3";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cdb: any;
  let cpg: PGlite;

  beforeAll(async () => {
    cpg = new PGlite();
    await cpg.exec(`SET TimeZone='UTC';`);
    await cpg.exec(`
      CREATE TABLE users (id uuid PRIMARY KEY, display_name text NOT NULL);
      CREATE TABLE region_config (id uuid PRIMARY KEY, name text NOT NULL, display_order int NOT NULL, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE companies (id uuid PRIMARY KEY, name text, region text);
      CREATE TABLE project_type_config (id uuid PRIMARY KEY, name text);
      CREATE TABLE pipeline_stage_config (
        id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL,
        display_order int NOT NULL DEFAULT 0, workflow_family text NOT NULL DEFAULT 'standard_deal',
        is_terminal boolean NOT NULL DEFAULT false
      );
      CREATE TABLE deals (
        id uuid PRIMARY KEY, deal_number text, project_number text, name text NOT NULL, stage_id uuid NOT NULL,
        assigned_rep_id uuid, company_id uuid, region_id uuid, project_type_id uuid, project_type text,
        on_hold boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true,
        is_test_data boolean NOT NULL DEFAULT false, win_probability int,
        won_closed_date date, lost_at timestamptz, actual_close_date date, stage_entered_at timestamptz,
        expected_close_date date, created_at timestamptz NOT NULL DEFAULT now(),
        awarded_amount numeric, bid_estimate numeric, dd_estimate numeric, bid_board_total_sales numeric
      );
      INSERT INTO users (id, display_name) VALUES ('${RP}','Rep One');
      INSERT INTO region_config (id, name, display_order, is_active) VALUES ('${RW}','West Coast',1,true);
      INSERT INTO pipeline_stage_config (id, name, slug, display_order, is_terminal) VALUES ('${SW}','Won','${WON_SLUG}',7,true);
      -- Two LIVE wins + one SOFT-DELETED (is_active=false) win, all in-window for West Coast.
      INSERT INTO deals (id, name, stage_id, assigned_rep_id, region_id, won_closed_date, awarded_amount, is_active) VALUES
        ('${liveA}','Live A','${SW}','${RP}','${RW}','2026-06-05',100000,true),
        ('${liveB}','Live B','${SW}','${RP}','${RW}','2026-06-10',50000,true),
        ('${soft}','Soft-deleted (archived)','${SW}','${RP}','${RW}','2026-06-08',40000,false);
    `);
    cdb = drizzle(cpg);
  }, 30000);
  afterAll(async () => { await cpg?.close?.(); });

  it("card Won == drawer Won, and the soft-deleted Won is in NEITHER", async () => {
    const report = await getRegionReport(cdb, { from: WIN.from, to: WIN.to, now: NOW });
    const west = report.regions.find((x) => x.region === "West Coast")!;
    const drawer = await getMondayShowcaseEvidence(cdb, { metric: "won", regionName: "West Coast", from: WIN.from, to: WIN.to });

    // CARD: only the two live wins (40k soft-deleted excluded).
    expect(west.won).toEqual({ value: 150000, count: 2 });
    // DRAWER: same totals, and the soft-deleted deal is absent from the records.
    expect(drawer.total).toMatchObject({ count: 2, value: 150000 });
    expect(drawer.records.map((r) => r.id).sort()).toEqual([liveA, liveB].sort());
    expect(drawer.records.some((r) => r.id === soft)).toBe(false);

    // RECONCILIATION GUARANTEE: card number byte-matches the drawer it opens.
    expect(west.won.count).toBe(drawer.total.count);
    expect(west.won.value).toBe(drawer.total.value);
    // office summary reconciles too.
    expect(report.summary.totalWon).toEqual({ value: 150000, count: 2 });
  });
});
