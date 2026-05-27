import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  useDealStagePageMock: vi.fn(),
  useNormalizedStageRouteMock: vi.fn(),
  useRegionsMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  useDealStagePage: mocks.useDealStagePageMock,
}));

vi.mock("@/lib/pipeline-scope", () => ({
  useNormalizedStageRoute: mocks.useNormalizedStageRouteMock,
}));
vi.mock("@/hooks/use-pipeline-config", () => ({
  useRegions: mocks.useRegionsMock,
}));
vi.mock("@/hooks/use-task-assignees", () => ({
  useTaskAssignees: mocks.useTaskAssigneesMock,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { role: "admin" },
  }),
}));
vi.mock("@/lib/pipeline-ownership", () => ({
  getWorkflowRouteLabel: (route: "normal" | "service") => (route === "service" ? "Service" : "Standard"),
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/pipeline/pipeline-stage-page-header", () => ({
  PipelineStagePageHeader: ({
    children,
    backTo,
    title,
    subtitle,
    summary,
  }: {
    children: string;
    backTo: string;
    title: string;
    subtitle?: string;
    summary?: ReactNode;
  }) => (
    <div>
      <a href={backTo}>Back to board</a>
      <h1>{title}</h1>
      {subtitle ? <p>{subtitle}</p> : null}
      {summary}
      {children}
    </div>
  ),
}));
vi.mock("@/components/pipeline/pipeline-stage-table", () => ({
  PipelineStageTable: ({
    rows,
    columns,
  }: {
    rows: Array<{ name: string }>;
    columns: Array<{
      key: string;
      header: ReactNode;
      headClassName?: string;
      cellClassName?: string;
      render?: (row: any) => ReactNode;
    }>;
  }) => (
    <table>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} className={column.headClassName}>
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
      {rows.map((row) => (
        <tr key={row.name}>
          {columns.map((column, index) => (
            <td key={index} className={column.cellClassName}>
              {column.render ? column.render(row) : row.name}
            </td>
          ))}
        </tr>
      ))}
      </tbody>
    </table>
  ),
}));

import { DealStagePage } from "./deal-stage-page";

