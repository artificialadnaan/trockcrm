import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportsPage } from "./reports-page";

const mocks = vi.hoisted(() => ({
  useSavedReportsMock: vi.fn(),
  runReportBuilderMock: vi.fn(),
  createSavedReportMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "admin-1", role: "admin", displayName: "Admin" } }),
}));

vi.mock("@/hooks/use-reports", () => ({
  useSavedReports: mocks.useSavedReportsMock,
  runReportBuilder: mocks.runReportBuilderMock,
  createSavedReport: mocks.createSavedReportMock,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Bar: () => <div>Bar</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Line: () => <div>Line</div>,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

vi.mock("@/lib/report-export", () => ({
  downloadTextFile: vi.fn(),
  serializeRowsToCsv: vi.fn(() => "csv"),
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("ReportsPage", () => {
  beforeEach(() => {
    mocks.useSavedReportsMock.mockReturnValue({
      reports: [
        {
          id: "saved-1",
          name: "Saved Pipeline View",
          config: {
            builderRequest: {
              dimensions: ["stage"],
              measures: ["deal_count"],
              filters: {},
              dateField: "created_at",
            },
          },
          isLocked: false,
        },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.runReportBuilderMock.mockResolvedValue({
      data: {
        columns: [
          { key: "stage", label: "Stage", kind: "dimension" },
          { key: "deal_count", label: "Deal Count", kind: "measure" },
        ],
        rows: [{ stage: "Contract Signed", deal_count: 3 }],
      },
    });
  });

  it("renders the rebuilt report builder and quick reports", () => {
    const html = normalize(renderToStaticMarkup(<ReportsPage />));

    expect(html).toContain("Reports");
    expect(html).toContain("Report Builder");
    expect(html).toContain("Saved Views");
    expect(html).toContain("MTD Pipeline");
    expect(html).toContain("YTD Closed Won");
    expect(html).toContain("This Week&#x27;s Activity");
    expect(html).toContain("Dimensions");
    expect(html).toContain("Measures");
    expect(html).toContain("CSV Export");
    expect(html).not.toContain("MTD/YTD");
  });
});
