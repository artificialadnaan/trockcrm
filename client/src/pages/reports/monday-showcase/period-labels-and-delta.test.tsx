// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VariantExecHero, VariantA2Scoreboard } from "./variants";
import { DrillProvider } from "./drill";
import { periodWord, shouldShowWowDelta, type WeekMode } from "../week-mode";
import type { MondayShowcaseData, DepartmentMetric } from "./types";

// CodeRabbit downstream FIX 2 (labels) + FIX 3 (WoW delta chips). The Monday Showcase toggle now offers
// MTD/YTD, but the heading/drill copy rendered every non-to_date mode as "last week", and the department
// WoW DeltaChips computed a meaningless baseline (7 days before the period start) for month/year windows.
// FIX 2 routes every period word through periodWord(mode); FIX 3 hides the chips when the baseline is not
// week-over-week (mtd/ytd) via the shared shouldShowWowDelta(mode) guard.

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
  officeProjection: { bands: [], coverage: { n: 0, m: 0 }, coverageCaption: "" },
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
    root = createRoot((container = document.createElement("div")));
    document.body.appendChild(container);
    renderWithDrill(<VariantExecHero data={dataFor("to_date")} />);
    expect(container.textContent).toContain("this week");
  });
});

describe("WoW delta chips (FIX 3) — hidden for MTD/YTD", () => {
  it("shouldShowWowDelta is true only for the weekly modes", () => {
    expect(shouldShowWowDelta("to_date")).toBe(true);
    expect(shouldShowWowDelta("completed")).toBe(true);
    expect(shouldShowWowDelta("mtd")).toBe(false);
    expect(shouldShowWowDelta("ytd")).toBe(false);
  });

  it("renders the WoW chip in a weekly view but not in MTD", () => {
    renderWithDrill(<VariantA2Scoreboard data={dataFor("completed")} />);
    expect(container.textContent).toContain("WoW"); // DeltaChip suffix

    act(() => root.unmount());
    root = createRoot((container = document.createElement("div")));
    document.body.appendChild(container);
    renderWithDrill(<VariantA2Scoreboard data={dataFor("mtd")} />);
    expect(container.textContent).not.toContain("WoW");
  });
});