describe("DealStagePage", () => {
  beforeEach(() => {
    mocks.useRegionsMock.mockReturnValue({ regions: [{ id: "region-1", name: "Dallas" }] });
    mocks.useTaskAssigneesMock.mockReturnValue({ assignees: [{ id: "rep-1", displayName: "Alex Rep" }] });
    mocks.useNormalizedStageRouteMock.mockReturnValue({
      needsRedirect: false,
      redirectTo: "/deals/stages/stage-estimating?scope=team",
      backTo: "/deals?scope=team",
      query: {
        scope: "team",
        page: 1,
        pageSize: 25,
        sort: "newest",
        search: "",
        filters: { staleOnly: false },
      },
      onPageChange: vi.fn(),
    });

    mocks.useDealStagePageMock.mockReturnValue({
      loading: false,
      error: null,
      data: {
        stage: { id: "stage-estimating", name: "Estimating", slug: "estimating" },
        summary: { count: 1, totalValue: 15000, averageDaysInStage: 4 },
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
        rows: [
          {
            id: "deal-1",
            name: "North Campus",
            dealNumber: "TR-2026-0001",
            workflowRoute: "normal",
            assignedRepName: "Alex Rep",
            stageSlug: "estimating",
            onHold: false,
            bidBoardTotalSales: null,
            bidEstimate: "15000",
            ddEstimate: null,
            awardedAmount: null,
            daysInStage: 4,
            updatedAt: "2026-04-21T10:00:00.000Z",
          },
        ],
      },
    });
  });

  it("renders a paginated deal stage page with a canonical back link", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/deals/stages/stage-estimating?scope=team"]}>
        <Routes>
          <Route path="/deals/stages/:stageId" element={<DealStagePage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain("Back to board");
    expect(html).toContain("/deals?scope=team");
    expect(html).toContain("Stage value");
    expect(html).toContain("Avg. visible age");
    expect(html).toContain("North Campus");
    expect(html).toContain("Amount");
    expect(html).toContain("$15,000");
  });

  it("renders row amounts from the same effective value fields as the stage total", () => {
    mocks.useDealStagePageMock.mockReturnValue({
      loading: false,
      error: null,
      data: {
        stage: { id: "stage-estimating", name: "Estimating", slug: "estimating" },
        summary: { count: 3, totalValue: 12500, averageDaysInStage: 4 },
        pagination: { page: 1, pageSize: 25, total: 3, totalPages: 1 },
        rows: [
          {
            id: "deal-bid-board",
            name: "Bid Board Value",
            dealNumber: "TR-2026-0001",
            workflowRoute: "normal",
            assignedRepName: "Alex Rep",
            stageSlug: "estimating",
            onHold: false,
            bidBoardTotalSales: "10000",
            bidEstimate: "12000",
            ddEstimate: null,
            awardedAmount: null,
            daysInStage: 4,
            updatedAt: "2026-04-21T10:00:00.000Z",
          },
          {
            id: "deal-dd",
            name: "DD Fallback",
            dealNumber: "TR-2026-0002",
            workflowRoute: "normal",
            assignedRepName: "Alex Rep",
            stageSlug: "estimating",
            onHold: false,
            bidBoardTotalSales: null,
            bidEstimate: null,
            ddEstimate: "2500",
            awardedAmount: "9000",
            daysInStage: 2,
            updatedAt: "2026-04-22T10:00:00.000Z",
          },
          {
            id: "deal-zero",
            name: "Zero Value",
            dealNumber: "TR-2026-0003",
            workflowRoute: "service",
            assignedRepName: "Alex Rep",
            stageSlug: "estimating",
            onHold: false,
            bidBoardTotalSales: null,
            bidEstimate: null,
            ddEstimate: null,
            awardedAmount: null,
            daysInStage: 1,
            updatedAt: "2026-04-23T10:00:00.000Z",
          },
        ],
      },
    });

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/deals/stages/stage-estimating?scope=team"]}>
        <Routes>
          <Route path="/deals/stages/:stageId" element={<DealStagePage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain("Stage value");
    expect(html).toContain("$12.5K");
    expect(html).toContain("$10,000");
    expect(html).toContain("$2,500");
    expect(html).toContain("$0");
    expect(html).toContain('class="text-right"');
    expect(html).toContain('class="text-right font-semibold tabular-nums text-slate-950"');
  });

  it("renders won-stage row amounts with awarded-first value precedence", () => {
    mocks.useDealStagePageMock.mockReturnValue({
      loading: false,
      error: null,
      data: {
        stage: { id: "stage-won", name: "Won", slug: "service_complete" },
        summary: { count: 1, totalValue: 12000, averageDaysInStage: 1 },
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
        rows: [
          {
            id: "deal-won",
            name: "Won Deal",
            dealNumber: "TR-WON",
            workflowRoute: "service",
            assignedRepName: "Alex Rep",
            stageSlug: "service_complete",
            onHold: false,
            bidBoardTotalSales: "30000",
            bidEstimate: "25000",
            ddEstimate: "20000",
            awardedAmount: "12000",
            daysInStage: 1,
            updatedAt: "2026-04-21T10:00:00.000Z",
          },
        ],
      },
    });

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/deals/stages/stage-won?scope=team"]}>
        <Routes>
          <Route path="/deals/stages/:stageId" element={<DealStagePage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain("Won Deal");
    expect(html).toContain("$12,000");
    expect(html).not.toContain("$30,000");
  });

  it("renders value-desc sorted rows in API order with the amount column", () => {
    mocks.useNormalizedStageRouteMock.mockReturnValue({
      needsRedirect: false,
      redirectTo: "/deals/stages/stage-estimating?scope=team&sort=value_desc",
      backTo: "/deals?scope=team&sort=value_desc",
      query: {
        scope: "team",
        page: 1,
        pageSize: 25,
        sort: "value_desc",
        search: "",
        filters: { staleOnly: false },
      },
      onPageChange: vi.fn(),
    });
    mocks.useDealStagePageMock.mockImplementation((input: { sort: string }) => ({
      loading: false,
      error: null,
      data: {
        stage: { id: "stage-estimating", name: "Estimating", slug: "estimating" },
        summary: { count: 2, totalValue: 12000, averageDaysInStage: 3 },
        pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
        rows:
          input.sort === "value_desc"
            ? [
                {
                  id: "deal-high",
                  name: "High Value",
                  dealNumber: "TR-HIGH",
                  workflowRoute: "normal",
                  assignedRepName: "Alex Rep",
                  stageSlug: "estimating",
                  onHold: false,
                  bidBoardTotalSales: "9000",
                  bidEstimate: null,
                  ddEstimate: null,
                  awardedAmount: null,
                  daysInStage: 1,
                  updatedAt: "2026-04-21T10:00:00.000Z",
                },
                {
                  id: "deal-low",
                  name: "Low Value",
                  dealNumber: "TR-LOW",
                  workflowRoute: "normal",
                  assignedRepName: "Alex Rep",
                  stageSlug: "estimating",
                  onHold: false,
                  bidBoardTotalSales: null,
                  bidEstimate: "3000",
                  ddEstimate: null,
                  awardedAmount: null,
                  daysInStage: 1,
                  updatedAt: "2026-04-22T10:00:00.000Z",
                },
              ]
            : [],
      },
    }));

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/deals/stages/stage-estimating?scope=team&sort=value_desc"]}>
        <Routes>
          <Route path="/deals/stages/:stageId" element={<DealStagePage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(mocks.useDealStagePageMock).toHaveBeenCalledWith(expect.objectContaining({ sort: "value_desc" }));
    expect(html.indexOf("High Value")).toBeLessThan(html.indexOf("Low Value"));
    expect(html.indexOf("$9,000")).toBeLessThan(html.indexOf("$3,000"));
  });

  it("renders selected filter names instead of raw selected ids", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/deals/stages/stage-estimating?scope=team&regionId=region-1&assignedRepId=rep-1"]}>
        <Routes>
          <Route path="/deals/stages/:stageId" element={<DealStagePage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain("Dallas");
    expect(html).toContain("Alex Rep");
    expect(html).not.toContain(">region-1<");
    expect(html).not.toContain(">rep-1<");
  });

  it("does not render HS-prefixed imports as the stage row number", () => {
    mocks.useDealStagePageMock.mockReturnValue({
      loading: false,
      error: null,
      data: {
        stage: { id: "stage-estimating", name: "Estimating", slug: "estimating" },
        summary: { count: 1, totalValue: 15000, averageDaysInStage: 4 },
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
        rows: [
          {
            id: "deal-1",
            name: "North Campus",
            dealNumber: "HS-324283495135",
            projectNumber: "DFW-1-12826-aa",
            workflowRoute: "normal",
            assignedRepName: "Alex Rep",
            daysInStage: 4,
            updatedAt: "2026-04-21T10:00:00.000Z",
          },
        ],
      },
    });

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/deals/stages/stage-estimating?scope=team"]}>
        <Routes>
          <Route path="/deals/stages/:stageId" element={<DealStagePage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain("DFW-1-12826-aa");
    expect(html).not.toContain("HS-324283495135");
  });

  it("renders a stage error when the stage query fails", () => {
    mocks.useDealStagePageMock.mockReturnValue({
      data: null,
      loading: false,
      error: "Failed to load stage",
    });

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/deals/stages/stage-estimating?scope=team"]}>
        <Routes>
          <Route path="/deals/stages/:stageId" element={<DealStagePage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain("Failed to load stage");
  });
});
