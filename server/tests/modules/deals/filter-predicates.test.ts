import { describe, expect, it } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * No-DB SQL-assertion tests for the deal FilterBar predicate registry.
 *
 * Each filter dimension is a pure predicate (input, ctx) => SQL | undefined,
 * combinable via AND. The contract:
 *  - unset/empty filter => undefined (omitted, never a broken/empty-IN SQL);
 *  - sparse FK dimensions (rep, region) support an "Unassigned" sentinel => IS NULL;
 *  - value range + value sort use the SAME effective-value chain (sort == filter);
 *  - days-in-stage (stalled) is GATED behind stage-entry reliability (ctx flag);
 *  - the date dimension delegates to the shared canonical date model.
 * See .audit/shared-filterbar-design.md (§4 registry, §5 date tiers).
 */

const dialect = new PgDialect();
const text = (value: SQL | undefined) => (value ? dialect.sqlToQuery(value).sql.toLowerCase() : "");

import {
  UNASSIGNED_FILTER_SENTINEL,
  buildAssignedRepPredicate,
  buildRegionPredicate,
  buildProjectTypePredicate,
  buildWorkflowRoutePredicate,
  buildStatusPredicate,
  buildValueRangePredicate,
  buildStalledPredicate,
  buildOutcomeAwareDatePredicate,
  buildDealFilterBarConditions,
} from "../../../src/modules/deals/deal-filter-predicates.js";

describe("assigned-rep predicate", () => {
  it("omits when unset", () => {
    expect(buildAssignedRepPredicate({})).toBeUndefined();
  });
  it("equals a concrete rep id", () => {
    expect(text(buildAssignedRepPredicate({ assignedRepId: "rep-1" }))).toContain("assigned_rep_id");
  });
  it("maps the Unassigned sentinel to IS NULL (never eq sentinel)", () => {
    const sql = text(buildAssignedRepPredicate({ assignedRepId: UNASSIGNED_FILTER_SENTINEL }));
    expect(sql).toContain("assigned_rep_id");
    expect(sql).toContain("is null");
    expect(sql).not.toContain(UNASSIGNED_FILTER_SENTINEL);
  });
});

describe("region predicate", () => {
  it("omits when unset", () => {
    expect(buildRegionPredicate({})).toBeUndefined();
  });
  it("equals a concrete region id", () => {
    expect(text(buildRegionPredicate({ regionId: "region-1" }))).toContain("region_id");
  });
  it("maps the Unassigned sentinel to IS NULL", () => {
    const sql = text(buildRegionPredicate({ regionId: UNASSIGNED_FILTER_SENTINEL }));
    expect(sql).toContain("region_id");
    expect(sql).toContain("is null");
  });
});

describe("project-type predicate", () => {
  it("omits when unset and equals when set", () => {
    expect(buildProjectTypePredicate({})).toBeUndefined();
    expect(text(buildProjectTypePredicate({ projectTypeId: "pt-1" }))).toContain("project_type_id");
  });
});

describe("workflow-route predicate", () => {
  it("omits when unset / all (per the contract: absent => omit)", () => {
    expect(buildWorkflowRoutePredicate({})).toBeUndefined();
    expect(buildWorkflowRoutePredicate({ workflowRoute: "" })).toBeUndefined();
    expect(buildWorkflowRoutePredicate({ workflowRoute: "all" })).toBeUndefined();
  });
  it("equals normal / service directly (no mapping)", () => {
    expect(text(buildWorkflowRoutePredicate({ workflowRoute: "service" }))).toContain("workflow_route");
    expect(text(buildWorkflowRoutePredicate({ workflowRoute: "normal" }))).toContain("workflow_route");
  });
  it("maps an unrecognized value to a no-match sentinel (sql false), never omit", () => {
    expect(text(buildWorkflowRoutePredicate({ workflowRoute: "bogus" }))).toBe("false");
  });
});

