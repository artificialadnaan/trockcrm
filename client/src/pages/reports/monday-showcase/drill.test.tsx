// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VariantExecHero, VariantB1Scorecards } from "./variants";
import { DrillProvider } from "./drill";
import type { MondayShowcaseData, EvidenceRequest } from "./types";

const base: MondayShowcaseData = {
  period: { from: "2026-05-24", to: "2026-05-27", mode: "to_date", label: "2026-05-24 → 2026-05-27" },
  departments: [],
  execHero: {
    won: { count: 12, value: { amount: 3_900_000, basisLabel: "Awarded-first won value" } },
    sent: { count: 13, value: { amount: 100, basisLabel: "Best current estimate" } },
    estimated: { count: 5, value: { amount: 50, basisLabel: "Best current estimate" } },
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
  officeProjection: { bands: [], coverage: { n: 0, m: 0 }, coverageCaption: "" },
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

function clickButtonContaining(text: string) {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`no button containing "${text}". Buttons: ${[...container.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`);
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Monday showcase drill wiring", () => {
  it("exec hero: clicking the Won tile opens office Won evidence (no repId)", () => {
    const open = vi.fn<(r: EvidenceRequest) => void>();
    act(() => {
      root.render(
        <DrillProvider open={open}>
          <VariantExecHero data={base} />
        </DrillProvider>
      );
    });
    clickButtonContaining("Won this week");
    expect(open).toHaveBeenCalledTimes(1);
    const req = open.mock.calls[0][0];
    expect(req.metric).toBe("won");
    expect(req.repId).toBeUndefined(); // office-wide
    expect(req.title).toMatch(/Won/);
  });

  it("B1: clicking a rep's lead chip opens that rep+stage lead evidence", () => {
    const open = vi.fn<(r: EvidenceRequest) => void>();
    act(() => {
      root.render(
        <DrillProvider open={open}>
          <VariantB1Scorecards data={base} />
        </DrillProvider>
      );
    });
    clickButtonContaining("New: 4");
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toMatchObject({ metric: "leads", repId: "rep-1", leadStage: "New" });
  });

  it("B1: clicking a rep's closed count opens that rep's Won evidence", () => {
    const open = vi.fn<(r: EvidenceRequest) => void>();
    act(() => {
      root.render(
        <DrillProvider open={open}>
          <VariantB1Scorecards data={base} />
        </DrillProvider>
      );
    });
    clickButtonContaining("2"); // the closed count chip
    expect(open).toHaveBeenCalled();
    expect(open.mock.calls[0][0]).toMatchObject({ metric: "won", repId: "rep-1" });
  });
});
