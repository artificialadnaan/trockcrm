import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ pool: { connect: vi.fn() } }));

import { computeRepAtRiskCountsFromRows } from "../../src/jobs/rep-performance-rollup.js";

/**
 * Codex P2 (finding A): the worker at-risk jobs now forward `expected_close_date` into the shared
 * getDealAtRiskResult engine, so a far-out (90+ day) close target auto-parks a deal (effective on hold) and
 * the worker stops flagging deals the dashboard/API already cleared. Runs in tests/** (the executed worker
 * suite) — the co-located src/jobs unit test is typecheck-only.
 */
const dayMs = 24 * 60 * 60 * 1000;

function row(overrides: Partial<Parameters<typeof computeRepAtRiskCountsFromRows>[0][number]> = {}) {
  return {
    rep_id: "rep-1",
    stage_slug: "estimating",
    workflow_route: "normal",
    stage_entered_at: "2026-04-23T00:00:00.000Z",
    expected_close_date: null,
    on_hold: false,
    on_hold_started_at: null,
    on_hold_accumulated_seconds: 0,
    on_hold_accumulated_seconds_at_stage_entry: 0,
    ...overrides,
  };
}

describe("worker at-risk forwards expected_close_date (Codex P2 finding A)", () => {
  it("excludes a deal auto-parked by a far-out (90+ day) close target, counts the equal-age non-parked one", () => {
    const asOf = new Date("2026-05-08T00:00:00.000Z");
    const counts = computeRepAtRiskCountsFromRows(
      [
        row({ stage_entered_at: new Date(asOf.getTime() - 15 * dayMs).toISOString() }),
        row({
          stage_entered_at: new Date(asOf.getTime() - 15 * dayMs).toISOString(),
          expected_close_date: "2099-12-31",
        }),
      ],
      asOf
    );
    expect(counts).toEqual([{ repId: "rep-1", atRiskCount: 1 }]);
  });

  it("a near (today-or-future) close target suppresses in the aggregate rollup (matches the deals list/dashboard/detail)", () => {
    const asOf = new Date("2026-05-08T00:00:00.000Z");
    const counts = computeRepAtRiskCountsFromRows(
      [
        row({
          stage_entered_at: new Date(asOf.getTime() - 15 * dayMs).toISOString(),
          expected_close_date: new Date(asOf.getTime() + 5 * dayMs).toISOString().slice(0, 10),
        }),
      ],
      asOf
    );
    // A postponement (Move Close Date to a today-or-future target) quiets the stage-age SLA everywhere a
    // user sees at-risk — the rollup now honors applyCloseTargetSuppression:true like the list/dashboard/
    // detail, so an over-SLA deal postponed to next week drops out of the rep's at-risk count (returns [],
    // no rep entry, since the rep has zero at-risk deals).
    expect(counts).toEqual([]);
  });
});
