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
 *   - a far-out (90+ day) HOLD HORIZON DATE = held ONLY for an OPEN deal (auto-park);
 *   - in the genuine 'estimating' stage that horizon date is the BID due date, falling back to the close
 *     target when it is null (2026-07-27); every other stage keeps the close target;
 *   - a WON/LOST deal is realized/preserved -> NEVER auto-parked by a far-out date (only its stored flag).
 * Proven against real SQL on PGlite so the scope pill, the status filter, and the card $0/badge can't drift.
 * The estimating branch is classified in SQL by a pipeline_stage_config subselect and in TS by the
 * route-aware canonicalizer, so this file is the ONLY place the two classifications are proven equal.
 */

const dialect = new PgDialect();
// CT (America/Chicago) is UTC-5 in June (CDT); the SQL anchors "today" to the CT calendar day. Pin the TS
// twin's `now` to the same instant so both worlds resolve the same calendar day in the assertions below.
const NOW = new Date("2026-06-01T12:00:00.000Z");
const FAR = "2099-12-31"; // far past the 90-day horizon
const NEAR = "2026-06-15"; // within 90 days
// bid_due_date is a timestamptz stored at UTC MIDNIGHT (migration 0132 / dealBidDueDateToDateOnly). Feed
// the SQL that exact shape so the `(bid_due_date AT TIME ZONE 'UTC')::date` normalization is under test
// rather than assumed.
const FAR_TS = `${FAR}T00:00:00.000Z`;
const NEAR_TS = `${NEAR}T00:00:00.000Z`;

const TERMINAL_IDS = ["won", "lost"];

type Row = {
  id: string;
  stage_id: string;
  bid_board_stage_slug: string | null;
  on_hold: boolean;
  expected_close_date: string | null;
  /** deals.bid_due_date — a timestamptz stored at UTC midnight, exactly as prod holds it. */
  bid_due_date: string | null;
  isTerminal: boolean;
  /** What the TS twin is told; SQL derives the same verdict from stage_id via pipeline_stage_config. */
  isEstimating: boolean;
};

