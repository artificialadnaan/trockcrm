// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VariantB4ForecastLadder } from "./variants";
import { DrillProvider } from "./drill";
import type { MondayShowcaseData, EvidenceRequest, ProjectionBandCell } from "./types";

// Office ladder = the per-rep ladders summed (server officeProjection). 0–30d $ total (9999) is
// globally unique so it can only come from the totals row, not any rep cell.
function band(b: ProjectionBandCell["band"], count: number, value: number): ProjectionBandCell {
  return { band: b, count, value };
}
const fixture: MondayShowcaseData = {
  period: { from: "2026-05-24", to: "2026-05-30", mode: "completed", label: "May 24–30" },
  departments: [],
  execHero: {
    won: { count: 5, value: { amount: 700_000, basisLabel: "Awarded-first won value" } },
    sent: { count: 4, value: { amount: 100, basisLabel: "Best current estimate" } },
    estimated: { count: 3, value: { amount: 50, basisLabel: "Best current estimate" } },
  },
  reps: [
    {
      repId: "rep-1",
      repName: "Alice",
      closed: { count: 3, value: { amount: 400_000, basisLabel: "Awarded-first won value" } },
      projection: {
        bands: [band("0_30", 1, 4000), band("31_60", 2, 2000), band("61_90", 0, 0), band("beyond_90", 0, 0)],
        coverage: { n: 3, m: 5 },
        coverageCaption: "3 of 5 open deals have a maintained (future-dated) expected close date.",
      },
      sentThisWeek: { count: 2, value: { amount: 2000, basisLabel: "Best current estimate" } },
      leadStatus: [],
    },
    {
      repId: "rep-2",
      repName: "Bailey",
      closed: { count: 2, value: { amount: 300_000, basisLabel: "Awarded-first won value" } },
      projection: {
        bands: [band("0_30", 1, 5999), band("31_60", 1, 500), band("61_90", 1, 3000), band("beyond_90", 0, 0)],
        coverage: { n: 3, m: 4 },
        coverageCaption: "3 of 4 open deals have a maintained (future-dated) expected close date.",
      },
      sentThisWeek: { count: 2, value: { amount: 1500, basisLabel: "Best current estimate" } },
      leadStatus: [],
    },
  ],
  // Σ of the two rep ladders, band by band (what the server emits as officeProjection):
  officeProjection: {
    bands: [band("0_30", 2, 9999), band("31_60", 3, 2500), band("61_90", 1, 3000), band("beyond_90", 0, 0)],
    coverage: { n: 6, m: 9 },
    coverageCaption: "6 of 9 open deals have a maintained (future-dated) expected close date.",
  },
  weeklyTrend: [],
  valueBases: { won_awarded_first: "Awarded-first won value", open_best_estimate: "Best current estimate" },
  notes: [],
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  const open = vi.fn<(r: EvidenceRequest) => void>();
  act(() => {
    root.render(
      <DrillProvider open={open}>
        <VariantB4ForecastLadder data={fixture} />
      </DrillProvider>
    );
  });
  return open;
}

function clickButtonContaining(text: string) {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`no button containing "${text}"`);
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("B4 Forecast Ladder — office column totals row", () => {
  it("renders a distinct office totals row summing each window's $ across all reps", () => {
    render();
    const text = container.textContent ?? "";
    // 0–30d office $ total (9999 = 4000 + 5999) only exists in the totals row.
    expect(text).toContain("$9,999");
    // 31–60d office $ total (2500 = 2000 + 500).
    expect(text).toContain("$2,500");
    // a label distinguishes the totals row from the per-rep rows.
    expect(text.toLowerCase()).toContain("all reps");
  });

  it("shows the dated count per window in the totals row and $0 / 0 for an empty bucket (never NaN)", () => {
    render();
    const text = container.textContent ?? "";
    expect(text).toContain("3 dated"); // 31–60d office count (2 + 1), unique among the rows
    // 90d+ bucket is empty office-wide -> $0 / 0 dated, not blank/NaN
    expect(text).toContain("$0");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("$NaN");
  });

  it("totals cells drill into OFFICE projection evidence (no repId) for their window", () => {
    const open = render();
    clickButtonContaining("$9,999"); // the 0–30d office total cell
    expect(open).toHaveBeenCalledTimes(1);
    const req = open.mock.calls[0][0];
    expect(req.metric).toBe("projection");
    expect(req.band).toBe("0_30");
    expect(req.repId).toBeUndefined(); // office-wide, not a single rep
  });
});
