// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VariantB2Leaderboard } from "./variants";
import { DrillProvider } from "./drill";
import type { MondayShowcaseData } from "./types";

// Minimal showcase payload — one rep + office aggregates — enough to render the B2 leaderboard table.
const data: MondayShowcaseData = {
  period: { from: "2026-06-08", to: "2026-06-12", mode: "to_date", label: "2026-06-08 → 2026-06-12" },
  departments: [],
  execHero: {
    won: { count: 3, value: { amount: 90000, basisLabel: "Awarded-first won value" } },
    sent: { count: 4, value: { amount: 100, basisLabel: "Best current estimate" } },
    estimated: { count: 2, value: { amount: 50, basisLabel: "Best current estimate" } },
  },
  reps: [
    {
      repId: "rep-1",
      repName: "Alice",
      closed: { count: 2, value: { amount: 5000, basisLabel: "Awarded-first won value" } },
      projection: {
        bands: [
          { band: "0_30", count: 1, value: 1000 },
          { band: "31_60", count: 0, value: 0 },
          { band: "61_90", count: 0, value: 0 },
          { band: "beyond_90", count: 0, value: 0 },
        ],
        coverage: { n: 1, m: 1 },
        coverageCaption: "1 of 1 open deals have a maintained (future-dated) expected close date.",
      },
      sentThisWeek: { count: 3, value: { amount: 2000, basisLabel: "Best current estimate" } },
      leadStatus: [{ stageLabel: "New", count: 4 }],
    },
  ],
  officeProjection: {
    bands: [
      { band: "0_30", count: 1, value: 1000 },
      { band: "31_60", count: 0, value: 0 },
      { band: "61_90", count: 0, value: 0 },
      { band: "beyond_90", count: 0, value: 0 },
    ],
    coverage: { n: 1, m: 1 },
    coverageCaption: "1 of 1 open deals have a maintained (future-dated) expected close date.",
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

describe("showcase wide tables get the top scrollbar", () => {
  it("B2 Leaderboard renders its table inside the synced top scrollbar", () => {
    act(() =>
      root.render(
        <DrillProvider open={() => {}}>
          <VariantB2Leaderboard data={data} />
        </DrillProvider>
      )
    );
    // the leaderboard still renders its data...
    expect(container.textContent).toContain("Alice");
    expect(container.querySelector("table")).not.toBeNull();
    // ...now wrapped so the discoverable top scrollbar rail is present
    expect(container.querySelector('[data-testid="scrollsync-top"]')).not.toBeNull();
  });
});
