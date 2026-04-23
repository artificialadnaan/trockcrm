import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  useDealStagePageMock: vi.fn(),
  useNormalizedStageRouteMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  useDealStagePage: mocks.useDealStagePageMock,
}));

vi.mock("@/lib/pipeline-scope", () => ({
  useNormalizedStageRoute: mocks.useNormalizedStageRouteMock,
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
  PipelineStageTable: ({ rows }: { rows: Array<{ name: string }> }) => <div>{rows.map((row) => row.name).join(", ")}</div>,
}));

import { DealStagePage } from "./deal-stage-page";

describe("DealStagePage", () => {
  beforeEach(() => {
    mocks.useNormalizedStageRouteMock.mockReturnValue({
      needsRedirect: false,
      redirectTo: "/deals/stages/stage-estimating?scope=team",
      backTo: "/deals?scope=team",
      query: {
        scope: "team",
        page: 1,
        pageSize: 25,
        sort: "age_desc",
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
        summary: { count: 1, totalValue: 15000 },
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
        rows: [
          {
            id: "deal-1",
            name: "North Campus",
            dealNumber: "TR-2026-0001",
            workflowRoute: "estimating",
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
