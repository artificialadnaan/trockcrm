import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDealEffectivelyOnHold } from "@trock-crm/shared/types";
import { aliasedEffectiveOnHoldConditionSql } from "../../../src/modules/shared/deal-value-sql.js";
import { buildStatusPredicate } from "../../../src/modules/deals/deal-filter-predicates.js";

/**
 * TERMINAL-AWARE effective-on-hold reconciliation (Codex P2, findings 2 & 3): the SQL predicate that drives
 * the On Hold scope pill (buildDealOnHoldCondition) and the Active/On-hold STATUS filter (buildStatusPredicate)
 * must agree, row-for-row, with the shared TS twin isDealEffectivelyOnHold:
 *   - stored on_hold = held ALWAYS (open or terminal);
 *   - a far-out (90+ day) close target = held ONLY for an OPEN deal (auto-park);
 *   - a WON/LOST deal is realized/preserved -> NEVER auto-parked by a far-out date (only its stored flag).
 * Proven against real SQL on PGlite so the scope pill, the status filter, and the card $0/badge can't drift.
 */

const dialect = new PgDialect();
// CT (America/Chicago) is UTC-5 in June (CDT); the SQL anchors "today" to the CT calendar day. Pin the TS
// twin's `now` to the same instant so both worlds resolve the same calendar day in the assertions below.
const NOW = new Date("2026-06-01T12:00:00.000Z");
const FAR = "2099-12-31"; // far past the 90-day horizon
const NEAR = "2026-06-15"; // within 90 days

const TERMINAL_IDS = ["won", "lost"];

type Row = {
  id: string;
  stage_id: string;
  bid_board_stage_slug: string | null;
  on_hold: boolean;
  expected_close_date: string | null;
  isTerminal: boolean;
};

const ROWS: Row[] = [
  { id: "open_far", stage_id: "opportunity", bid_board_stage_slug: null, on_hold: false, expected_close_date: FAR, isTerminal: false },
  { id: "open_near", stage_id: "opportunity", bid_board_stage_slug: null, on_hold: false, expected_close_date: NEAR, isTerminal: false },
  { id: "open_stored_hold", stage_id: "opportunity", bid_board_stage_slug: null, on_hold: true, expected_close_date: NEAR, isTerminal: false },
  { id: "open_null_date", stage_id: "opportunity", bid_board_stage_slug: null, on_hold: false, expected_close_date: null, isTerminal: false },
  // Terminal deals with a far-out forecast date: realized/preserved -> NOT held (finding 3).
  { id: "won_far", stage_id: "won", bid_board_stage_slug: null, on_hold: false, expected_close_date: FAR, isTerminal: true },
  { id: "lost_far", stage_id: "lost", bid_board_stage_slug: null, on_hold: false, expected_close_date: FAR, isTerminal: true },
  // Terminal but explicitly stored on_hold -> still held (stored flag applies to terminal too).
  { id: "won_stored_hold", stage_id: "won", bid_board_stage_slug: null, on_hold: true, expected_close_date: FAR, isTerminal: true },
  // Bid Board-owned: CRM stage_id still OPEN but the BB mirror is terminal (won) -> realized -> NOT held
  // (finding D). isTerminal=true because the client treats a terminal bidBoardStageSlug as terminal.
  { id: "bb_mirror_far", stage_id: "opportunity", bid_board_stage_slug: "won", on_hold: false, expected_close_date: FAR, isTerminal: true },
];

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE deals (
      id text PRIMARY KEY,
      stage_id text NOT NULL,
      bid_board_stage_slug text,
      on_hold boolean NOT NULL DEFAULT false,
      expected_close_date date,
      is_active boolean NOT NULL DEFAULT true
    );
  `);
  for (const r of ROWS) {
    await db.query(
      `INSERT INTO deals (id, stage_id, bid_board_stage_slug, on_hold, expected_close_date) VALUES ($1,$2,$3,$4,$5)`,
      [r.id, r.stage_id, r.bid_board_stage_slug, r.on_hold, r.expected_close_date]
    );
  }
});

afterAll(async () => {
  await db?.close();
});

describe("aliasedEffectiveOnHoldConditionSql — terminal-aware, reconciles with the TS twin", () => {
  it("matches isDealEffectivelyOnHold row-for-row when terminal ids are supplied", async () => {
    const expr = dialect.sqlToQuery(aliasedEffectiveOnHoldConditionSql("deals", TERMINAL_IDS));
    const { rows } = await db.query<{ id: string; held: boolean }>(
      `SELECT id, (${expr.sql}) AS held FROM deals ORDER BY id`,
      expr.params as unknown[]
    );
    const heldById = new Map(rows.map((r) => [r.id, r.held]));
    for (const r of ROWS) {
      const tsHeld = isDealEffectivelyOnHold({
        onHold: r.on_hold,
        expectedCloseDate: r.expected_close_date,
        now: NOW,
        isTerminal: r.isTerminal,
      });
      expect(heldById.get(r.id)).toBe(tsHeld);
    }
    // Spot-checks of intent: open far-out held, terminal far-out NOT held, terminal+stored held, and a
    // Bid Board-mirrored terminal deal on an open CRM stage is NOT auto-parked (finding D).
    expect(heldById.get("open_far")).toBe(true);
    expect(heldById.get("won_far")).toBe(false);
    expect(heldById.get("lost_far")).toBe(false);
    expect(heldById.get("won_stored_hold")).toBe(true);
    expect(heldById.get("bb_mirror_far")).toBe(false);
  });

  it("without terminal ids ([]) auto-parks even terminal far-out rows (open-only legacy behavior)", async () => {
    const expr = dialect.sqlToQuery(aliasedEffectiveOnHoldConditionSql("deals", []));
    const { rows } = await db.query<{ id: string; held: boolean }>(
      `SELECT id, (${expr.sql}) AS held FROM deals WHERE id IN ('won_far','lost_far') ORDER BY id`,
      expr.params as unknown[]
    );
    // With no terminal exemption, a far-out terminal row would be (wrongly) treated as held — which is why
    // every production caller that can see terminal rows passes the terminal id set.
    expect(rows.every((r) => r.held)).toBe(true);
  });
});

describe("buildStatusPredicate — Active/On-hold are effective-hold + terminal-aware", () => {
  const ctx = { wonStageIds: ["won"], lostStageIds: ["lost"] };

  it("status=on_hold matches stored-hold + open-far-out, NOT realized terminal far-out", async () => {
    const expr = dialect.sqlToQuery(buildStatusPredicate({ status: "on_hold" }, ctx)!);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM deals WHERE ${expr.sql} ORDER BY id`,
      expr.params as unknown[]
    );
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["open_far", "open_stored_hold", "won_stored_hold"].sort());
  });

  it("status=active EXCLUDES auto-held open far-out but KEEPS realized terminal far-out", async () => {
    const expr = dialect.sqlToQuery(buildStatusPredicate({ status: "active" }, ctx)!);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM deals WHERE ${expr.sql} ORDER BY id`,
      expr.params as unknown[]
    );
    const ids = rows.map((r) => r.id).sort();
    // open_far + the two stored-hold rows drop out; realized won_far/lost_far + the BB-mirrored terminal
    // bb_mirror_far stay active.
    expect(ids).toEqual(["bb_mirror_far", "lost_far", "open_near", "open_null_date", "won_far"].sort());
  });
});
