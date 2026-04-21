import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProjectDetailPage } from "./project-detail-page";

const mocks = vi.hoisted(() => ({
  useProjectDetailMock: vi.fn(),
}));

vi.mock("@/hooks/use-projects", () => ({
  useProjectDetail: mocks.useProjectDetailMock,
}));

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/projects/deal-123"]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("ProjectDetailPage", () => {
  it("renders the project shell with the Tasks tab", () => {
    mocks.useProjectDetailMock.mockReturnValue({
      project: {
        id: "deal-123",
        deal_number: "TR-1001",
        name: "Birchstone North Tower",
        procore_project_id: 999,
        procore_last_synced_at: "2026-04-19T10:00:00.000Z",
        change_order_total: "12500",
        stage_name: "In Production",
        stage_color: "#0f766e",
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage();

    expect(mocks.useProjectDetailMock).toHaveBeenCalledWith("deal-123");
    expect(html).toContain("Birchstone North Tower");
    expect(html).toContain("TR-1001");
    expect(html).toContain("Project Surface");
    expect(html).toContain("Tasks");
    expect(html).toContain("Deal-backed project view for the existing Procore-linked record");
    expect(html).toContain("Open in Procore");
  });

  it("renders a not-found state when the project id cannot be resolved", () => {
    mocks.useProjectDetailMock.mockReturnValue({
      project: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage();

    expect(html).toContain("Project not found");
    expect(html).toContain("Back to Projects");
  });
});
