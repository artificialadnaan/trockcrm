// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
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
      count: 3,
      ddValue: 110_000,
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
        {
          id: "current-3",
          name: "Older Estimating Project",
          dealNumber: "D-102",
          projectNumber: "P-102",
          stageLabel: "Estimating",
          ddEstimate: 10_000,
          daysInStage: 30,
        },
      ],
    },
    newRfps: {
      count: 3,
      ddValue: 80_000,
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
        {
          id: "rfp-3",
          name: "Newer Small RFP",
          dealNumber: "D-202",
          projectNumber: "P-202",
          requestedAt: "2026-08-21T16:00:00.000Z",
          currentRfpStatus: "approved",
          assignedRepId: "rep-1",
          assignedRepName: "Alex Sales",
          ddEstimate: 10_000,
        },
      ],
    },
    rfpBySalesperson: [
      { repId: "rep-1", repName: "Alex Sales", count: 2, ddValue: 80_000, missingDdCount: 0 },
      { repId: null, repName: "Unassigned", count: 1, ddValue: 0, missingDdCount: 1 },
    ],
    estimatesSent: {
      count: 3,
      latestBidBoardTotalSales: 200_000,
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
        {
          id: "sent-3",
          name: "Zero Margin Project",
          dealNumber: "D-302",
          projectNumber: "P-302",
          sentAt: "2026-08-22T16:00:00.000Z",
          ddEstimate: 0,
          latestBidBoardTotalSales: 20_000,
          varianceAmount: 20_000,
          variancePercent: null,
          marginPercent: 0,
        },
      ],
      comparison: {
        dollarComparableCount: 2,
        percentageComparableCount: 1,
        dollarComparableDdValue: 100_000,
        dollarComparableLatestBidBoardTotalSales: 140_000,
        varianceAmount: 40_000,
        percentageComparableDdValue: 100_000,
        percentageComparableLatestBidBoardTotalSales: 120_000,
        variancePercent: 20,
      },
      margin: { projectCount: 2, latestBidBoardTotalSales: 140_000, blendedPercent: 15.4 },
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

function renderA1(payload: MondayShowcaseData = data, initialEntry = "/reports/monday-showcase") {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <VariantA1EstimatingReport data={payload} />
      </MemoryRouter>
    );
  });
}

function tableByLabel(label: string): HTMLElement {
  const table = container.querySelector(`[aria-label="${label}"]`);
  if (!table) throw new Error(`no A1 table labelled ${label}`);
  return table as HTMLElement;
}

function rowProjectNames(label: string): string[] {
  return [...tableByLabel(label).querySelectorAll("tbody tr a")].map((link) => link.textContent?.trim() ?? "");
}

function dialogText(): string {
  const dialog = document.body.querySelector('[data-slot="dialog-content"]');
  if (!dialog) throw new Error("supporting-record dialog is not open");
  return dialog.textContent ?? "";
}

function closeDialog() {
  const close = document.body.querySelector('[data-slot="dialog-close"]') as HTMLButtonElement | null;
  if (!close) throw new Error("dialog close button is not available");
  act(() => close.click());
}

