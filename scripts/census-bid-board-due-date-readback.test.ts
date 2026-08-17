import { describe, expect, it } from "vitest";
import {
  buildCensusSql,
  officeSchemaName,
  parseCensusArgs,
  summarizeCensus,
  type CensusRow,
} from "./census-bid-board-due-date-readback.js";
// The app's OWN builders. Asserting the census EMBEDS these (rather than re-deriving the same strings by
// hand here) is the point: if the platform's hold rule changes, the census changes with it or this fails.
import { closeTargetFarOutSqlPredicate, holdHorizonDateSql } from "@trock-crm/shared/types";

function row(partial: Partial<CensusRow>): CensusRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    deal_number: "DFW-1-00001-aa",
    project_number: "DFW-1-00001-aa",
    name: "Test Tower",
    stage_slug: "estimating",
    deal_value: "100000",
    current_bid_due_date: null,
    next_bid_due_date: new Date("2026-09-01T00:00:00.000Z"),
    stored_on_hold: false,
    bid_board_last_updated_at: null,
    from_null: true,
    is_genuine_estimating: true,
    is_terminal: false,
    current_horizon: "2026-08-20",
    next_horizon: "2026-09-01",
    currently_far_out: false,
    next_far_out: false,
    ...partial,
  };
}

describe("census-bid-board-due-date-readback — arguments", () => {
  it("defaults to the dallas office and a 15-row mover sample", () => {
    expect(parseCensusArgs(["node", "census"])).toEqual({ offices: ["dallas"], limit: 15, json: false });
  });

  it("accepts an office slug, a comma list, --all, --limit and --json", () => {
    expect(parseCensusArgs(["node", "census", "--office=atlanta"]).offices).toEqual(["atlanta"]);
    expect(parseCensusArgs(["node", "census", "--office=dallas,atlanta"]).offices).toEqual([
      "dallas",
      "atlanta",
    ]);
    expect(parseCensusArgs(["node", "census", "--all"]).offices).toBe("all");
    expect(parseCensusArgs(["node", "census", "--limit=3", "--json"])).toMatchObject({ limit: 3, json: true });
  });

  // THE safety test. Every backfill script in this directory takes --commit, so the muscle memory is real;
  // a census that silently IGNORED it would look like it had applied something. It must abort instead.
  it.each(["--commit", "--apply", "--write", "--execute", "--force"])(
    "REFUSES the write flag %s rather than ignoring it",
    (flag) => {
      expect(() => parseCensusArgs(["node", "census", flag])).toThrow(/READ-ONLY/);
    }
  );

  it("rejects an injection-shaped office slug and a bad limit", () => {
    expect(() => parseCensusArgs(["node", "census", "--office=dallas; DROP SCHEMA public"])).toThrow(
      /Invalid office slug/
    );
    expect(() => officeSchemaName('dallas"')).toThrow(/Invalid office slug/);
    expect(() => parseCensusArgs(["node", "census", "--limit=-1"])).toThrow(/--limit/);
    expect(() => parseCensusArgs(["node", "census", "--all", "--office=dallas"])).toThrow(/not both/);
  });
});

describe("census-bid-board-due-date-readback — SQL", () => {
  const sql = buildCensusSql("office_dallas");

  it("uses the app's OWN hold builders for both the current and the prospective horizon", () => {
    // Not "contains a CASE WHEN" — the literal output of the shared builders, at both aliases. A
    // hand-rolled copy is how a census ends up quoting a number the app then disagrees with.
    expect(sql).toContain(holdHorizonDateSql("cur"));
    expect(sql).toContain(holdHorizonDateSql("nxt"));
    expect(sql).toContain(closeTargetFarOutSqlPredicate("cur"));
    expect(sql).toContain(closeTargetFarOutSqlPredicate("nxt"));
  });

  it("reads bid_due_date AT TIME ZONE 'UTC' (inherited from the shared builder) — the off-by-one guard", () => {
    expect(sql).toContain("(cur.bid_due_date AT TIME ZONE 'UTC')::date");
    expect(sql).toContain("(nxt.bid_due_date AT TIME ZONE 'UTC')::date");
  });

  it("materializes the prospective value as UTC midnight, exactly like the write-through", () => {
    expect(sql).toContain("(d.bid_board_due_date::timestamp AT TIME ZONE 'UTC') AS next_bid_due_date");
  });

  it("only considers rows the ingest's loop could actually reach, and only real changes", () => {
    expect(sql).toContain("d.is_active = true");
    expect(sql).toContain("COALESCE(d.is_change_order, false) = false");
    expect(sql).toContain("d.bid_board_detached_at IS NULL");
    expect(sql).toContain("d.bid_board_due_date IS NOT NULL");
    expect(sql).toContain("current_bid_due_date IS DISTINCT FROM next_bid_due_date");
  });

  it("contains no write verb at all", () => {
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
  });

  it("refuses a schema name that is not an office schema", () => {
    expect(() => buildCensusSql("public")).toThrow(/Invalid schema name/);
    expect(() => buildCensusSql('office_x"; DROP SCHEMA public; --')).toThrow(/Invalid schema name/);
  });
});

