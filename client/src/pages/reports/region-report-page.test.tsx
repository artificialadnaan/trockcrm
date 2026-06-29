// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegionReportData, RegionRow } from "./region-report-types";
import type { EvidenceRequest } from "./monday-showcase/types";

const hookState: { data: RegionReportData | null; loading: boolean; error: string | null } = {
  data: null,
  loading: false,
  error: null,
};
const hookCalls: Array<[string | undefined, string | undefined]> = [];
// Capture the EvidenceRequest the page hands the drawer — the wiring's whole job is to pass the SAME
// {regionName, from, to} the displayed number used, so the drill reconciles.
const evidenceRequests: Array<EvidenceRequest | null> = [];
vi.mock("@/hooks/use-reports", () => ({
  useRegionReport: (from?: string, to?: string) => {
    hookCalls.push([from, to]);
    return hookState;
  },
  useShowcaseEvidence: (request: EvidenceRequest | null) => {
    evidenceRequests.push(request);
    return { data: null, loading: false, error: null };
  },
}));

// The drill-down EvidenceDrawer this page renders calls useAuth (added in #827), so mock it — like
// evidence-drawer.test.tsx does — to let the page render without an AuthProvider.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, useAuth: () => ({ user: { id: "viewer", role: "director" } }) };
});

const EMPTY: RegionReportData = {
  period: { from: "2026-05-01", to: "2026-05-31", label: "2026-05-01 → 2026-05-31" },
  summary: { totalWon: { value: 0, count: 0 }, openPipeline: { value: 0, count: 0 }, winRate: null, unassignedPct: null },
  movers: { weekLabel: "2026-05-24 → 2026-05-27", biggestRegionMover: null, biggestNewDeal: null, biggestWin: null, biggestLoss: null },
  regions: [],
  stageColumns: [],
  stageMatrix: [],
};

import { RegionReportPage } from "./region-report-page";

function region(over: Partial<RegionRow> & { region: string }): RegionRow {
  return {
    isUnassigned: false,
    displayOrder: 1,
    won: { value: 0, count: 0 },
    pipeline: { value: 0, count: 0 },
    winRate: null,
    avgDeal: null,
    sparkline: [0, 0, 0, 0, 0, 0, 0, 0],
    forecast: {
      bands: {
        "0_30": { count: 0, value: 0 },
        "31_60": { count: 0, value: 0 },
        "61_90": { count: 0, value: 0 },
        beyond_90: { count: 0, value: 0 },
      },
      coverage: { n: 0, m: 0 },
    },
    topReps: [],
    ...over,
  };
}

