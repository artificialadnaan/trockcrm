import { describe, expect, it } from "vitest";
import {
  assembleMondayShowcase,
  foldOfficeProjection,
  num,
  projectionBandKeys,
  type AssembleInput,
  type ProjectionBandCell,
  type RepProjection,
} from "../../../src/modules/reports/monday-showcase-service.js";
import { type ProjectionBand } from "../../../src/modules/reports/foundations.js";

/**
 * Load-bearing guard for the B4 · Forecast Ladder OFFICE COLUMN TOTALS.
 *
 * The Forecast Ladder renders `data.officeProjection.bands` as a per-window totals row beneath the
 * per-rep rows. The showcase's promise is "many presentations, ONE source of truth" — so each window's
 * column total MUST equal the sum of every rep row's figure in that window ($ and dated count).
 *
 * That holds BY CONSTRUCTION: `data.reps` is union-seeded from the same per-rep projection map that
 * `officeProjection = Σ per-rep` is folded from (monday-showcase-service.ts), so no rep contributing to
 * the office total can be missing from the rows. This test pins that invariant against an independent
 * hardcoded oracle, and pins the null/non-numeric → 0 coalescing (`num`) that keeps a missing value from
 * NaN-ing a total. (The real-SQL fold of the per-rep bands is covered by the evidence reconciliation
 * runtime test; the SQL itself COALESCE(SUM(...),0)'s each band before `num` ever sees it.)
 */

function bands(cells: Array<[ProjectionBand, number, number]>): ProjectionBandCell[] {
  return cells.map(([band, count, value]) => ({ band, count, value }));
}
function repProj(
  n: number,
  m: number,
  cells: Array<[ProjectionBand, number, number]>,
  undatedValue = 0,
): RepProjection {
  return { bands: bands(cells), coverage: { n, m, undatedValue } };
}

// Per-rep ladders, including a wins-less rep (rep-c, seeded ONLY via projection) and the Unassigned
// (null) bucket — both must still land in the rows and the totals.
const REP_PROJECTION = new Map<string | null, RepProjection>([
  ["rep-a", repProj(9, 180, [["0_30", 4, 600_000], ["31_60", 3, 400_000], ["61_90", 2, 250_000], ["beyond_90", 0, 0]])],
  ["rep-b", repProj(6, 120, [["0_30", 2, 300_000], ["31_60", 2, 300_000], ["61_90", 2, 250_000], ["beyond_90", 0, 0]])],
  ["rep-c", repProj(2, 40, [["0_30", 1, 100_000], ["31_60", 0, 0], ["61_90", 0, 0], ["beyond_90", 0, 0]])],
  [null, repProj(0, 19, [["0_30", 0, 0], ["31_60", 0, 0], ["61_90", 0, 0], ["beyond_90", 0, 0]])],
]);

// Independent hand-computed office totals (Σ of the per-rep ladders above). 90d+ is empty for EVERY rep
// → it must total $0 / 0 dated, never NaN/blank.
const EXPECTED: Record<ProjectionBand, { count: number; value: number }> = {
  "0_30": { count: 7, value: 1_000_000 }, // 4+2+1 , 600k+300k+100k
  "31_60": { count: 5, value: 700_000 }, // 3+2+0 , 400k+300k+0
  "61_90": { count: 4, value: 500_000 }, // 2+2+0 , 250k+250k+0
  beyond_90: { count: 0, value: 0 }, // empty bucket
};

function makeInput(): AssembleInput {
  return {
    period: { from: "2026-05-24", to: "2026-05-30", mode: "completed", label: "May 24–30" },
    won: { count: 0, value: 0 },
    repWon: [{ repId: "rep-a", count: 5, value: 400_000 }], // rep-c has NO wins on purpose
    sent: { count: 0, value: 0, byRep: new Map() },
    estimated: { count: 0, value: 0, byRep: new Map() },
    // Compute the office input via the REAL rollup fold (not a hand-stubbed ladder), so the test pins
    // the actual getMondayShowcaseData fold path, not just the assembly passthrough.
    officeProjection: foldOfficeProjection(REP_PROJECTION),
    repProjection: REP_PROJECTION,
    leadStatus: new Map(),
    weeklyTrend: [],
    sparklines: { estimating: [], sent: [], won: [] },
    lastWeek: { estimating: 0, sent: 0, won: 0 },
    repNames: new Map([["rep-a", "Alex"], ["rep-b", "Bailey"], ["rep-c", "Casey"]]),
  };
}