const ROWS: Row[] = [
  { id: "open_far", stage_id: "opportunity", bid_board_stage_slug: null, on_hold: false, expected_close_date: FAR, bid_due_date: null, isTerminal: false, isEstimating: false },
  { id: "open_near", stage_id: "opportunity", bid_board_stage_slug: null, on_hold: false, expected_close_date: NEAR, bid_due_date: null, isTerminal: false, isEstimating: false },
  { id: "open_stored_hold", stage_id: "opportunity", bid_board_stage_slug: null, on_hold: true, expected_close_date: NEAR, bid_due_date: null, isTerminal: false, isEstimating: false },
  { id: "open_null_date", stage_id: "opportunity", bid_board_stage_slug: null, on_hold: false, expected_close_date: null, bid_due_date: null, isTerminal: false, isEstimating: false },
  // Terminal deals with a far-out forecast date: realized/preserved -> NOT held (finding 3).
  { id: "won_far", stage_id: "won", bid_board_stage_slug: null, on_hold: false, expected_close_date: FAR, bid_due_date: null, isTerminal: true, isEstimating: false },
  { id: "lost_far", stage_id: "lost", bid_board_stage_slug: null, on_hold: false, expected_close_date: FAR, bid_due_date: null, isTerminal: true, isEstimating: false },
  // Terminal but explicitly stored on_hold -> still held (stored flag applies to terminal too).
  { id: "won_stored_hold", stage_id: "won", bid_board_stage_slug: null, on_hold: true, expected_close_date: FAR, bid_due_date: null, isTerminal: true, isEstimating: false },
  // Bid Board-owned: CRM stage_id still OPEN but the BB mirror is terminal (won) -> realized -> NOT held
  // (finding D). isTerminal=true because the client treats a terminal bidBoardStageSlug as terminal.
  { id: "bb_mirror_far", stage_id: "opportunity", bid_board_stage_slug: "won", on_hold: false, expected_close_date: FAR, bid_due_date: null, isTerminal: true, isEstimating: false },

  // ---- the estimating bid-due-date horizon (2026-07-27) ----
  // Near close target but a FAR bid due date -> now HELD. This is the direction that removes dollars from
  // reported pipeline, and the reason the rule exists: estimating work has to stay near-term.
  { id: "est_near_close_far_bid", stage_id: "estimating", bid_board_stage_slug: null, on_hold: false, expected_close_date: NEAR, bid_due_date: FAR_TS, isTerminal: false, isEstimating: true },
  // FAR close target but a NEAR bid due date -> now RELEASED. A live bid is not a parked deal.
  { id: "est_far_close_near_bid", stage_id: "estimating", bid_board_stage_slug: null, on_hold: false, expected_close_date: FAR, bid_due_date: NEAR_TS, isTerminal: false, isEstimating: true },
  // NULL bid due date -> falls back to the close target, reproducing today's behaviour byte-for-byte.
  { id: "est_far_close_null_bid", stage_id: "estimating", bid_board_stage_slug: null, on_hold: false, expected_close_date: FAR, bid_due_date: null, isTerminal: false, isEstimating: true },
  { id: "est_near_close_null_bid", stage_id: "estimating", bid_board_stage_slug: null, on_hold: false, expected_close_date: NEAR, bid_due_date: null, isTerminal: false, isEstimating: true },
  // BOTH dates null -> no horizon at all -> not held (and, critically, still ACTIVE — see the status test).
  { id: "est_all_null", stage_id: "estimating", bid_board_stage_slug: null, on_hold: false, expected_close_date: null, bid_due_date: null, isTerminal: false, isEstimating: true },
  // The legacy alias canonicalizes to 'estimating' and MUST get the same rule.
  { id: "est_legacy_alias", stage_id: "estimate_in_progress", bid_board_stage_slug: null, on_hold: false, expected_close_date: NEAR, bid_due_date: FAR_TS, isTerminal: false, isEstimating: true },
  // service_estimating is deliberately OUT of scope -> keeps the close-target rule, so this row is NOT held.
  { id: "service_est_far_bid", stage_id: "service_estimating", bid_board_stage_slug: null, on_hold: false, expected_close_date: NEAR, bid_due_date: FAR_TS, isTerminal: false, isEstimating: false },
  // ...nor is estimate_sent_to_client, the far bigger stage next door (261 active deals on prod).
  { id: "sent_to_client_far_bid", stage_id: "estimate_sent_to_client", bid_board_stage_slug: null, on_hold: false, expected_close_date: NEAR, bid_due_date: FAR_TS, isTerminal: false, isEstimating: false },
  // A Bid Board-owned deal can be WON in the mirror while its CRM stage still reads estimating. Its value
  // is realized, so the estimating horizon must sit INSIDE the terminal exemption, not beside it.
  { id: "est_bb_terminal_far_bid", stage_id: "estimating", bid_board_stage_slug: "won", on_hold: false, expected_close_date: NEAR, bid_due_date: FAR_TS, isTerminal: true, isEstimating: true },
];

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    -- pipeline_stage_config lives ONLY in \`public\` in prod (verified against the live DB), which is why
    -- the shared predicate qualifies its subselect that way. PGlite's default schema IS public, so a bare
    -- CREATE TABLE here reproduces that placement.
    CREATE TABLE pipeline_stage_config (id text PRIMARY KEY, slug text NOT NULL);
    INSERT INTO pipeline_stage_config (id, slug) VALUES
      ('opportunity', 'opportunity'),
      ('estimating', 'estimating'),
      ('estimate_in_progress', 'estimate_in_progress'),
      ('service_estimating', 'service_estimating'),
      ('estimate_sent_to_client', 'estimate_sent_to_client'),
      ('won', 'won'),
      ('lost', 'lost');
    CREATE TABLE deals (
      id text PRIMARY KEY, sales_source_user_id uuid,
      stage_id text NOT NULL,
      bid_board_stage_slug text,
      on_hold boolean NOT NULL DEFAULT false,
      expected_close_date date, bid_due_date timestamptz,
      is_active boolean NOT NULL DEFAULT true
    );
  `);
  for (const r of ROWS) {
    await db.query(
      `INSERT INTO deals (id, stage_id, bid_board_stage_slug, on_hold, expected_close_date, bid_due_date) VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.id, r.stage_id, r.bid_board_stage_slug, r.on_hold, r.expected_close_date, r.bid_due_date]
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
        bidDueDate: r.bid_due_date,
        isEstimating: r.isEstimating,
        now: NOW,
        isTerminal: r.isTerminal,
      });
      expect(heldById.get(r.id), `row ${r.id}`).toBe(tsHeld);
    }
    // Spot-checks of intent: open far-out held, terminal far-out NOT held, terminal+stored held, and a
    // Bid Board-mirrored terminal deal on an open CRM stage is NOT auto-parked (finding D).
    expect(heldById.get("open_far")).toBe(true);
    expect(heldById.get("won_far")).toBe(false);
    expect(heldById.get("lost_far")).toBe(false);
    expect(heldById.get("won_stored_hold")).toBe(true);
    expect(heldById.get("bb_mirror_far")).toBe(false);
    // The estimating branch, spelled out: the bid due date decides, and ONLY in estimating.
    expect(heldById.get("est_near_close_far_bid")).toBe(true);
    expect(heldById.get("est_far_close_near_bid")).toBe(false);
    expect(heldById.get("est_far_close_null_bid")).toBe(true);
    expect(heldById.get("est_near_close_null_bid")).toBe(false);
    expect(heldById.get("est_all_null")).toBe(false);
    expect(heldById.get("est_legacy_alias")).toBe(true);
    expect(heldById.get("service_est_far_bid")).toBe(false);
    expect(heldById.get("sent_to_client_far_bid")).toBe(false);
    expect(heldById.get("est_bb_terminal_far_bid")).toBe(false);
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
    expect(ids).toEqual(
      ["open_far", "open_stored_hold", "won_stored_hold", "est_near_close_far_bid", "est_far_close_null_bid", "est_legacy_alias"].sort()
    );
  });

  it("status=active EXCLUDES auto-held open far-out but KEEPS realized terminal far-out", async () => {
    const expr = dialect.sqlToQuery(buildStatusPredicate({ status: "active" }, ctx)!);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM deals WHERE ${expr.sql} ORDER BY id`,
      expr.params as unknown[]
    );
    const ids = rows.map((r) => r.id).sort();
    // open_far + the two stored-hold rows drop out; realized won_far/lost_far + the BB-mirrored terminal
    // bb_mirror_far stay active. On the estimating side: the far-bid rows drop out, the near-bid row is
    // RELEASED back into Active despite its far-out close target, and est_all_null (no horizon date at all)
    // stays Active — the three-valued-logic guard, since `NOT (NULL > x)` would have dropped it.
    expect(ids).toEqual(
      [
        "bb_mirror_far",
        "lost_far",
        "open_near",
        "open_null_date",
        "won_far",
        "est_far_close_near_bid",
        "est_near_close_null_bid",
        "est_all_null",
        "service_est_far_bid",
        "sent_to_client_far_bid",
        "est_bb_terminal_far_bid",
      ].sort()
    );
  });
});