const DATA: RegionReportData = {
  period: { from: "2026-05-24", to: "2026-05-27", label: "2026-05-24 → 2026-05-27" },
  summary: {
    totalWon: { value: 200000, count: 3 },
    openPipeline: { value: 165000, count: 5 },
    winRate: 50,
    unassignedPct: 20,
  },
  movers: {
    weekLabel: "2026-05-24 → 2026-05-27",
    biggestRegionMover: { region: "Central", deltaWon: 80000 },
    biggestNewDeal: { id: "o1", dealNumber: "O1", name: "Open West opp", value: 60000, region: "West Coast" },
    biggestWin: { id: "w1", dealNumber: "W1", name: "Won West thisweek", value: 100000, region: "West Coast" },
    biggestLoss: { id: "l1", dealNumber: "L1", name: "Lost West", value: 80000, region: "West Coast" },
  },
  regions: [
    region({
      region: "West Coast",
      displayOrder: 1,
      won: { value: 100000, count: 1 },
      pipeline: { value: 60000, count: 1 },
      winRate: 50,
      avgDeal: 100000,
      forecast: {
        bands: { "0_30": { count: 1, value: 60000 }, "31_60": { count: 0, value: 0 }, "61_90": { count: 0, value: 0 }, beyond_90: { count: 0, value: 0 } },
        coverage: { n: 1, m: 1 },
      },
      topReps: [{ repId: "a", repName: "Alice", wonValue: 100000, wonCount: 1 }],
    }),
    region({
      region: "Central",
      displayOrder: 2,
      won: { value: 100000, count: 2 },
      pipeline: { value: 70000, count: 2 },
      winRate: 50,
      avgDeal: 50000,
      forecast: {
        bands: { "0_30": { count: 0, value: 0 }, "31_60": { count: 1, value: 40000 }, "61_90": { count: 0, value: 0 }, beyond_90: { count: 0, value: 0 } },
        coverage: { n: 1, m: 2 },
      },
      topReps: [
        { repId: "b", repName: "Bob", wonValue: 60000, wonCount: 1 },
        { repId: "a", repName: "Alice", wonValue: 40000, wonCount: 1 },
      ],
    }),
    region({ region: "East Coast", displayOrder: 3, pipeline: { value: 20000, count: 1 }, forecast: { bands: region({ region: "x" }).forecast.bands, coverage: { n: 0, m: 1 } } }),
    region({ region: "Unassigned", isUnassigned: true, displayOrder: 9999, pipeline: { value: 15000, count: 1 } }),
  ],
  stageColumns: [
    { slug: "opportunity", name: "Opportunity", displayOrder: 2 },
    { slug: "estimating", name: "Estimating", displayOrder: 3 },
    { slug: "estimate_sent_to_client", name: "Estimate Sent to Client", displayOrder: 5 },
  ],
  stageMatrix: [
    { region: "West Coast", stageSlug: "opportunity", count: 1, value: 60000 },
    { region: "Central", stageSlug: "estimating", count: 1, value: 40000 },
    { region: "Central", stageSlug: "estimate_sent_to_client", count: 1, value: 30000 },
    { region: "East Coast", stageSlug: "opportunity", count: 1, value: 20000 },
    { region: "Unassigned", stageSlug: "estimating", count: 1, value: 15000 },
  ],
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  hookState.data = DATA;
  hookState.loading = false;
  hookState.error = null;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount() {
  act(() => {
    root.render(
      <MemoryRouter>
        <RegionReportPage />
      </MemoryRouter>
    );
  });
}

describe("RegionReportPage", () => {
  it("renders the summary cards with safe-formatted values", () => {
    mount();
    const t = container.textContent ?? "";
    expect(t).toContain("Reports by Region");
    expect(t).toContain("$200,000"); // total won (windowed)
    expect(t).toContain("$165,000"); // open pipeline (snapshot)
    expect(t).toContain("50%"); // win rate
    expect(t).toContain("20%"); // unassigned %
  });

  it("renders all four region segments incl. Unassigned with its nudge", () => {
    mount();
    const t = container.textContent ?? "";
    for (const name of ["West Coast", "Central", "East Coast", "Unassigned"]) expect(t).toContain(name);
    expect(t.toLowerCase()).toContain("no region"); // the Unassigned nudge
  });

  it("renders the mandatory N/M forecast coverage caption per region", () => {
    mount();
    const t = container.textContent ?? "";
    expect(t).toContain("1 of 1"); // West coverage
    expect(t).toContain("1 of 2"); // Central coverage (o3 NULL stays in M)
  });

  it("renders the region×stage heatmap with stage columns and cell counts", () => {
    mount();
    const t = container.textContent ?? "";
    for (const col of ["Opportunity", "Estimating", "Estimate Sent to Client"]) expect(t).toContain(col);
    // cells carry the deal count; never NaN
    expect(t).not.toContain("NaN");
  });

  it("renders top reps per region and the movers strip", () => {
    mount();
    const t = container.textContent ?? "";
    expect(t).toContain("Alice");
    expect(t).toContain("Bob");
    expect(t).toContain("Won West thisweek"); // biggest win mover
    expect(t).toContain("Central"); // biggest region mover
  });

  it("shows a loading state and an error state", () => {
    hookState.data = null;
    hookState.loading = true;
    mount();
    expect(container.querySelector(".animate-spin")).not.toBeNull(); // loading spinner rendered
    act(() => root.unmount());
    hookState.loading = false;
    hookState.error = "boom";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mount();
    expect((container.textContent ?? "").toLowerCase()).toContain("boom");
  });

  it("renders an empty report (no regions) without crashing or showing NaN", () => {
    hookState.data = EMPTY;
    mount();
    const t = container.textContent ?? "";
    expect(t).toContain("Reports by Region");
    expect(t).not.toContain("NaN");
    expect(t).toContain("—"); // null win rate / unassigned % render the safe placeholder
  });

  it("clicking a region's Won number drills with that region's NAME + the SAME period the section used", () => {
    evidenceRequests.length = 0;
    mount();
    const [reportFrom, reportTo] = hookCalls[hookCalls.length - 1];
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Won") && (b.textContent ?? "").includes("$100,000") && (b.textContent ?? "").includes("1 deals")
    );
    expect(btn).toBeTruthy();
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const req = evidenceRequests[evidenceRequests.length - 1];
    // region NAME (the report's GROUP-BY key), and the EXACT {from,to} the report data was fetched with
    expect(req).toMatchObject({ metric: "won", regionName: "West Coast", from: reportFrom, to: reportTo });
  });

  it("clicking the Unassigned Pipeline number drills with regionName 'Unassigned' (matches the proven bucket)", () => {
    evidenceRequests.length = 0;
    mount();
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Pipeline") && (b.textContent ?? "").includes("$15,000")
    );
    expect(btn).toBeTruthy();
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const req = evidenceRequests[evidenceRequests.length - 1];
    expect(req).toMatchObject({ metric: "pipeline", regionName: "Unassigned" });
    expect(req!.from).toBeTruthy(); // the snapshot still carries the period for the director-gated endpoint
  });

  it("clicking a heatmap cell drills pipeline scoped to that region + stage", () => {
    evidenceRequests.length = 0;
    mount();
    // West Coast × Opportunity cell shows count 1 / $60,000
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.getAttribute("title") ?? "").includes("click for the records") && (b.textContent ?? "").includes("$60,000")
    );
    expect(btn).toBeTruthy();
    act(() => btn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const req = evidenceRequests[evidenceRequests.length - 1];
    expect(req).toMatchObject({ metric: "pipeline", regionName: "West Coast", stageSlug: "opportunity" });
  });

  it("passes the resolved period as valid YYYY-MM-DD from/to into the data hook", () => {
    hookCalls.length = 0;
    mount();
    const [from, to] = hookCalls[hookCalls.length - 1];
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(from! <= to!).toBe(true);
  });
});