const cellOf = (ladder: { bands: ProjectionBandCell[] }, band: ProjectionBand) =>
  ladder.bands.find((b) => b.band === band)!;

describe("B4 Forecast Ladder — office column totals reconcile with the per-rep rows", () => {
  const data = assembleMondayShowcase(makeInput());

  it("each window's office total $ and dated count equals the sum across ALL rep rows", () => {
    for (const band of projectionBandKeys()) {
      const sumValue = data.reps.reduce((s, r) => s + cellOf(r.projection, band).value, 0);
      const sumCount = data.reps.reduce((s, r) => s + cellOf(r.projection, band).count, 0);

      // column total == Σ of the displayed rep rows (no drift) ...
      expect(cellOf(data.officeProjection, band).value).toBe(sumValue);
      expect(cellOf(data.officeProjection, band).count).toBe(sumCount);
      // ... and both match the independent hand-computed oracle.
      expect(cellOf(data.officeProjection, band).value).toBe(EXPECTED[band].value);
      expect(cellOf(data.officeProjection, band).count).toBe(EXPECTED[band].count);
      // never NaN/Infinity.
      expect(Number.isFinite(cellOf(data.officeProjection, band).value)).toBe(true);
      expect(Number.isFinite(cellOf(data.officeProjection, band).count)).toBe(true);
    }
  });

  it("foldOfficeProjection rolls the per-rep ladders up to the office total (the rollup the totals row renders)", () => {
    const office = foldOfficeProjection(REP_PROJECTION);
    for (const band of projectionBandKeys()) {
      expect(cellOf(office, band).value).toBe(EXPECTED[band].value);
      expect(cellOf(office, band).count).toBe(EXPECTED[band].count);
    }
    expect(office.coverage).toEqual({ n: 17, m: 359, undatedValue: 0 }); // Σ per-rep coverage (9+6+2+0 , 180+120+40+19)
  });

  it("an empty window totals $0 / 0 dated (not NaN/blank)", () => {
    expect(cellOf(data.officeProjection, "beyond_90").value).toBe(0);
    expect(cellOf(data.officeProjection, "beyond_90").count).toBe(0);
  });

  it("includes wins-less and Unassigned reps in the rows so the totals capture every contributor", () => {
    expect(data.reps.some((r) => r.repId === "rep-c")).toBe(true); // projection-only, no wins
    expect(data.reps.some((r) => r.repId === null)).toBe(true); // Unassigned bucket retained
    // the grand projected $ the totals header shows = Σ of the four window totals = Σ over every rep.
    const grand = data.officeProjection.bands.reduce((s, b) => s + b.value, 0);
    const grandFromRows = data.reps.reduce(
      (s, r) => s + r.projection.bands.reduce((rs, b) => rs + b.value, 0),
      0,
    );
    expect(grand).toBe(grandFromRows);
    expect(grand).toBe(2_200_000); // 1,000,000 + 700,000 + 500,000 + 0
  });
});

describe("num() coalesces null / non-numeric per-rep values to 0 (no NaN in a total)", () => {
  it("maps nullish / non-numeric / non-finite inputs to 0", () => {
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num(Number.NaN)).toBe(0);
    expect(num("not-a-number")).toBe(0);
    expect(num(Infinity)).toBe(0);
    expect(num(-Infinity)).toBe(0);
    expect(num("")).toBe(0);
  });

  it("preserves real numeric values (incl. numeric strings from pg numeric columns)", () => {
    expect(num(1234.56)).toBe(1234.56);
    expect(num("1000.00")).toBe(1000);
    expect(num(0)).toBe(0);
    expect(num(-250.5)).toBe(-250.5);
  });
});