describe("A1 Estimating Report", () => {
  it("renders all leadership sections, current-vs-period language, visible source caveats, and the requested project fields", () => {
    renderA1();
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
    expect(text).toContain("Same 2-project base as $ variance");

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

  it("opens exact supporting records for a headline and a salesperson RFP count", () => {
    renderA1();

    act(() => {
      (container.querySelector('button[aria-label="Show supporting records for Current estimating"]') as HTMLButtonElement).click();
    });
    expect(dialogText()).toContain("Current projects in Estimating");
    expect(dialogText()).toContain("Riverside Center");
    expect(dialogText()).toContain("Older Estimating Project");
    expect(dialogText()).not.toContain("Austin Tower");
    closeDialog();

    act(() => {
      (container.querySelector('button[aria-label="Show Alex Sales RFPs"]') as HTMLButtonElement).click();
    });
    expect(dialogText()).toContain("Alex Sales — RFP submissions initiated");
    expect(dialogText()).toContain("Austin Tower");
    expect(dialogText()).toContain("Newer Small RFP");
    expect(dialogText()).not.toContain("Unassigned RFP");
    closeDialog();

    act(() => {
      (container.querySelector('button[aria-label="Show Unassigned RFPs"]') as HTMLButtonElement).click();
    });
    expect(dialogText()).toContain("Unassigned — RFP submissions initiated");
    expect(dialogText()).toContain("Unassigned RFP");
    expect(dialogText()).not.toContain("Austin Tower");
    closeDialog();

    act(() => {
      (container.querySelector('button[aria-label="Show Alex Sales RFPs with known DD"]') as HTMLButtonElement).click();
    });
    expect(dialogText()).toContain("Austin Tower");
    expect(dialogText()).toContain("Newer Small RFP");
    expect(dialogText()).not.toContain("Unassigned RFP");
    closeDialog();

    act(() => {
      (container.querySelector('button[aria-label="Show all RFPs missing DD"]') as HTMLButtonElement).click();
    });
    expect(dialogText()).toContain("Unassigned RFP");
    expect(dialogText()).not.toContain("Austin Tower");
    closeDialog();

    act(() => {
      (container.querySelector('button[aria-label="Show supporting records for Projects sent"]') as HTMLButtonElement).click();
    });
    expect(dialogText()).toContain("Downtown Facade");
    expect(dialogText()).toContain("Missing financial fields");
    expect(dialogText()).toContain("Zero Margin Project");
    expect(dialogText()).toContain("3 projects · $200,000 latest Bid Board total");
  });

  it("uses each sent-metric eligibility rule, including true zero values", () => {
    renderA1();

    act(() => {
      (container.querySelector('button[aria-label="Show supporting records for Comparable Current DD Estimate"]') as HTMLButtonElement).click();
    });
    expect(dialogText()).toContain("Downtown Facade");
    // A real $0 DD is comparable in dollar terms; a missing DD is not.
    expect(dialogText()).toContain("Zero Margin Project");
    expect(dialogText()).not.toContain("Missing financial fields");
    expect(dialogText()).toContain("$100,000 DD → $140,000 latest total · +$40,000 variance");
    closeDialog();

    act(() => {
      (container.querySelector('button[aria-label="Show supporting records for Percent variance"]') as HTMLButtonElement).click();
    });
    expect(dialogText()).toContain("Downtown Facade");
    // The percentage denominator must be positive, so the real zero DD correctly drops out.
    expect(dialogText()).not.toContain("Zero Margin Project");
    expect(dialogText()).toContain("$100,000 DD → $120,000 latest total · 20% variance");
    closeDialog();

    act(() => {
      (container.querySelector('button[aria-label="Show supporting records for Blended margin"]') as HTMLButtonElement).click();
    });
    expect(dialogText()).toContain("Downtown Facade");
    // A 0% margin is usable in the weighted result, unlike a missing margin.
    expect(dialogText()).toContain("Zero Margin Project");
    expect(dialogText()).not.toContain("Missing financial fields");
    expect(dialogText()).toContain("$140,000 latest total · 15.4% weighted margin");
  });

  it("sorts Request opened, DD Estimate, and Time in stage both directions with nulls last", () => {
    renderA1();

    const rfpTable = tableByLabel("New RFP submissions initiated");
    const requestOpened = rfpTable.querySelector('button[aria-label="Sort by Request opened"]') as HTMLButtonElement;
    act(() => requestOpened.click());
    expect(rfpTable.querySelector('th[aria-sort="descending"]')?.textContent).toContain("Request opened");
    expect(rowProjectNames("New RFP submissions initiated")).toEqual(["Newer Small RFP", "Austin Tower", "Unassigned RFP"]);
    act(() => requestOpened.click());
    expect(rfpTable.querySelector('th[aria-sort="ascending"]')?.textContent).toContain("Request opened");
    expect(rowProjectNames("New RFP submissions initiated")).toEqual(["Unassigned RFP", "Austin Tower", "Newer Small RFP"]);

    const ddEstimate = rfpTable.querySelector('button[aria-label="Sort by DD Estimate"]') as HTMLButtonElement;
    act(() => ddEstimate.click());
    expect(rowProjectNames("New RFP submissions initiated")).toEqual(["Austin Tower", "Newer Small RFP", "Unassigned RFP"]);
    act(() => ddEstimate.click());
    expect(rowProjectNames("New RFP submissions initiated")).toEqual(["Newer Small RFP", "Austin Tower", "Unassigned RFP"]);

    const currentTable = tableByLabel("Current projects in estimating");
    const timeInStage = currentTable.querySelector('button[aria-label="Sort by Time in stage"]') as HTMLButtonElement;
    act(() => timeInStage.click());
    expect(currentTable.querySelector('th[aria-sort="descending"]')?.textContent).toContain("Time in stage");
    expect(rowProjectNames("Current projects in estimating")).toEqual(["Older Estimating Project", "Riverside Center", "No DD Yet"]);
    act(() => timeInStage.click());
    expect(rowProjectNames("Current projects in estimating")).toEqual(["No DD Yet", "Riverside Center", "Older Estimating Project"]);
  });

  it("opens scoped CRM deal links in a new tab and closes an open dialog when the A1 payload changes", () => {
    renderA1(data, "/reports/monday-showcase?officeId=office-b");
    const dealLink = container.querySelector('a[href="/deals/current-1?officeId=office-b"]');
    expect(dealLink?.getAttribute("target")).toBe("_blank");
    expect(dealLink?.getAttribute("rel")).toBe("noopener noreferrer");

    act(() => {
      (container.querySelector('button[aria-label="Show supporting records for Current estimating"]') as HTMLButtonElement).click();
    });
    expect(document.body.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
    renderA1({ ...data, period: { ...data.period, to: "2026-08-29", label: "2026-08-16 → 2026-08-29" } }, "/reports/monday-showcase?officeId=office-b");
    expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
  });
});