describe("status predicate (active / on_hold / inactive / any)", () => {
  it("Active => is_active true AND on_hold false", () => {
    const sql = text(buildStatusPredicate({ status: "active" }));
    expect(sql).toContain("is_active");
    expect(sql).toContain("on_hold");
  });
  it("On-Hold => on_hold true AND is_active true (a current-deals view; excludes soft-deleted)", () => {
    // On-Hold is a subset of active deals (active but paused), so it must also
    // require is_active=true — else a soft-deleted deal left on_hold reappears
    // (deleteDeal sets is_active false but leaves on_hold). Codex #546.
    const sql = text(buildStatusPredicate({ status: "on_hold" }));
    expect(sql).toContain("on_hold");
    expect(sql).toContain("is_active");
  });
  it("Inactive => is_active false", () => {
    expect(text(buildStatusPredicate({ status: "inactive" }))).toContain("is_active");
  });
  it("Any / unset => omitted", () => {
    expect(buildStatusPredicate({ status: "any" })).toBeUndefined();
    expect(buildStatusPredicate({ status: "" })).toBeUndefined();
    expect(buildStatusPredicate({})).toBeUndefined();
  });
  it("maps an unrecognized status to a no-match sentinel (sql false), never omit", () => {
    expect(text(buildStatusPredicate({ status: "bogus" }))).toBe("false");
  });
});

describe("value-range predicate (stage-aware effective value == sort == display)", () => {
  const openCtx = {}; // no won stage ids -> open best-estimate chain
  const wonCtx = { wonStageIds: ["won-1"] };

  it("omits when no bound is supplied at all (unset filter)", () => {
    expect(buildValueRangePredicate({}, openCtx)).toBeUndefined();
  });
  it("no-matches (sql false) a malformed numeric bound rather than omitting/widening (Codex #546)", () => {
    // NaN is what the route forwards for ?valueMin=abc — a bad URL, not an unset
    // filter, so it must no-match like a bad enum, never silently widen.
    expect(text(buildValueRangePredicate({ valueMin: NaN, valueMax: NaN }, openCtx))).toBe("false");
    expect(text(buildValueRangePredicate({ valueMin: NaN }, openCtx))).toBe("false");
    expect(text(buildValueRangePredicate({ valueMin: 100000, valueMax: NaN }, openCtx))).toBe("false");
  });
  it("does not throw when called without a ctx (ctx is optional with a safe default — Codex #546)", () => {
    expect(() => buildValueRangePredicate({ valueMin: 100000 })).not.toThrow();
    expect(text(buildValueRangePredicate({ valueMin: 100000 }))).toContain("bid_estimate"); // open chain
  });
  it("BETWEEN both bounds, on the on-hold-zeroed best-estimate chain (no won classification)", () => {
    const sql = text(buildValueRangePredicate({ valueMin: 100000, valueMax: 500000 }, openCtx));
    expect(sql).toContain("between");
    expect(sql).toContain("on_hold");
    expect(sql).toContain("bid_estimate");
    // The open best-estimate chain has its own per-candidate CASE WHENs, so the
    // marker of NO stage-aware switch is the absence of stage classification.
    expect(sql).not.toContain("stage_id"); // no won-vs-open stage CASE
  });
  it(">= when only a minimum, <= when only a maximum", () => {
    expect(text(buildValueRangePredicate({ valueMin: 100000 }, openCtx))).toContain(">=");
    expect(text(buildValueRangePredicate({ valueMax: 500000 }, openCtx))).toContain("<=");
  });
  it("emits a stage-aware CASE (awarded-first for Won stage ids) when wonStageIds are provided", () => {
    const sql = text(buildValueRangePredicate({ valueMin: 750000 }, wonCtx));
    expect(sql).toContain("case when");
    expect(sql).toContain("stage_id in"); // classifies by stage id, no join
    expect(sql).toContain("awarded_amount");
    expect(sql).toContain("bid_estimate"); // open branch still present
  });
});

