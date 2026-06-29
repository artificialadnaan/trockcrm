// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VariantExecHero, VariantB3LoadLane } from "./variants";
import { DrillProvider } from "./drill";
import { SHOWCASE_VARIANTS } from "./types";
import type { MondayShowcaseData, EvidenceRequest, DepartmentMetric } from "./types";

// The hybrid Exec survivor (consolidation Group 1) reads data.departments (where deltaCountWoW + sparkline
// live). The contract (assembleMondayShowcase): the THREE non-deferred departments (estimating/sent/won)
// carry real count/value/delta/sparkline; Collected is a DEFERRED placeholder — count/value/deltaCountWoW
// null and sparkline [] — never zero- or real-filled, until a finance source is wired. So the hybrid shows
// a delta chip + sparkline only for the three non-deferred depts; Collected renders as "—"/"deferred".
const dept = (
  key: DepartmentMetric["key"],
  label: string,
  count: number,
  amount: number,
  deltaCountWoW: number,
  sparkline: number[],
  deferred = false,
): DepartmentMetric => ({
  key,
  label,
  count,
  value: { amount, basisLabel: key === "won" ? "Awarded-first won value" : "Best current estimate" },
  deltaCountWoW,
  sparkline,
  deferred,
});

const base: MondayShowcaseData = {
  period: { from: "2026-05-24", to: "2026-05-27", mode: "to_date", label: "2026-05-24 → 2026-05-27" },
  departments: [
    dept("estimating", "Estimated", 5, 50, -1, [1, 2, 3, 2, 4, 3, 5, 5]),
    dept("sent", "Sent", 13, 100, 2, [3, 4, 6, 5, 7, 9, 11, 13]),
    dept("won", "Won", 12, 3_900_000, 4, [2, 3, 5, 4, 8, 9, 10, 12]),
    // Collected matches the server contract: a deferred placeholder with null count/value/delta and an
    // empty sparkline (no finance source yet), so the hybrid surfaces NO chip/sparkline for it.
    {
      key: "collected",
      label: "Collected",
      count: null,
      value: null,
      deltaCountWoW: null,
      sparkline: [],
      deferred: true,
    },
  ],
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
        coverage: { n: 1, m: 1, undatedValue: 0 },
        coverageCaption: "1 of 1 open deals have a maintained (future-dated) expected close date.",
      },
      sentThisWeek: { count: 3, value: { amount: 2000, basisLabel: "Best current estimate" } },
      leadStatus: [{ stageLabel: "New", count: 4 }],
    },
  ],
  officeProjection: { bands: [], coverage: { n: 0, m: 0, undatedValue: 0 }, coverageCaption: "" },
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

describe("Monday showcase consolidation", () => {
  it("registry no longer offers the removed A1 / A2 / B1 variants", () => {
    const keys = SHOWCASE_VARIANTS.map((v) => v.key);
    expect(keys).not.toContain("A1");
    expect(keys).not.toContain("A2");
    expect(keys).not.toContain("B1");
    // Survivors of the consolidation stay selectable.
    expect(keys).toEqual(expect.arrayContaining(["A3", "HERO", "B2", "B3", "B4"]));
    // HERO (the hybrid survivor) must still exist so the page's useState("HERO") default is valid.
    expect(keys).toContain("HERO");
  });

  it("hybrid Exec survivor renders all FOUR tiles; the 3 non-deferred carry a WoW chip + sparkline, Collected renders deferred", () => {
    act(() => {
      root.render(
        <DrillProvider open={vi.fn()}>
          <VariantExecHero data={base} />
        </DrillProvider>
      );
    });
    const text = container.textContent ?? "";
    // All four departments are present (A2's richness folded into Hero's big tiles).
    for (const label of ["Estimated", "Sent", "Won", "Collected"]) {
      expect(text).toContain(label);
    }
    // Exactly the THREE non-deferred metrics show a WoW delta chip (DeltaChip returns null for a null delta,
    // so the deferred Collected dept contributes none).
    const deltaChips = [...container.querySelectorAll("span")].filter((s) => s.textContent?.includes("WoW"));
    expect(deltaChips.length).toBe(3);
    // ... and a sparkline each (Sparkline tags its root data-testid="sparkline"; gated on sparkline.length > 0,
    // so Collected's empty sparkline renders none).
    const sparklines = container.querySelectorAll('[data-testid="sparkline"]');
    expect(sparklines.length).toBe(3);
    // Collected renders as the deferred placeholder: a "—" count and the "deferred" value, no chip/sparkline.
    expect(text).toContain("—");
    expect(text).toContain("deferred");
  });
});

// Regression guard for the 8->5 consolidation: B1 (Roll-Call Scorecards) provided per-rep STAGE-SPECIFIC
// lead drills (one pill per lead stage, each opening the evidence for THAT stage via leadStage). B1 was
// removed; B3 (Rep Load Lane) is its consolidated survivor for lead status. This locks that B3 still exposes
// the per-stage lead drill — not just an aggregate metric:"leads" — so the capability isn't silently lost.
describe("Monday showcase per-stage lead drill (B1 -> B3 preservation)", () => {
  // A rep carrying MULTIPLE lead stages, so an aggregate-only drill would be lossy.
  const multiStage: MondayShowcaseData = {
    ...base,
    reps: [
      {
        ...base.reps[0],
        leadStatus: [
          { stageLabel: "New", count: 4 },
          { stageLabel: "Contacted", count: 2 },
          { stageLabel: "Qualified", count: 1 },
        ],
      },
    ],
  };

  it("B3 renders a drill affordance for EACH lead stage that passes leadStage scoped to that stage + rep", () => {
    const open = vi.fn<(r: EvidenceRequest) => void>();
    act(() => {
      root.render(
        <DrillProvider open={open}>
          <VariantB3LoadLane data={multiStage} />
        </DrillProvider>
      );
    });
    // Clicking the per-stage "Contacted" affordance must open the stage-specific lead evidence.
    clickButtonContaining("Contacted");
    expect(open).toHaveBeenCalledTimes(1);
    const req = open.mock.calls[0][0];
    expect(req.metric).toBe("leads");
    expect(req.repId).toBe("rep-1");
    expect(req.leadStage).toBe("Contacted");
    expect(req.title).toMatch(/Contacted/);

    // Every lead stage on the rep must be independently drillable by stage (not just an aggregate total).
    for (const stage of ["New", "Contacted", "Qualified"]) {
      open.mockClear();
      clickButtonContaining(`${stage}:`);
      const r = open.mock.calls[0][0];
      expect(r.metric).toBe("leads");
      expect(r.leadStage).toBe(stage);
    }
  });
});

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

  it("hybrid exec: the deferred Collected tile is not drillable", () => {
    const open = vi.fn<(r: EvidenceRequest) => void>();
    act(() => {
      root.render(
        <DrillProvider open={open}>
          <VariantExecHero data={base} />
        </DrillProvider>
      );
    });
    // Collected has no evidence cohort; clicking its tile must NOT open a drawer.
    const collectedBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Collected"));
    expect(collectedBtn).toBeUndefined();
  });
});
