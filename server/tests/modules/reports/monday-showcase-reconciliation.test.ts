import { describe, expect, it } from "vitest";
import {
  assembleMondayShowcase,
  projectionBandKeys,
  type AssembleInput,
  type ProjectionBandCell,
  type RepProjection,
} from "../../../src/modules/reports/monday-showcase-service.js";

// THE cross-variant reconciliation guarantee: "many presentations, ONE source of truth." Every variant
// (exec hero, department scoreboard, throughput funnel, per-rep scorecards/leaderboard/load-lane/ladder)
// renders a slice of the SAME assembled payload, so for one period the figures are identical everywhere.
// This test crafts a consistent set of canonical inputs and asserts no variant-facing field re-derives or
// drifts. It also ties the Won figure to the protected aggregate (191 / $9,778,045.90).

function bands(cells: Array<[ProjectionBandCell["band"], number, number]>): ProjectionBandCell[] {
  return cells.map(([band, count, value]) => ({ band, count, value }));
}

function repProj(n: number, m: number, cells: Array<[ProjectionBandCell["band"], number, number]>): RepProjection {
  return { bands: bands(cells), coverage: { n, m } };
}

// Per-rep Won that sums to the protected office aggregate BY CONSTRUCTION (getCanonicalRepWonSummary
// guarantees this; we mirror it so the test asserts the assembly PRESERVES the identity).
const repWon = [
  { repId: "rep-a", count: 120, value: 6_000_000 },
  { repId: "rep-b", count: 60, value: 3_400_000 },
  { repId: null, count: 11, value: 378_045.9 }, // unassigned bucket retained
];
const OFFICE_WON = { count: 191, value: 9_778_045.9 };

function makeInput(): AssembleInput {
  return {
    period: { from: "2026-05-24", to: "2026-05-30", mode: "completed", label: "May 24–30" },
    won: { ...OFFICE_WON },
    repWon,
    sent: {
      count: 13,
      value: 2_100_000,
      byRep: new Map([
        ["rep-a", { count: 8, value: 1_300_000 }],
        ["rep-b", { count: 5, value: 800_000 }],
      ]),
    },
    estimated: {
      count: 21,
      value: 3_500_000,
      byRep: new Map([
        ["rep-a", { count: 12, value: 2_000_000 }],
        ["rep-b", { count: 9, value: 1_500_000 }],
      ]),
    },
    officeProjection: repProj(15, 319, [
      ["0_30", 6, 900_000],
      ["31_60", 5, 700_000],
      ["61_90", 4, 500_000],
      ["beyond_90", 0, 0],
    ]),
    repProjection: new Map<string | null, RepProjection>([
      ["rep-a", repProj(9, 180, [["0_30", 4, 600_000], ["31_60", 3, 400_000], ["61_90", 2, 250_000], ["beyond_90", 0, 0]])],
      ["rep-b", repProj(6, 120, [["0_30", 2, 300_000], ["31_60", 2, 300_000], ["61_90", 2, 250_000], ["beyond_90", 0, 0]])],
      [null, repProj(0, 19, [["0_30", 0, 0], ["31_60", 0, 0], ["61_90", 0, 0], ["beyond_90", 0, 0]])],
    ]),
    leadStatus: new Map([
      ["rep-a", [{ stageLabel: "Qualified Lead", count: 4 }, { stageLabel: "Sales Validation", count: 2 }]],
    ]),
    weeklyTrend: [
      { weekStart: "2026-05-24", estimating: 21, sent: 13, won: 191, spikeExcluded: false },
    ],
    sparklines: { estimating: [10, 12, 9, 15, 18, 14, 20, 21], sent: [5, 6, 4, 7, 9, 8, 11, 13], won: [3, 4, 5, 2, 6, 4, 7, 191] },
    lastWeek: { estimating: 20, sent: 11, won: 7 },
    repNames: new Map([["rep-a", "Alex Rep"], ["rep-b", "Bailey Rep"]]),
  };
}