describe("census-bid-board-due-date-readback — summary", () => {
  it("splits the writes into null->date and date->different-date, and counts genuine estimating", () => {
    const summary = summarizeCensus(
      "office_dallas",
      [
        row({ from_null: true, is_genuine_estimating: true }),
        row({ from_null: false, is_genuine_estimating: false, stage_slug: "contract" }),
        row({ from_null: false, is_genuine_estimating: true }),
      ],
      10
    );
    expect(summary.wouldWrite).toBe(3);
    expect(summary.fromNull).toBe(1);
    expect(summary.fromDifferentDate).toBe(2);
    expect(summary.genuineEstimating).toBe(2);
  });

  it("nets the park (value removed) against the un-park (value restored)", () => {
    const summary = summarizeCensus(
      "office_dallas",
      [
        // Parks: horizon moves beyond 90 days -> the deal's value drops out of reported pipeline.
        row({ deal_value: "241000", currently_far_out: false, next_far_out: true }),
        // Un-parks: a near bid date rescues a deal a far-out close target had parked.
        row({ deal_value: "89000", currently_far_out: true, next_far_out: false }),
        row({ deal_value: "500000", currently_far_out: true, next_far_out: false }),
        // No verdict change -> contributes nothing either way.
        row({ deal_value: "999999", currently_far_out: true, next_far_out: true }),
      ],
      10
    );
    expect(summary.wouldPark).toBe(1);
    expect(summary.wouldUnpark).toBe(2);
    expect(summary.parkedValue).toBe(241000);
    expect(summary.unparkedValue).toBe(589000);
    expect(summary.netValueDelta).toBe(348000);
  });

  it("excludes stored-on-hold and TERMINAL deals from the transitions — neither one's dollars can move", () => {
    // A stored on_hold deal already reports $0 via the always-applies leg; a terminal (won/lost) deal is
    // exempt from the far-out auto-park leg entirely, so its realized value survives any bid-date change.
    // Counting either would overstate the swing the operator is being asked to approve.
    const summary = summarizeCensus(
      "office_dallas",
      [
        row({ deal_value: "1000000", stored_on_hold: true, currently_far_out: false, next_far_out: true }),
        row({ deal_value: "2000000", is_terminal: true, currently_far_out: false, next_far_out: true }),
      ],
      10
    );
    expect(summary.wouldWrite).toBe(2);
    expect(summary.wouldPark).toBe(0);
    expect(summary.netValueDelta).toBe(0);
  });

  it("orders the movers by value, caps them at the limit, and renders horizons as calendar days", () => {
    const summary = summarizeCensus(
      "office_dallas",
      [
        row({ deal_value: "10000", currently_far_out: false, next_far_out: true }),
        row({
          deal_value: "900000",
          currently_far_out: false,
          next_far_out: true,
          current_horizon: new Date("2026-08-20T00:00:00.000Z"),
          next_horizon: new Date("2027-08-20T00:00:00.000Z"),
        }),
        row({ deal_value: "50000", currently_far_out: true, next_far_out: false }),
      ],
      2
    );
    expect(summary.movers.map((m) => m.value)).toEqual([900000, 50000]);
    expect(summary.movers[0]).toMatchObject({
      transition: "park",
      currentHorizon: "2026-08-20",
      nextHorizon: "2027-08-20",
    });
  });
});
