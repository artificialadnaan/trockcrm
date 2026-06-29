// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VariantExecHero } from "./variants";
import { DrillProvider } from "./drill";
import { periodWord, shouldShowWowDelta, type WeekMode } from "../week-mode";
import type { MondayShowcaseData, DepartmentMetric } from "./types";

// CodeRabbit downstream FIX 2 (labels) + FIX 3 (WoW delta chips), now asserted on the consolidated Hybrid
// (VariantExecHero — the survivor of A1/A2/Hero; the old A2 scoreboard these tests targeted was removed in
// the 8→5 consolidation). The Monday Showcase toggle offers MTD/YTD, but the heading/drill copy rendered
// every non-to_date mode as "last week", and the department WoW DeltaChips computed a meaningless baseline
// (7 days before the period start) for month/year windows. FIX 2 routes every period word through
// periodWord(mode); FIX 3 hides the chips when the baseline is not week-over-week (mtd/ytd) via the shared
// shouldShowWowDelta(mode) guard.

const dept = (key: DepartmentMetric["key"], delta: number | null): DepartmentMetric => ({
  key,
  label: key === "estimating" ? "Estimating" : key === "sent" ? "Sent" : key === "won" ? "Won" : "Collected",
  count: key === "collected" ? null : 5,
  value: key === "collected" ? null : { amount: 1000, basisLabel: "x" },
  deltaCountWoW: delta,
  sparkline: key === "collected" ? [] : [1, 2, 3],
  deferred: key === "collected",
});

const dataFor = (mode: WeekMode): MondayShowcaseData => ({
  period: { from: "2026-06-01", to: "2026-06-16", mode, label: "2026-06-01 → 2026-06-16" },
  departments: [dept("estimating", 3), dept("sent", -2), dept("won", 1), dept("collected", null)],
  execHero: {
    won: { count: 12, value: { amount: 3_900_000, basisLabel: "Awarded-first won value" } },
    sent: { count: 13, value: { amount: 100, basisLabel: "Best current estimate" } },
    estimated: { count: 5, value: { amount: 50, basisLabel: "Best current estimate" } },
  },
  reps: [],
  officeProjection: { bands: [], coverage: { n: 0, m: 0, undatedValue: 0 }, coverageCaption: "" },
  weeklyTrend: [],
  valueBases: { won_awarded_first: "Awarded-first won value", open_best_estimate: "Best current estimate" },
  notes: [],
});

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

function renderWithDrill(node: React.ReactNode) {
  act(() => {
    root.render(<DrillProvider open={() => {}}>{node}</DrillProvider>);
  });
}

describe("period labels (FIX 2) — every mode gets explicit wording", () => {
  it("periodWord maps each mode", () => {
    expect(periodWord("to_date")).toBe("this week");
    expect(periodWord("completed")).toBe("last week");
    expect(periodWord("mtd")).toBe("Month to date");
    expect(periodWord("ytd")).toBe("Year to date");
  });

  it("MTD heading says 'Month to date', not 'last week'", () => {
    renderWithDrill(<VariantExecHero data={dataFor("mtd")} />);
    expect(container.textContent).toContain("Month to date");
    expect(container.textContent).not.toContain("last week");
  });

  it("YTD heading says 'Year to date'", () => {
    renderWithDrill(<VariantExecHero data={dataFor("ytd")} />);
    expect(container.textContent).toContain("Year to date");
    expect(container.textContent).not.toContain("last week");
  });

  it("completed still says 'last week'; to_date still says 'this week'", () => {
    renderWithDrill(<VariantExecHero data={dataFor("completed")} />);
    expect(container.textContent).toContain("last week");
    act(() => root.unmount());
    container.remove();
    root = createRoot((container = document.createElement("div")));
    document.body.appendChild(container);
    renderWithDrill(<VariantExecHero data={dataFor("to_date")} />);
    expect(container.textContent).toContain("this week");
  });
});

// Count of rendered DeltaChips. Each DeltaChip ends with its " WoW" suffix (see evidence-kit DeltaChip),
// so counting "WoW" occurrences counts chips. DeltaChip already returns null for a null delta (so the
// deferred Collected department contributes no chip even in a weekly mode); the showWow guard additionally
// hides ALL chips in mtd/ytd.
const chipCount = () => (container.textContent?.match(/WoW/g) ?? []).length;

describe("WoW delta chips (FIX 3) — hidden for MTD/YTD on the Hybrid (VariantExecHero)", () => {
  it("shouldShowWowDelta is true only for the weekly modes", () => {
    expect(shouldShowWowDelta("to_date")).toBe(true);
    expect(shouldShowWowDelta("completed")).toBe(true);
    expect(shouldShowWowDelta("mtd")).toBe(false);
    expect(shouldShowWowDelta("ytd")).toBe(false);
  });

  it("weekly modes render exactly 3 chips (the 3 non-deferred depts); Collected (null delta) renders none", () => {
    renderWithDrill(<VariantExecHero data={dataFor("completed")} />);
    expect(chipCount()).toBe(3);

    act(() => root.unmount());
    container.remove();
    root = createRoot((container = document.createElement("div")));
    document.body.appendChild(container);
    renderWithDrill(<VariantExecHero data={dataFor("to_date")} />);
    expect(chipCount()).toBe(3);
  });

  it("MTD and YTD render ZERO chips (the showWow guard hides all of them)", () => {
    renderWithDrill(<VariantExecHero data={dataFor("mtd")} />);
    expect(chipCount()).toBe(0);

    act(() => root.unmount());
    container.remove();
    root = createRoot((container = document.createElement("div")));
    document.body.appendChild(container);
    renderWithDrill(<VariantExecHero data={dataFor("ytd")} />);
    expect(chipCount()).toBe(0);
  });
});
