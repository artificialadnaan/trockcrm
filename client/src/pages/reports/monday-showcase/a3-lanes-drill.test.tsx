// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VariantA3Lanes } from "./variants";
import { DrillProvider } from "./drill";
import type { WeekMode } from "../week-mode";
import type { MondayShowcaseData, ShowcaseWeek, EvidenceRequest } from "./types";

// CodeRabbit P2 (reconciliation drift): A3 "Momentum Lanes" renders weeklyTrend, whose displayed value is
// the LAST bucket — always ONE Sunday-week, never the page-period total. In weekly modes (to_date/completed)
// the page period EQUALS that last bucket, so A3's mode-scoped drill opens evidence that reconciles to the
// bar. But in MTD/YTD the page period is a whole month/year while the bar is still one week, so:
//   1. periodWord would mislabel the one-week number "Month/Year to date".
//   2. a mode-scoped drill would open month/year evidence that does NOT match the clicked weekly bar
//      (card != drawer — the reconciliation guarantee broken).
// The evidence API can express an explicit {from,to} week, but assertShowcaseEvidenceAccess restricts that
// window to directors and the showcase is rep-accessible, so the fix makes A3's weekly number NON-drillable
// in MTD/YTD (plain text, can never open a mismatched drawer) with weekly wording; weekly modes unchanged.

const week = (weekStart: string, won: number): ShowcaseWeek => ({
  weekStart,
  estimating: won + 1,
  sent: won + 2,
  won,
  spikeExcluded: false,
});

const TREND: ShowcaseWeek[] = [
  week("2026-04-26", 1),
  week("2026-05-03", 2),
  week("2026-05-10", 3),
  week("2026-05-17", 4),
  week("2026-05-24", 5),
  week("2026-05-31", 6),
  week("2026-06-07", 7),
  week("2026-06-14", 9), // last bucket: won=9, sent=11, estimating=10
];

const dataFor = (mode: WeekMode): MondayShowcaseData => ({
  period: { from: "2026-06-01", to: "2026-06-16", mode, label: "2026-06-01 → 2026-06-16" },
  departments: [],
  execHero: {
    won: { count: 9, value: { amount: 1, basisLabel: "x" } },
    sent: { count: 11, value: { amount: 1, basisLabel: "x" } },
    estimated: { count: 10, value: { amount: 1, basisLabel: "x" } },
  },
  reps: [],
  officeProjection: { bands: [], coverage: { n: 0, m: 0, undatedValue: 0 }, coverageCaption: "" },
  weeklyTrend: TREND,
  valueBases: { won_awarded_first: "x", open_best_estimate: "y" },
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

function render(node: React.ReactNode, open: (r: EvidenceRequest) => void = () => {}) {
  act(() => {
    root.render(<DrillProvider open={open}>{node}</DrillProvider>);
  });
}

function clickButtonContaining(text: string) {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!btn) {
    throw new Error(
      `no button with text "${text}". Buttons: ${[...container.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`
    );
  }
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("A3 Momentum Lanes — MTD/YTD drill must not open period-scoped evidence", () => {
  it("MTD: the weekly numbers are NON-drillable (no button can open a mismatched drawer)", () => {
    const open = vi.fn<(r: EvidenceRequest) => void>();
    render(<VariantA3Lanes data={dataFor("mtd")} />, open);
    // A3's only drill targets are the per-lane weekly numbers; in MTD they are plain text, so no buttons.
    expect(container.querySelectorAll("button").length).toBe(0);
    expect(open).not.toHaveBeenCalled();
    // and the weekly value is still rendered
    expect(container.textContent).toContain("9");
  });

  it("YTD: also non-drillable", () => {
    const open = vi.fn<(r: EvidenceRequest) => void>();
    render(<VariantA3Lanes data={dataFor("ytd")} />, open);
    expect(container.querySelectorAll("button").length).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });

  it("MTD/YTD: the weekly number is NOT labeled 'Month to date'/'Year to date' (weekly wording instead)", () => {
    render(<VariantA3Lanes data={dataFor("mtd")} />);
    expect(container.textContent).not.toContain("Month to date");
    expect(container.textContent).toContain("this week");

    act(() => root.unmount());
    container.remove();
    root = createRoot((container = document.createElement("div")));
    document.body.appendChild(container);

    render(<VariantA3Lanes data={dataFor("ytd")} />);
    expect(container.textContent).not.toContain("Year to date");
    expect(container.textContent).toContain("this week");
  });
});

describe("A3 Momentum Lanes — weekly modes stay fully drillable + reconcile", () => {
  it("completed: lanes ARE drillable, say 'last week', and the drill carries NO from/to window", () => {
    const open = vi.fn<(r: EvidenceRequest) => void>();
    render(<VariantA3Lanes data={dataFor("completed")} />, open);
    expect(container.textContent).toContain("last week");
    // one drillable number per lane (Estimating/Sent/Won)
    expect(container.querySelectorAll("button").length).toBe(3);
    clickButtonContaining("9"); // the Won lane's last-bucket value
    expect(open).toHaveBeenCalledTimes(1);
    const req = open.mock.calls[0][0];
    expect(req.metric).toBe("won");
    expect(req.from).toBeUndefined(); // mode-scoped, NOT an explicit window
    expect(req.to).toBeUndefined();
    expect(req.title).toMatch(/last week/);
  });

  it("to_date: lanes ARE drillable and say 'this week'", () => {
    const open = vi.fn<(r: EvidenceRequest) => void>();
    render(<VariantA3Lanes data={dataFor("to_date")} />, open);
    expect(container.textContent).toContain("this week");
    expect(container.querySelectorAll("button").length).toBe(3);
    clickButtonContaining("9");
    expect(open.mock.calls[0][0].title).toMatch(/this week/);
  });
});