describe("Monday showcase cross-variant reconciliation", () => {
  const data = assembleMondayShowcase(makeInput());

  const dept = (key: string) => data.departments.find((d) => d.key === key)!;

  it("WON reconciles across exec hero, department scoreboard, and per-rep rows (and ties to the protected aggregate)", () => {
    expect(data.execHero.won.count).toBe(OFFICE_WON.count);
    expect(data.execHero.won.value.amount).toBe(OFFICE_WON.value);
    // department scoreboard reads the SAME number
    expect(dept("won").count).toBe(OFFICE_WON.count);
    expect(dept("won").value!.amount).toBe(OFFICE_WON.value);
    // per-rep Closed sums to the office aggregate (no drift, unassigned retained)
    const repClosedCount = data.reps.reduce((s, r) => s + r.closed.count, 0);
    const repClosedValue = data.reps.reduce((s, r) => s + r.closed.value.amount, 0);
    expect(repClosedCount).toBe(OFFICE_WON.count);
    expect(repClosedValue).toBeCloseTo(OFFICE_WON.value, 2);
  });

  it("SENT reconciles across exec hero, department, and per-rep sent (count and $)", () => {
    expect(data.execHero.sent.count).toBe(dept("sent").count);
    expect(data.execHero.sent.value.amount).toBe(dept("sent").value!.amount);
    const repSentCount = data.reps.reduce((s, r) => s + r.sentThisWeek.count, 0);
    expect(repSentCount).toBe(dept("sent").count);
    expect(repSentCount).toBe(13);
  });

  it("ESTIMATED reconciles between exec hero and the Estimating department", () => {
    expect(data.execHero.estimated.count).toBe(dept("estimating").count);
    expect(data.execHero.estimated.value.amount).toBe(dept("estimating").value!.amount);
    expect(dept("estimating").count).toBe(21);
  });

  it("PROJECTION N/M reconciles: per-rep coverage sums to the office coverage", () => {
    const sumN = data.reps.reduce((s, r) => s + r.projection.coverage.n, 0);
    const sumM = data.reps.reduce((s, r) => s + r.projection.coverage.m, 0);
    expect(sumN).toBe(data.officeProjection.coverage.n);
    expect(sumM).toBe(data.officeProjection.coverage.m);
    expect(data.officeProjection.coverage).toEqual({ n: 15, m: 319 });
  });

  it("VALUE BASES are kept distinct and labeled (Won awarded-first vs open best-estimate, never summed)", () => {
    expect(data.execHero.won.value.basisLabel).toBe(data.valueBases.won_awarded_first);
    expect(data.execHero.sent.value.basisLabel).toBe(data.valueBases.open_best_estimate);
    expect(data.valueBases.won_awarded_first).not.toBe(data.valueBases.open_best_estimate);
    // the Won row and a Sent row must NOT share a basis label (guards against a summed funnel $)
    expect(dept("won").value!.basisLabel).not.toBe(dept("sent").value!.basisLabel);
  });

  it("COLLECTED is a deferred placeholder, never a zero-filled number", () => {
    expect(dept("collected").deferred).toBe(true);
    expect(dept("collected").count).toBeNull();
    expect(dept("collected").value).toBeNull();
  });

  it("every projection ladder uses the canonical 30/60/90/beyond band set", () => {
    for (const rep of data.reps) {
      expect(rep.projection.bands.map((b) => b.band)).toEqual(projectionBandKeys());
    }
    expect(data.officeProjection.bands.map((b) => b.band)).toEqual(projectionBandKeys());
  });

  it("reps are ranked by Closed value (leaderboard order) with the unassigned bucket retained", () => {
    expect(data.reps.map((r) => r.repId)).toEqual(["rep-a", "rep-b", null]);
    expect(data.reps.find((r) => r.repId === null)?.repName).toBe("Unassigned");
  });
});