describe("stalled / days-in-stage predicate (gated on stage-entry reliability)", () => {
  it("is OMITTED entirely when the stage-entry flag is OFF (no false stalls off import dates)", () => {
    expect(buildStalledPredicate({ minAgeDays: 30 }, { stageEntryDateEnabled: false })).toBeUndefined();
  });
  it("filters on the HOLD-AWARE effective stage age when the flag is ON (matches the displayed days)", () => {
    const sql = text(buildStalledPredicate({ minAgeDays: 30 }, { stageEntryDateEnabled: true }));
    expect(sql).toContain("stage_entered_at");
    expect(sql).toContain("bid_board_stage_entered_at"); // effective entry uses bid board...
    expect(sql).toContain("is_bid_board_owned"); // ...but ONLY for Bid Board-owned deals
    expect(sql).toContain("on_hold_accumulated_seconds"); // subtracts completed hold time
    expect(sql).toContain("on_hold_started_at"); // subtracts the open hold interval
    // ...anchored at GREATEST(effective stage entry, hold start) so a hold that
    // began before this stage only subtracts the overlapping portion (Codex #546).
    expect(sql).toContain("now() - greatest(");
    expect(sql).toContain(">=");
  });
  it("omits when no bucket is selected even with the flag on", () => {
    expect(buildStalledPredicate({}, { stageEntryDateEnabled: true })).toBeUndefined();
  });
  it("no-matches (sql false) a malformed age bound when the flag is on (Codex #546)", () => {
    expect(text(buildStalledPredicate({ minAgeDays: NaN }, { stageEntryDateEnabled: true }))).toBe("false");
    expect(text(buildStalledPredicate({ maxAgeDays: NaN }, { stageEntryDateEnabled: true }))).toBe("false");
  });
  it("still OMITS (not no-match) a malformed age bound when the flag is OFF — the dimension does not exist", () => {
    expect(buildStalledPredicate({ minAgeDays: NaN }, { stageEntryDateEnabled: false })).toBeUndefined();
  });
  it("no-matches (sql false) a malformed age bound when the flag is on (Codex #546)", () => {
    expect(text(buildStalledPredicate({ minAgeDays: NaN }, { stageEntryDateEnabled: true }))).toBe("false");
    expect(text(buildStalledPredicate({ maxAgeDays: NaN }, { stageEntryDateEnabled: true }))).toBe("false");
  });
  it("still OMITS (not no-match) a malformed age bound when the flag is OFF — the dimension does not exist", () => {
    expect(buildStalledPredicate({ minAgeDays: NaN }, { stageEntryDateEnabled: false })).toBeUndefined();
  });
});

describe("outcome-aware date predicate (delegates to the shared model)", () => {
  const dateCtx = { wonStageIds: ["won-1"], lostStageIds: ["lost-1"] };

  it("omits when no date bounds are given", () => {
    expect(buildOutcomeAwareDatePredicate({}, dateCtx)).toBeUndefined();
  });
  it("windows Won rows on the won date and Lost rows on the lost date", () => {
    const sql = text(buildOutcomeAwareDatePredicate({ dateFrom: "2026-01-01", dateTo: "2026-03-31" }, { ...dateCtx, stageEntryDateEnabled: false }));
    expect(sql).toContain("won_closed_date");
    expect(sql).toContain("lost_at");
    expect(sql).toContain("stage_id");
  });
  it("does NOT bound open rows by stage-entry when the flag is OFF", () => {
    const sql = text(buildOutcomeAwareDatePredicate({ dateFrom: "2026-01-01" }, { ...dateCtx, stageEntryDateEnabled: false }));
    expect(sql).not.toContain("stage_entered_at");
  });
  it("DOES bound open rows by stage-entry when the flag is ON", () => {
    const sql = text(buildOutcomeAwareDatePredicate({ dateFrom: "2026-01-01" }, { ...dateCtx, stageEntryDateEnabled: true }));
    expect(sql).toContain("stage_entered_at");
  });
});

describe("registry driver buildDealFilterBarConditions", () => {
  it("returns NOTHING for an empty filter set (graceful: no narrowing)", () => {
    expect(buildDealFilterBarConditions({}, {})).toEqual([]);
  });

  it("collects one condition per active dimension, AND-combinable", () => {
    const conditions = buildDealFilterBarConditions(
      {
        assignedRepId: "rep-1",
        regionId: UNASSIGNED_FILTER_SENTINEL,
        workflowRoute: "service",
        status: "active",
        valueMin: 100000,
        dateFrom: "2026-01-01",
      },
      { wonStageIds: ["won-1"], lostStageIds: ["lost-1"], stageEntryDateEnabled: false }
    );
    expect(conditions).toHaveLength(6);
    expect(conditions.every((c) => c !== undefined)).toBe(true);
  });

  it("drops gated stalled predicate from the set when the flag is off", () => {
    const conditions = buildDealFilterBarConditions({ minAgeDays: 30 }, { stageEntryDateEnabled: false });
    expect(conditions).toEqual([]);
  });
});
