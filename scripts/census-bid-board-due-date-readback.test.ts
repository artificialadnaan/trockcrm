import { describe, expect, it } from "vitest";
import {
  buildCensusSql,
  officeSchemaName,
  parseCensusArgs,
  runCensus,
  summarizeCensus,
  type CensusRow,
} from "./census-bid-board-due-date-readback.js";
// The app's OWN builders. Asserting the census EMBEDS these (rather than re-deriving the same strings by
// hand here) is the point: if the platform's hold rule changes, the census changes with it or this fails.
import { closeTargetFarOutSqlPredicate, holdHorizonDateSql } from "@trock-crm/shared/types";
import {
  aliasedDealBestEstimateSqlText,
  aliasedDealEstimatingValueSqlText,
} from "../server/src/modules/shared/deal-value-sql.js";

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
    demo_shaped: false,
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

  // A typo that is silently ignored makes the script census the DEFAULT office and report a confident
  // number for the wrong one — on the artifact that gates a prod flag flip.
  it("REFUSES an unrecognized flag rather than falling back to the default office", () => {
    expect(() => parseCensusArgs(["node", "census", "--offce=atlanta"])).toThrow(/Unrecognized argument/);
    expect(() => parseCensusArgs(["node", "census", "--office=dallas", "--verbose"])).toThrow(
      /Unrecognized argument/
    );
    expect(() => parseCensusArgs(["node", "census", "--limit"])).toThrow(/Unrecognized argument/);
    // A bare positional is a typo too (a forgotten `--office=`), not an office name.
    expect(() => parseCensusArgs(["node", "census", "atlanta"])).toThrow(/Unrecognized argument/);
    // …and the error names what it did not understand, plus what it does support.
    expect(() => parseCensusArgs(["node", "census", "--offce=atlanta"])).toThrow(/--offce=atlanta/);
    expect(() => parseCensusArgs(["node", "census", "--offce=atlanta"])).toThrow(/--office=/);
  });

  it("still accepts every supported flag in combination", () => {
    expect(parseCensusArgs(["node", "census", "--office=dallas,atlanta", "--limit=5", "--json"])).toEqual({
      offices: ["dallas", "atlanta"],
      limit: 5,
      json: true,
    });
    expect(parseCensusArgs(["node", "census", "--all", "--json"])).toMatchObject({ offices: "all" });
  });

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
    // Production value queries exclude test deals; a census quoting the dollar delta that gates a prod
    // flag flip must too, or fixtures inflate the number.
    expect(sql).toContain("COALESCE(d.is_test_data, false) = false");
    expect(sql).toContain("d.is_active = true");
    expect(sql).toContain("COALESCE(d.is_change_order, false) = false");
    expect(sql).toContain("d.bid_board_detached_at IS NULL");
    expect(sql).toContain("d.bid_board_due_date IS NOT NULL");
    // Compared on the DAY, exactly as writeBidDueDateIfNeeded's guard does — an instant comparison would
    // count legacy non-midnight rows the real write-through skips and overstate the blast radius.
    expect(sql).toContain(
      "(current_bid_due_date AT TIME ZONE 'UTC')::date IS DISTINCT FROM next_bid_due_day"
    );
    expect(sql).not.toContain("current_bid_due_date IS DISTINCT FROM next_bid_due_date");
  });

  it("contains no write verb at all", () => {
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
  });

  // Every mover this census reports is by definition a genuine ESTIMATING deal — only that stage reads the
  // bid due date as its horizon — and that stage's board/list value chain puts DD ahead of bid. Quoting the
  // default awarded-first chain for the whole population would understate or overstate the exact dollars
  // being approved. Both chains are asserted as the app's own rendered text, not as a lookalike COALESCE.
  it("values genuine estimating deals with the ESTIMATING chain and everything else with the default", () => {
    expect(sql).toContain(aliasedDealEstimatingValueSqlText("d"));
    expect(sql).toContain(aliasedDealBestEstimateSqlText("d"));
    // The estimating chain must be the one guarded by the estimating-stage test, not the fallback.
    expect(sql).toMatch(
      new RegExp(
        `THEN ${aliasedDealEstimatingValueSqlText("d").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ELSE`
      )
    );
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

  // TR-DEMO-* seed rows land in the REAL tenant schema without is_test_data set, so the column predicate
  // cannot remove them. Excluding them by deal-number shape would make the census disagree with the app it
  // is predicting, so they are COUNTED and reported instead of silently trusted or silently dropped.
  it("counts demo-shaped rows separately without excluding them", () => {
    const summary = summarizeCensus(
      "office_dallas",
      [row({ demo_shaped: true }), row({ demo_shaped: true }), row({ demo_shaped: false })],
      10
    );
    expect(summary.wouldWrite).toBe(3);
    expect(summary.demoShapedRows).toBe(2);
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

/**
 * A census that FAILS must never read as an all-clear. This artifact is the gate on flipping a prod flag
 * that moves reported dollars, and the shape it replaced printed "Across 0 office(s): net delta $0" when
 * every office had errored — a clean-looking "no impact" verdict produced by a broken run.
 */
describe("census-bid-board-due-date-readback — incomplete runs", () => {
  /**
   * A stub client that fails for the named schemas and returns no rows for the rest, and that models the
   * real transaction semantics the SAVEPOINT fix exists for: once an office's query has failed, every
   * later statement errors with "current transaction is aborted" until a ROLLBACK TO SAVEPOINT clears it.
   * Without that, the stub would pass whether or not the production code used savepoints at all.
   */
  function client(schemas: string[], failing: string[] = []) {
    const measured: string[] = [];
    let aborted = false;
    const query = async (text: string) => {
      if (text.startsWith("ROLLBACK TO SAVEPOINT")) {
        aborted = false;
        return { rows: [] };
      }
      if (aborted) throw new Error("current transaction is aborted, commands ignored until end of transaction block");
      if (text.startsWith("SAVEPOINT") || text.startsWith("RELEASE SAVEPOINT")) return { rows: [] };
      if (text.includes("pg_namespace")) return { rows: schemas.map((nspname) => ({ nspname })) };
      const failed = failing.find((schema) => text.includes(`${schema}.deals`));
      if (failed) {
        aborted = true;
        throw new Error(`relation "${failed}.deals" does not exist`);
      }
      const ok = schemas.find((schema) => text.includes(`${schema}.deals`));
      if (ok) measured.push(ok);
      return { rows: [] };
    };
    return { query, measured };
  }

  async function runMain(argv: string[], schemas: string[], failing: string[] = []) {
    const logs: string[] = [];
    const errors: string[] = [];
    const stub = client(schemas, failing);
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    try {
      await runCensus(parseCensusArgs(argv), stub as never);
      return { logs, errors, measured: stub.measured, threw: null as Error | null };
    } catch (err) {
      return { logs, errors, measured: stub.measured, threw: err as Error };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  it("THROWS (non-zero exit) when an office fails, and says the run is incomplete", async () => {
    const { errors, threw } = await runMain(
      ["node", "census", "--all"],
      ["office_dallas", "office_atlanta"],
      ["office_atlanta"]
    );
    expect(threw?.message).toMatch(/incomplete/i);
    expect(errors.join("\n")).toContain("INCOMPLETE");
    expect(errors.join("\n")).toContain("office_atlanta");
    expect(errors.join("\n")).toMatch(/Do NOT flip/);
  });

  it("THROWS when no office schema was examined at all, instead of printing a $0 all-clear", async () => {
    const { threw } = await runMain(["node", "census", "--all"], []);
    expect(threw?.message).toMatch(/no office schemas/i);
  });

  it("--json marks the run incomplete and lists the failures rather than emitting a bare array", async () => {
    const { logs, threw } = await runMain(
      ["node", "census", "--all", "--json"],
      ["office_dallas", "office_atlanta"],
      ["office_atlanta"]
    );
    expect(threw).toBeTruthy();
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.complete).toBe(false);
    expect(payload.failures).toHaveLength(1);
    expect(payload.failures[0].schemaName).toBe("office_atlanta");
  });

  // ★ P2. One broken office must not take the run down with it: a single read-only transaction is shared
  // across offices, so without a per-office SAVEPOINT the first failure aborts it and every LATER office
  // fails too — the census would report nothing measurable and name the wrong culprits.
  it("keeps measuring the offices AFTER a failed one, instead of aborting the whole transaction", async () => {
    const { measured, threw, errors } = await runMain(
      ["node", "census", "--all"],
      ["office_atlanta", "office_dallas", "office_houston"],
      ["office_atlanta"]
    );
    // The two healthy offices were still measured, despite failing FIRST in the loop order.
    expect(measured).toEqual(["office_dallas", "office_houston"]);
    // …and the run is still reported incomplete, naming only the office that actually broke.
    expect(threw?.message).toContain("1 of 3");
    expect(errors.join("\n")).toContain("office_atlanta");
    expect(errors.join("\n")).not.toContain("office_houston");
  });

  it("a fully successful run does NOT throw and reports itself complete", async () => {
    const { threw, logs } = await runMain(["node", "census", "--all", "--json"], ["office_dallas"]);
    expect(threw).toBeNull();
    expect(JSON.parse(logs.join("\n")).complete).toBe(true);
  });
});
