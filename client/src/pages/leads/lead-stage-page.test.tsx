import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
    expect(html).toContain("Acme Facility");
  });
});
