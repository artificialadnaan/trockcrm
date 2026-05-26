// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import projectDetailSource from "./project-detail-page.tsx?raw";
import { ProjectDetailPage } from "./project-detail-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.api,
}));

function normalize(source: string) {
  return source.replace(/\s+/g, " ");
}

const baseProject = {
  id: "00000000-0000-4000-8000-000000000001",
  procoreProjectId: "598134326521913",
  procoreCompanyId: "598134325683880",
  projectNumber: "DFW-4-07826-ac",
  name: "Portfolio Roof Replacement",
  currentStage: "close out",
  currentStageNormalized: "close out",
  currentStageEnteredAt: "2026-05-12T12:00:00.000Z",
  totalValue: 125000.75,
  valueSyncedAt: "2026-05-25T09:34:15.318Z",
  firstSeenAt: "2026-05-11T12:00:00.000Z",
  updatedAt: "2026-05-13T12:00:00.000Z",
  lastStageEventKey: "portfolio-seed:598134325683880:598134326521913:close out",
  rawSnapshot: {},
  stageHistory: [],
};

function detailResponse(project: Record<string, unknown>) {
  return { project };
}

describe("ProjectDetailPage shell", () => {
  const source = normalize(projectDetailSource);

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.api.mockReset();
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
  });

  async function renderDetail(project: Record<string, unknown> = baseProject) {
    mocks.api.mockResolvedValue(detailResponse(project));

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/projects/00000000-0000-4000-8000-000000000001"]}>
          <Routes>
            <Route path="/projects/:id" element={<ProjectDetailPage />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledWith("/projects/00000000-0000-4000-8000-000000000001"));
    await vi.waitFor(() => expect(container.textContent).toContain(project.name));
  }

  it("includes loading, not-found, back navigation, and read-only portfolio details", () => {
    expect(source).toContain("Projects");
    expect(source).toContain("Back to Projects");
    expect(source).toContain("Project not found");
    expect(source).toContain("Project References");
    expect(source).toContain("Stage History");
    expect(source).toContain("Contract Value");
    expect(source).toContain("Value Freshness");
    expect(source).toContain("Procore Project ID");
    expect(source).not.toContain('role="tab"');
    expect(source).not.toContain("method: \"PATCH\"");
    expect(source).not.toContain("method: \"POST\"");
  });

  it("shows a human-readable latest stage change instead of the raw event key", async () => {
    await renderDetail();

    expect(container.textContent).toContain("Latest Stage Change");
    expect(container.textContent).toContain("Entered Close Out on May 12, 2026");
    expect(container.textContent).toContain("$125,001");
    expect(container.textContent).toContain("As of May 25, 2026");
    expect(container.textContent).not.toContain(baseProject.lastStageEventKey);
    expect(source).not.toContain("Last Stage Event");
    expect(source).not.toContain("lastStageEventKey");
  });

  it("links to Procore project home when Procore ids are available", async () => {
    await renderDetail();

    const expectedUrl =
      "https://us02.procore.com/webclients/host/companies/598134325683880/projects/598134326521913/tools/projecthome";
    const link = container.querySelector<HTMLAnchorElement>(`a[href="${expectedUrl}"]`);

    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("View in Procore");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noopener");
    expect(link?.rel).toContain("noreferrer");
  });

  it("hides the Procore link when either Procore id is missing", async () => {
    await renderDetail({ ...baseProject, procoreProjectId: "" });

    expect(container.textContent).not.toContain("View in Procore");
    expect(container.querySelector('a[href*="procore.com"]')).toBeNull();
  });

  it("shows absent contract value without rendering a fake zero", async () => {
    await renderDetail({ ...baseProject, totalValue: null, valueSyncedAt: null });

    expect(container.textContent).toContain("Value not synced");
    expect(container.textContent).not.toContain("$0");
  });
});
