import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  useLeadStagePageMock: vi.fn(),
  useNormalizedStageRouteMock: vi.fn(),
}));

vi.mock("@/hooks/use-leads", () => ({
  useLeadStagePage: mocks.useLeadStagePageMock,
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

import { LeadStagePage } from "./lead-stage-page";

describe("LeadStagePage", () => {
  beforeEach(() => {
    mocks.useNormalizedStageRouteMock.mockReturnValue({
      needsRedirect: false,
      redirectTo: "/leads/stages/stage-contacted?scope=mine",
      backTo: "/leads?scope=mine",
      query: {
        scope: "mine",
        page: 1,
        pageSize: 25,
        sort: "age_desc",
        search: "",
        filters: { staleOnly: false },
      },
      onPageChange: vi.fn(),
    });

    mocks.useLeadStagePageMock.mockReturnValue({
      loading: false,
      error: null,
      data: {
        stage: { id: "stage-contacted", name: "Contacted", slug: "contacted" },
        summary: { count: 1 },
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
        rows: [
          {
            id: "lead-1",
            name: "Acme Facility",
            companyName: "Acme",
            source: "Referral",
            updatedAt: "2026-04-21T10:00:00.000Z",
          },
        ],
      },
    });
  });

  it("renders a paginated lead stage page with a canonical back link", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/leads/stages/stage-contacted?scope=mine"]}>
        <Routes>
          <Route path="/leads/stages/:stageId" element={<LeadStagePage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain("Back to board");
    expect(html).toContain("/leads?scope=mine");
    expect(html).toContain("Qualified pressure");
    expect(html).toContain("Avg. visible age");
    expect(html).toContain("Acme Facility");
  });

  it("renders a stage error when the stage query fails", () => {
    mocks.useLeadStagePageMock.mockReturnValue({
      data: null,
      loading: false,
      error: "Failed to load stage",
    });

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/leads/stages/stage-contacted?scope=mine"]}>
        <Routes>
          <Route path="/leads/stages/:stageId" element={<LeadStagePage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain("Failed to load stage");
  });
});
