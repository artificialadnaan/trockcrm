// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VariantA1EstimatingReport } from "./estimating-report";
import { UNFILTERED_ROUTE_FILTER } from "./types";
import type { MondayShowcaseData } from "./types";

const data: MondayShowcaseData = {
  period: { from: "2026-08-16", to: "2026-08-22", mode: "completed", label: "2026-08-16 → 2026-08-22" },
  departments: [],
  execHero: {
    won: { count: 0, value: { amount: 0, basisLabel: "Awarded-first won value" } },
    sent: { count: 0, value: { amount: 0, basisLabel: "Best current estimate" } },
    estimated: { count: 0, value: { amount: 0, basisLabel: "Best current estimate" } },
  },
  reps: [],
  officeProjection: { bands: [], coverage: { n: 0, m: 0, undatedValue: 0 }, coverageCaption: "" },
  weeklyTrend: [],
  valueBases: { won_awarded_first: "Awarded-first won value", open_best_estimate: "Best current estimate" },
  estimatingReport: {
    currentAsOf: "2026-08-26T15:30:00.000Z",
    currentEstimating: {
      count: 2,
      ddValue: 100_000,
      missingDdCount: 1,
      projects: [
        {
          id: "current-1",
          name: "Riverside Center",
          dealNumber: "D-100",
          projectNumber: "P-100",
          stageLabel: "Estimating",
          ddEstimate: 100_000,
          daysInStage: 12,
        },
        {
          id: "current-2",
          name: "No DD Yet",
          dealNumber: "D-101",
          projectNumber: null,
          stageLabel: "Service estimating",
          ddEstimate: null,
          daysInStage: 3,
        },
      ],
    },
    newRfps: {
      count: 2,
      ddValue: 70_000,
      missingDdCount: 1,
      projects: [
        {
          id: "rfp-1",
          name: "Austin Tower",
          dealNumber: "D-200",
          projectNumber: "P-200",
          requestedAt: "2026-08-20T16:00:00.000Z",
          currentRfpStatus: "pending",
          assignedRepId: "rep-1",
          assignedRepName: "Alex Sales",
          ddEstimate: 70_000,
        },
        {
          id: "rfp-2",
          name: "Unassigned RFP",
          dealNumber: "D-201",
          projectNumber: null,
          requestedAt: "2026-08-19T16:00:00.000Z",
          currentRfpStatus: null,
          assignedRepId: null,
          assignedRepName: "Unassigned",
          ddEstimate: null,
        },
      ],
    },
    rfpBySalesperson: [
      { repId: "rep-1", repName: "Alex Sales", count: 1, ddValue: 70_000, missingDdCount: 0 },
      { repId: null, repName: "Unassigned", count: 1, ddValue: 0, missingDdCount: 1 },
    ],
    estimatesSent: {
      count: 2,
      latestBidBoardTotalSales: 180_000,
      projects: [
        {
          id: "sent-1",
          name: "Downtown Facade",
          dealNumber: "D-300",
          projectNumber: "P-300",
          sentAt: "2026-08-21T16:00:00.000Z",
          ddEstimate: 100_000,
          latestBidBoardTotalSales: 120_000,
          varianceAmount: 20_000,
          variancePercent: 20,
          marginPercent: 18,
        },
        {
          id: "sent-2",
          name: "Missing financial fields",
          dealNumber: "D-301",
          projectNumber: null,
          sentAt: "2026-08-20T16:00:00.000Z",
          ddEstimate: null,
          latestBidBoardTotalSales: 60_000,
          varianceAmount: null,
          variancePercent: null,
          marginPercent: null,
        },
      ],
      comparison: {
        dollarComparableCount: 1,
        percentageComparableCount: 1,
        dollarComparableDdValue: 100_000,
        dollarComparableLatestBidBoardTotalSales: 120_000,
        varianceAmount: 20_000,
        percentageComparableDdValue: 100_000,
        percentageComparableLatestBidBoardTotalSales: 120_000,
        variancePercent: 20,
      },
      margin: { projectCount: 1, latestBidBoardTotalSales: 120_000, blendedPercent: 18 },
      missingSentValueCount: 0,
      missingMarginCount: 1,
    },
  },
  routeFilter: UNFILTERED_ROUTE_FILTER,
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

describe("A1 Estimating Report", () => {
  it("renders all leadership sections, current-vs-period language, visible source caveats, and the requested project fields", () => {
    act(() => {
      root.render(<VariantA1EstimatingReport data={data} />);
    });
    const text = container.textContent ?? "";
    expect(container.querySelector('[data-testid="a1-estimating-report"]')).not.toBeNull();
    expect(text).toContain("Current projects in Estimating");
    expect(text).toContain("New RFP submissions initiated");
    expect(text).toContain("Projects sent to client");
    expect(text).toContain("RFPs by salesperson");
    expect(text).toContain("Last full week");
    expect(text).toContain("Live current workload as of");
    expect(text).toContain("latest Bid Board / CRM values as of page refresh");
    expect(text).toContain("Current RFP-request cycle");
    expect(text).toContain("Comparable Current DD Estimate");
    expect(text).toContain("Same 1-project base as $ variance");

    // Requested project-level evidence: project identifiers, direct DD, latest total, variance, and margin.
    expect(text).toContain("Riverside Center");
    expect(text).toContain("P-100");
    expect(text).toContain("Downtown Facade");
    expect(text).toContain("$100,000");
    expect(text).toContain("$120,000");
    expect(text).toContain("+$20,000");
    expect(text).toContain("20%");
    expect(text).toContain("18%");
    // Missing is visible as an em dash; it cannot be mistaken for a zero-valued project.
    expect(text).toContain("—");

    // The same RFP cohort is represented by its project table and current-assigned-sales-rep rollup.
    expect(text).toContain("Alex Sales");
    expect(text).toContain("Unassigned");
    expect(text).toContain("All current assigned reps");
    expect(container.querySelector('[aria-label="Projects sent to client"]')).not.toBeNull();
  });
});
