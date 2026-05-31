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
  it("omits when unset or invalid", () => {
    expect(buildWorkflowRoutePredicate({})).toBeUndefined();
    expect(buildWorkflowRoutePredicate({ workflowRoute: "bogus" as never })).toBeUndefined();
  });
  it("equals normal / service directly (no mapping)", () => {
    expect(text(buildWorkflowRoutePredicate({ workflowRoute: "service" }))).toContain("workflow_route");
    expect(text(buildWorkflowRoutePredicate({ workflowRoute: "normal" }))).toContain("workflow_route");
  });
});

describe("status predicate (active / on_hold / inactive / any)", () => {
  it("Active => is_active true AND on_hold false", () => {
    const sql = text(buildStatusPredicate({ status: "active" }));
    expect(sql).toContain("is_active");
    expect(sql).toContain("on_hold");
  });
  it("On-Hold => on_hold true (does not force is_active)", () => {
    const sql = text(buildStatusPredicate({ status: "on_hold" }));
    expect(sql).toContain("on_hold");
    expect(sql).not.toContain("is_active");
  });
  it("Inactive => is_active false", () => {
    expect(text(buildStatusPredicate({ status: "inactive" }))).toContain("is_active");
  });
  it("Any / unset => omitted", () => {
    expect(buildStatusPredicate({ status: "any" })).toBeUndefined();
    expect(buildStatusPredicate({})).toBeUndefined();
  });
});

describe("value-range predicate (effective value chain == the sort chain)", () => {
  it("omits when neither bound is a finite number", () => {
    expect(buildValueRangePredicate({})).toBeUndefined();
    expect(buildValueRangePredicate({ valueMin: NaN, valueMax: NaN })).toBeUndefined();
  });
  it("BETWEEN both bounds, on the on-hold-zeroed best-estimate chain", () => {
    const sql = text(buildValueRangePredicate({ valueMin: 100000, valueMax: 500000 }));
    expect(sql).toContain("between");
    expect(sql).toContain("on_hold");
    expect(sql).toContain("bid_estimate");
  });
  it(">= when only a minimum, <= when only a maximum", () => {
    expect(text(buildValueRangePredicate({ valueMin: 100000 }))).toContain(">=");
    expect(text(buildValueRangePredicate({ valueMax: 500000 }))).toContain("<=");
  });
});

describe("stalled / days-in-stage predicate (gated on stage-entry reliability)", () => {
  it("is OMITTED entirely when the stage-entry flag is OFF (no false stalls off import dates)", () => {
    expect(buildStalledPredicate({ minAgeDays: 30 }, { stageEntryDateEnabled: false })).toBeUndefined();
  });
  it("filters on age from stage_entered_at when the flag is ON", () => {
    const sql = text(buildStalledPredicate({ minAgeDays: 30 }, { stageEntryDateEnabled: true }));
    expect(sql).toContain("stage_entered_at");
    expect(sql).toContain(">=");
  });
  it("omits when no bucket is selected even with the flag on", () => {
    expect(buildStalledPredicate({}, { stageEntryDateEnabled: true })).toBeUndefined();
  });
});

describe("outcome-aware date predicate (delegates to the shared model)", () => {
  const dateCtx = { wonStageIds: ["won-1"], lostStageIds: ["lost-1"] };

  it("omits when no date bounds are given", () => {
    expect(buildOutcomeAwareDatePredicate({}, dateCtx)).toBeUndefined();
  });
  it("windows Won rows on the won date and Lost rows on the lost date", () => {
    const sql = text(buildOutcomeAwareDatePredicate({ dateFrom: "2026-01-01", dateTo: "2026-03-31" }, { ...dateCtx, stageEntryDateEnabled: false }));
    expect(sql).toContain("contract_signed");
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
