import { PGlite } from "@electric-sql/pglite";
import { and, inArray, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { deals } from "@trock-crm/shared/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDealFilterBarConditions,
  UNASSIGNED_FILTER_SENTINEL,
  type DealFilterBarInput,
  type DealFilterContext,
} from "../../../src/modules/deals/deal-filter-predicates.js";

/**
 * END-TO-END VERIFICATION of the shared FilterBar's backend dimensions against a real
 * in-memory Postgres (PGlite) — each dimension run through the ACTUAL #546 predicate
 * registry (buildDealFilterBarConditions), asserting the correct result set incl. the
 * defining edges: __unassigned__ -> IS NULL, status owns is_active/on_hold, malformed
 * numeric -> no-match (never widens), unrecognized enum -> no-match, value on-hold-zeroed,
 * stalled flag-gating. The outcome-aware DATE edge (Won created-in / won-out) lives in
 * deal-date-scope.runtime.test.ts; this file exercises the same window through the registry.
 */

const dialect = new PgDialect();
const DATE_WINDOW: DealFilterBarInput = { dateFrom: "2026-02-01", dateTo: "2026-02-28" };
const WON_LOST_CTX: DealFilterContext = { wonStageIds: ["won"], lostStageIds: ["lost"] };

let db: PGlite;

async function matched(input: DealFilterBarInput, ctx: DealFilterContext = {}): Promise<string[]> {
  const conditions = buildDealFilterBarConditions(input, ctx);
  const where: SQL = conditions.length ? (and(...conditions) as SQL) : sql`true`;
  const { sql: text, params } = dialect.sqlToQuery(where);
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM deals WHERE ${text} ORDER BY id`, params as unknown[]);
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE deals (
      id text PRIMARY KEY,
      stage_id text NOT NULL DEFAULT 'open',
      assigned_rep_id text,
      region_id text,
      project_type_id text,
      workflow_route text NOT NULL DEFAULT 'normal',
      is_active boolean NOT NULL DEFAULT true,
      on_hold boolean NOT NULL DEFAULT false,
      won_closed_date date,
      lost_at timestamptz,
      stage_entered_at timestamptz,
      created_at timestamptz DEFAULT '2026-01-01T00:00:00Z',
      bid_board_total_sales numeric,
      bid_estimate numeric,
      dd_estimate numeric,
      awarded_amount numeric,
      is_bid_board_owned boolean NOT NULL DEFAULT false,
      bid_board_stage_entered_at timestamptz,
      on_hold_accumulated_seconds numeric,
      on_hold_accumulated_seconds_at_stage_entry numeric,
      on_hold_started_at timestamptz
    );
    INSERT INTO deals (id, stage_id, assigned_rep_id, region_id, project_type_id, workflow_route, is_active, on_hold, dd_estimate) VALUES
      ('rep_a',           'open', 'rep-a', 'reg-a', 'pt-a', 'normal',  true,  false, 50000),
      ('rep_b',           'open', 'rep-b', 'reg-b', 'pt-b', 'service', true,  false, 50000),
      ('unassigned',      'open', NULL,    NULL,    NULL,   'normal',  true,  false, 50000),
      ('onhold',          'open', 'rep-a', 'reg-a', 'pt-a', 'normal',  true,  true,  50000),
      -- soft-deleted on-hold row: inactive AND on_hold. status=on_hold must EXCLUDE it
      -- (would leak if the predicate regressed to just on_hold=true) — Codex #567.
      ('onhold_inactive', 'open', 'rep-a', 'reg-a', 'pt-a', 'normal',  false, true,  50000),
      ('inactive',        'open', 'rep-a', 'reg-a', 'pt-a', 'normal',  false, false, 50000),
      ('val_high',        'open', 'rep-a', 'reg-a', 'pt-a', 'normal',  true,  false, 900000);
    -- date-axis rows (outcome dates); is_active mirrors real terminal rows.
    -- won_in: LOW open best-estimate (dd 10000) but HIGH awarded (500000) — so a value filter only
    --   includes it if Won awarded-first classification is actually applied (Codex #567).
    -- won_out: won OUT of window but CREATED IN window — proves won_closed_date governs, not
    --   created_at (would pass spuriously if created_at were left outside the window) — Codex #567.
    INSERT INTO deals (id, stage_id, won_closed_date, dd_estimate, awarded_amount, created_at) VALUES
      ('won_in',  'won', '2026-02-15', 10000, 500000, '2025-01-01T00:00:00Z'),
      ('won_out', 'won', '2026-05-15', NULL,  500000, '2026-02-10T00:00:00Z');
    INSERT INTO deals (id, stage_id, is_active, lost_at) VALUES
      ('lost_in',  'lost', false, '2026-02-10T12:00:00Z'),
      ('lost_out', 'lost', false, '2026-05-10T12:00:00Z');
    INSERT INTO deals (id, stage_id, stage_entered_at) VALUES
      ('open_in',  'open', '2026-02-05T12:00:00Z'),
      ('open_out', 'open', '2026-05-01T12:00:00Z');
    -- stalled rows: one entered long ago, one entered ~now (relative to test run)
    INSERT INTO deals (id, stage_id, stage_entered_at) VALUES
      ('stalled_old', 'open', '2020-01-01T00:00:00Z'),
      ('stalled_new', 'open', now() - interval '2 days');
  `);
});

