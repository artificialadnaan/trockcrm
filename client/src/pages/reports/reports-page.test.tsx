import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { ReportsPage } from "./reports-page";

const mocks = vi.hoisted(() => ({
  useSavedReportsMock: vi.fn(),
  useUnifiedWorkflowOverviewMock: vi.fn(),
}));

vi.mock("@/hooks/use-reports", () => ({
  useSavedReports: mocks.useSavedReportsMock,
  useUnifiedWorkflowOverview: mocks.useUnifiedWorkflowOverviewMock,
  executeLockedReport: vi.fn(),
  executeCustomReport: vi.fn(),
  createSavedReport: vi.fn(),
  deleteSavedReport: vi.fn(),
}));

vi.mock("@/components/charts/report-chart", () => ({
  ReportChart: () => <div>Report Chart</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: () => <input />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <div />,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/report-export", () => ({
  buildPrintableReportHtml: vi.fn(),
  buildReportExportFilename: vi.fn(),
  downloadTextFile: vi.fn(),
  normalizeReportRows: vi.fn(() => []),
  openPrintableReportWindow: vi.fn(),
  serializeRowsToCsv: vi.fn(),
}));

vi.mock("@/lib/report-actions", () => ({
  getScheduleReportActionConfig: vi.fn(() => ({ label: "Schedule", href: "/reports/schedule" })),
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("ReportsPage", () => {
  beforeEach(() => {
    mocks.useSavedReportsMock.mockReturnValue({
      reports: [],
      loading: false,
      refetch: vi.fn(),
    });
    mocks.useUnifiedWorkflowOverviewMock.mockReturnValue({
      data: {
        leadPipelineSummary: [],
        standardVsServiceRollups: [],
        companyRollups: [],
        repActivitySplit: [],
        staleLeads: [],
        staleDeals: [],
        crmOwnedProgression: [
          {
            workflowBucket: "lead",
            workflowRoute: "normal",
            stageName: "New Lead",
            itemCount: 2,
            totalValue: 125000,
          },
        ],
        mirroredDownstreamSummary: [
          {
            mirroredStageSlug: "estimating",
            mirroredStageName: "Estimating",
            mirroredStageStatus: "blocked",
            workflowRoute: "service",
            dealCount: 2,
            totalValue: 275000,
          },
        ],
        reasonCodedDisqualifications: [
          {
            workflowRoute: "normal",
            disqualificationReason: "other",
            leadCount: 1,
          },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("renders the expanded unified workflow sections from the workflow overview payload", () => {
    const html = normalize(
      renderToStaticMarkup(
        <MemoryRouter>
          <ReportsPage />
        </MemoryRouter>
      )
    );

    expect(html).toContain("CRM-Owned Progression");
    expect(html).toContain("Mirrored Downstream Summary");
    expect(html).toContain("Reason-Coded Disqualifications");
    expect(html).toContain("New Lead");
    expect(html).toContain("Estimating");
    expect(html).toContain("Blocked");
    expect(html).toContain("Other");
  });
});
