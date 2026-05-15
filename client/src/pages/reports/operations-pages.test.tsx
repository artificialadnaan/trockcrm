import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { PortfolioLoadPage } from "./portfolio-load-page";
import { ProjectReadinessPage } from "./project-readiness-page";
import { WorkflowBottlenecksPage } from "./workflow-bottlenecks-page";

const reportData = vi.hoisted(() => ({
  workflow: {
    generatedAt: "2026-05-11T12:00:00.000Z",
    kpis: {
      totalStuckDeals: 2,
      avgDealAge: 24.5,
      longestStuckDealAge: 61,
      stagesWithFivePlusStuckDeals: 0,
    },
    stageAging: [
      { stageName: "Estimating", openDealCount: 3, avgDaysInStage: 24.5, medianDaysInStage: 20, maxDaysInStage: 61, stuckDealCount: 2 },
    ],
    topStuckDeals: [
      { dealId: "deal-1", dealName: "North Campus", ownerName: "Avery Rep", stageName: "Estimating", daysInStage: 61, daysSinceLastActivity: 5, value: 123456, projectNumber: "TR-101" },
    ],
    handoffBlockages: [],
  },
  readiness: {
    generatedAt: "2026-05-11T12:00:00.000Z",
    assumption: "Kickoff readiness is a v1 proxy.",
    kpis: {
      dealsInScoping: 1,
      dealsInEstimating: 2,
      dealsContractReady: 3,
      dealsKickoffReady: 4,
    },
    checklistBreakdown: [
      { stageGroup: "Scoping", completeCount: 1, incompleteCount: 1, signals: ["Attachments: Site Photos"] },
      { stageGroup: "Estimating", completeCount: 2, incompleteCount: 1, signals: ["Estimate sent"] },
      { stageGroup: "Contract", completeCount: 3, incompleteCount: 0, signals: [] },
      { stageGroup: "Kickoff", completeCount: 4, incompleteCount: 1, signals: ["Project manager assigned"] },
    ],
    missingReadiness: [
      { dealId: "deal-2", dealName: "Ready Gap", ownerName: "Blake Rep", stageName: "Scoping", daysInStage: 9, missingItems: ["Attachments: Site Photos"], projectNumber: null },
    ],
    ownerSummary: [
      { ownerName: "Blake Rep", scopingIncomplete: 1, estimatingIncomplete: 0, kickoffIncomplete: 0 },
    ],
  },
  portfolio: {
    generatedAt: "2026-05-11T12:00:00.000Z",
    kpis: {
      activeCompanies: 1,
      activeProperties: 2,
      totalActiveValue: 250000,
      avgDealValuePerCompany: 250000,
    },
    companyBreakdown: [
      { companyId: "company-1", companyName: "Acme Properties", activeDealCount: 2, totalOpenValue: 250000, topProperty: "Acme Tower", owners: ["Avery Rep"], avgDealAge: 15 },
    ],
    propertyBreakdown: [
      { propertyId: "property-1", propertyName: "Acme Tower", companyName: "Acme Properties", activeDealCount: 1, totalValue: 200000, mostRecentActivity: "2026-05-08T00:00:00.000Z", ownerName: "Avery Rep" },
    ],
    concentrationRisk: [
      { companyName: "Acme Properties", totalOpenValue: 250000, percentOfOpenPipeline: 100 },
    ],
    geographicSpread: {
      byOffice: [{ office: "Dallas", dealCount: 2, totalValue: 250000 }],
      byRegion: [{ region: "North Texas", dealCount: 2, totalValue: 250000 }],
    },
  },
}));

vi.mock("@/components/reports/report-filter-bar", () => ({
  ReportFilterBar: () => <div>Report Filters</div>,
  useReportFilters: () => ({ query: { dateFrom: "2026-02-01", dateTo: "2026-05-11", office: "all", ownerIds: [] } }),
}));

vi.mock("@/hooks/use-reports", () => ({
  useWorkflowBottlenecksReport: () => ({ data: reportData.workflow, loading: false, error: null }),
  useProjectReadinessReport: () => ({ data: reportData.readiness, loading: false, error: null }),
  usePortfolioLoadReport: () => ({ data: reportData.portfolio, loading: false, error: null }),
}));

function renderPage(element: ReactNode) {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>).replace(/\s+/g, " ").trim();
}

describe("operations report pages", () => {
  it("renders workflow bottlenecks with USD, display names, and deal links", () => {
    const html = renderPage(<WorkflowBottlenecksPage />);

    expect(html).toContain("Workflow Bottlenecks");
    expect(html).toContain("Export to Excel");
    expect(html).toContain("Estimating");
    expect(html).toContain("Avery Rep");
    expect(html).toContain("$123,456");
    expect(html).toContain("/deals/deal-1");
    expect(html).not.toContain("stage_slug");
  });

  it("renders project readiness gaps and owner summary", () => {
    const html = renderPage(<ProjectReadinessPage />);

    expect(html).toContain("Project Readiness");
    expect(html).toContain("Export to Excel");
    expect(html).toContain("Attachments: Site Photos");
    expect(html).toContain("Blake Rep");
    expect(html).toContain("Kickoff readiness is a v1 proxy.");
  });

  it("renders portfolio load company, property, concentration, and geography sections", () => {
    const html = renderPage(<PortfolioLoadPage />);

    expect(html).toContain("Portfolio Load");
    expect(html).toContain("Export to Excel");
    expect(html).toContain("Acme Properties");
    expect(html).toContain("Acme Tower");
    expect(html).toContain("$250,000");
    expect(html).toContain("North Texas");
    expect(html).toContain("/companies/company-1");
    expect(html).toContain("/properties/property-1");
  });
});