afterAll(async () => {
  await db?.close();
});

describe("FilterBar backend dimensions — real SQL via the #546 predicate registry", () => {
  describe("assigned rep (+ __unassigned__ sentinel)", () => {
    it("filters by rep id", async () => {
      expect(await matched({ assignedRepId: "rep-a" })).toContain("rep_a");
      expect(await matched({ assignedRepId: "rep-a" })).not.toContain("rep_b");
    });
    it("maps __unassigned__ to IS NULL (matches NULL-rep rows, excludes assigned)", async () => {
      const ids = await matched({ assignedRepId: UNASSIGNED_FILTER_SENTINEL });
      expect(ids).toContain("unassigned");
      expect(ids).not.toContain("rep_a");
      expect(ids).not.toContain("rep_b");
    });
    it("unset rep omits the predicate (no narrowing)", async () => {
      expect((await matched({})).length).toBeGreaterThan(1);
    });
  });

  describe("region (+ __unassigned__ sentinel)", () => {
    it("filters by region id, and the sentinel -> IS NULL", async () => {
      expect(await matched({ regionId: "reg-a" })).toContain("rep_a");
      expect(await matched({ regionId: "reg-a" })).not.toContain("rep_b");
      const unassigned = await matched({ regionId: UNASSIGNED_FILTER_SENTINEL });
      expect(unassigned).toContain("unassigned");
      expect(unassigned).not.toContain("rep_a");
    });
  });

  describe("project type", () => {
    it("eq on project_type_id", async () => {
      expect(await matched({ projectTypeId: "pt-b" })).toEqual(["rep_b"]);
    });
  });

  describe("workflow route", () => {
    it("eq on the stored route value", async () => {
      expect(await matched({ workflowRoute: "service" })).toEqual(["rep_b"]);
    });
    it("'all' / empty omits; an UNRECOGNIZED value no-matches (never widens)", async () => {
      expect((await matched({ workflowRoute: "all" })).length).toBeGreaterThan(1);
      expect(await matched({ workflowRoute: "bogus" })).toEqual([]);
    });
  });

  describe("status (owns is_active / on_hold; 'any' returns everything)", () => {
    it("active = is_active AND NOT on_hold (excludes on-hold + inactive)", async () => {
      const ids = await matched({ status: "active" });
      expect(ids).toContain("rep_a");
      expect(ids).not.toContain("onhold");
      expect(ids).not.toContain("inactive");
    });
    it("on_hold = active AND on_hold; a soft-deleted (inactive) on-hold row is EXCLUDED (Codex #567)", async () => {
      const ids = await matched({ status: "on_hold" });
      expect(ids).toContain("onhold"); // active + on_hold
      expect(ids).not.toContain("onhold_inactive"); // inactive + on_hold — must NOT leak (would, if predicate were just on_hold=true)
      expect(ids).not.toContain("rep_a"); // active, not on_hold
    });
    it("inactive = is_active=false", async () => {
      const ids = await matched({ status: "inactive" });
      expect(ids).toContain("inactive");
      expect(ids).toContain("lost_in"); // terminal lost rows are inactive
      expect(ids).not.toContain("rep_a");
    });
    it("'any' omits the predicate -> everything (no is_active narrowing)", async () => {
      const any = await matched({ status: "any" });
      const none = await matched({});
      expect(any).toEqual(none);
      expect(any).toContain("inactive"); // includes inactive when 'any'
    });
    it("an unrecognized status no-matches rather than silently omitting", async () => {
      expect(await matched({ status: "garbage" })).toEqual([]);
    });
  });

  describe("value range (stage-aware effective value, on-hold-zeroed)", () => {
    it("Won deals are valued awarded-first, NOT the open best-estimate — classification actually matters (Codex #567)", async () => {
      // won_in: open best-estimate = dd 10000, awarded = 500000. Only awarded-first puts it >= 100000.
      expect(await matched({ valueMin: 100000 }, WON_LOST_CTX)).toContain("won_in");
      // Drop Won classification (no wonStageIds): the SAME row falls to the open best-estimate (10000)
      // and is EXCLUDED — proving the inclusion above depends on awarded-first, not a coincidental
      // awarded fallback shared by both chains.
      expect(await matched({ valueMin: 100000 }, {})).not.toContain("won_in");
    });
    it("open deals are valued on the best-estimate chain", async () => {
      const ids = await matched({ valueMin: 100000 }, WON_LOST_CTX);
      expect(ids).toContain("val_high"); // dd 900000
      expect(ids).not.toContain("rep_b"); // dd 50000
    });
    it("on-hold deals are zeroed, so a positive valueMin excludes them", async () => {
      expect(await matched({ valueMin: 1 }, WON_LOST_CTX)).not.toContain("onhold");
    });
    it("MALFORMED bound (NaN, from ?valueMin=abc) no-matches — it must NOT widen results", async () => {
      expect(await matched({ valueMin: Number.NaN }, WON_LOST_CTX)).toEqual([]);
      expect(await matched({ valueMax: Number.NaN }, WON_LOST_CTX)).toEqual([]);
    });
    it("unset value range omits the predicate", async () => {
      expect((await matched({}, WON_LOST_CTX)).length).toBeGreaterThan(1);
    });
  });

  describe("stalled / days-in-stage (GATED on stageEntryDateEnabled)", () => {
    it("flag OFF: the predicate is omitted entirely (inert — no narrowing)", async () => {
      const off = await matched({ minAgeDays: 365 }, { stageEntryDateEnabled: false });
      expect(off).toEqual(await matched({}));
    });
    it("flag ON: minAgeDays keeps long-stalled rows, drops fresh ones", async () => {
      const ids = await matched({ minAgeDays: 365 }, { stageEntryDateEnabled: true });
      expect(ids).toContain("stalled_old"); // entered 2020
      expect(ids).not.toContain("stalled_new"); // entered ~2 days ago
    });
    it("flag ON: maxAgeDays keeps fresh rows, drops long-stalled ones", async () => {
      const ids = await matched({ maxAgeDays: 30 }, { stageEntryDateEnabled: true });
      expect(ids).toContain("stalled_new");
      expect(ids).not.toContain("stalled_old");
    });
    it("flag ON: MALFORMED age (NaN) no-matches", async () => {
      expect(await matched({ minAgeDays: Number.NaN }, { stageEntryDateEnabled: true })).toEqual([]);
    });
  });

  describe("outcome-aware date window (through the registry; same axis as deal-date-scope)", () => {
    it("flag OFF: Won windows on won date, Lost on lost_at; open rows pass through (current-state)", async () => {
      const ids = await matched({ ...DATE_WINDOW }, WON_LOST_CTX);
      expect(ids).toContain("won_in");
      expect(ids).not.toContain("won_out"); // THE bug edge — won date governs, not created
      expect(ids).toContain("lost_in");
      expect(ids).not.toContain("lost_out");
      expect(ids).toContain("open_out"); // open is current-state when flag off
    });
    it("flag ON: open rows become stage-entry-bounded", async () => {
      const ids = await matched({ ...DATE_WINDOW }, { ...WON_LOST_CTX, stageEntryDateEnabled: true });
      expect(ids).toContain("open_in");
      expect(ids).not.toContain("open_out");
    });
  });

  describe("composition: multiple dimensions AND together", () => {
    it("rep + status active narrows to the intersection", async () => {
      const ids = await matched({ assignedRepId: "rep-a", status: "active" });
      expect(ids).toContain("rep_a");
      expect(ids).not.toContain("onhold"); // rep-a but on hold
      expect(ids).not.toContain("rep_b"); // active but rep-b
    });
  });

  describe("excludeOnHold (Won reconciliation — drops migration parking-lot on-hold deals)", () => {
    it("excludes on-hold rows (active OR inactive) and keeps non-on-hold rows", async () => {
      const ids = await matched({ excludeOnHold: true });
      expect(ids).not.toContain("onhold"); // active + on_hold -> excluded
      expect(ids).not.toContain("onhold_inactive"); // inactive + on_hold -> excluded
      expect(ids).toContain("rep_a"); // not on_hold -> kept
      expect(ids).toContain("inactive"); // inactive but NOT on_hold -> kept (it only drops on_hold)
    });

    it("includes on-hold rows when the flag is absent (every non-Won caller is unchanged)", async () => {
      const ids = await matched({});
      expect(ids).toContain("onhold");
    });
  });
});

describe("stageIds", () => {
  it("drives the production inArray(deals.stageId, ...) construct getDeals uses — not a hand-written SQL literal (Codex #567)", async () => {
    // getDeals applies the stage filter via inArray(deals.stageId, filters.stageIds). Render THAT
    // drizzle construct (real column + operator) and run it, so a schema/operator break is caught.
    // The getDeals WIRING (that the request's stageIds are read + pushed) is guarded separately by
    // server/tests/modules/deals/filterbar-getdeals.test.ts (asserts the emitted SQL contains stage_id).
    const { sql: text, params } = dialect.sqlToQuery(inArray(deals.stageId, ["won", "lost"]));
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM deals WHERE ${text} ORDER BY id`,
      params as unknown[]
    );
    expect(rows.map((r) => r.id)).toEqual(["lost_in", "lost_out", "won_in", "won_out"]);
  });
});