/**
 * The 90-day boundary and the UTC day-resolution of bid_due_date, on rows anchored to the SQL's OWN
 * `now()` (the fixture above pins the TS twin to a fixed instant instead, so it cannot probe a boundary).
 * Its own PGlite instance so the row-for-row reconciliation sets above stay exact.
 */
describe("estimating bid-due horizon — 90-day boundary and UTC day resolution", () => {
  let bdb: PGlite;

  beforeAll(async () => {
    bdb = new PGlite();
    await bdb.exec(`SET TimeZone='UTC';`);
    await bdb.exec(`
      CREATE TABLE pipeline_stage_config (id text PRIMARY KEY, slug text NOT NULL);
      INSERT INTO pipeline_stage_config (id, slug) VALUES ('estimating', 'estimating');
      CREATE TABLE deals (
        id text PRIMARY KEY,
        stage_id text NOT NULL,
        bid_board_stage_slug text,
        on_hold boolean NOT NULL DEFAULT false,
        expected_close_date date,
        bid_due_date timestamptz,
        is_active boolean NOT NULL DEFAULT true
      );
      -- UTC midnight of (CT-today + N days), the exact shape prod stores. Anchored to now() so the rows
      -- sit ON the horizon rather than years away from it.
      INSERT INTO deals (id, stage_id, expected_close_date, bid_due_date) VALUES
        ('bid_at_horizon',   'estimating', NULL, (((now() AT TIME ZONE 'America/Chicago')::date + 90)::timestamp AT TIME ZONE 'UTC')),
        ('bid_past_horizon', 'estimating', NULL, (((now() AT TIME ZONE 'America/Chicago')::date + 91)::timestamp AT TIME ZONE 'UTC'));
    `);
  });

  afterAll(async () => {
    await bdb?.close();
  });

  const verdicts = async (timeZone: string) => {
    await bdb.exec(`SET TimeZone='${timeZone}';`);
    const expr = dialect.sqlToQuery(aliasedEffectiveOnHoldConditionSql("deals", TERMINAL_IDS));
    const { rows } = await bdb.query<{ id: string; held: boolean }>(
      `SELECT id, (${expr.sql}) AS held FROM deals ORDER BY id`,
      expr.params as unknown[]
    );
    return new Map(rows.map((r) => [r.id, r.held]));
  };

  it("is STRICTLY greater-than the horizon, mirroring the TS twin", async () => {
    const held = await verdicts("UTC");
    expect(held.get("bid_at_horizon")).toBe(false);
    expect(held.get("bid_past_horizon")).toBe(true);
  });

  it("gives the same verdict under a negative-offset session timezone", async () => {
    // THE guard. bid_due_date is timestamptz at UTC midnight; a bare `::date` resolves in the SESSION
    // zone, so under America/Chicago (UTC-5) 2026-10-26T00:00Z would render as 2026-10-25 and the
    // past-horizon row would silently flip to NOT held — a dollar value moving because a pooler set a
    // session timezone. Prod runs Etc/UTC today, which is precisely why this would go unnoticed.
    const utc = await verdicts("UTC");
    const chicago = await verdicts("America/Chicago");
    // Pacific/Kiritimati is UTC+14 — the opposite extreme.
    const kiritimati = await verdicts("Pacific/Kiritimati");
    for (const id of ["bid_at_horizon", "bid_past_horizon"]) {
      expect(chicago.get(id), `${id} @ America/Chicago`).toBe(utc.get(id));
      expect(kiritimati.get(id), `${id} @ Pacific/Kiritimati`).toBe(utc.get(id));
    }
  });
});
