// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsPage } from "./projects-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.api,
}));

const stageNames = [
  "bidding",
  "buyout",
  "close out",
  "close out - final invoice",
  "closed",
  "contract executed",
  "in production",
];

function boardResponse(projects: Array<Record<string, unknown>> = []) {
  return {
    stages: stageNames.map((stage) => ({
      stage,
      label: stage.replace(/\b\w/g, (char) => char.toUpperCase()),
      projects: projects.filter((project) => project.currentStageNormalized === stage),
    })),
    projects,
  };
}

describe("ProjectsPage", () => {
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

  it("renders every board stage and clean empty-column states", async () => {
    mocks.api.mockResolvedValue(boardResponse());

    await act(async () => {
      root.render(
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>,
      );
    });

    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledWith("/projects/board"));
    for (const stage of stageNames) {
      expect(container.textContent).toContain(stage.replace(/\b\w/g, (char) => char.toUpperCase()));
    }
    expect(container.textContent?.match(/No projects in this stage\./g)).toHaveLength(stageNames.length);
  });

  it("renders project cards in the stage data returned by the board endpoint", async () => {
    mocks.api.mockResolvedValue(
      boardResponse([
        {
          id: "00000000-0000-4000-8000-000000000001",
          procoreProjectId: "598134326469086",
          procoreCompanyId: "598134325683880",
          projectNumber: "DFW-4-07826-ac",
          name: "Portfolio Roof Replacement",
          currentStage: "closed",
          currentStageNormalized: "closed",
          currentStageEnteredAt: "2026-05-20T12:00:00.000Z",
          totalValue: 9716.67,
          valueSyncedAt: "2026-05-25T09:34:15.318Z",
          firstSeenAt: "2026-05-18T12:00:00.000Z",
          updatedAt: "2026-05-21T12:00:00.000Z",
        },
      ]),
    );

    await act(async () => {
      root.render(
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>,
      );
    });

    await vi.waitFor(() => expect(container.textContent).toContain("Portfolio Roof Replacement"));
    expect(container.textContent).toContain("DFW-4-07826-ac");
    expect(container.textContent).toContain("Contract Value");
    expect(container.textContent).toContain("$9,717");
    expect(container.textContent).toContain("As of May 25, 2026");
    expect(container.querySelector('a[href="/projects/00000000-0000-4000-8000-000000000001"]')).not.toBeNull();
    expect(container.querySelector("[draggable]")).toBeNull();
  });

  it("renders project value absence without showing a fake zero", async () => {
    mocks.api.mockResolvedValue(
      boardResponse([
        {
          id: "00000000-0000-4000-8000-000000000001",
          procoreProjectId: "598134326469086",
          procoreCompanyId: "598134325683880",
          projectNumber: "DFW-4-07826-ac",
          name: "Portfolio Roof Replacement",
          currentStage: "closed",
          currentStageNormalized: "closed",
          currentStageEnteredAt: "2026-05-20T12:00:00.000Z",
          totalValue: null,
          valueSyncedAt: null,
          firstSeenAt: "2026-05-18T12:00:00.000Z",
          updatedAt: "2026-05-21T12:00:00.000Z",
        },
      ]),
    );

    await act(async () => {
      root.render(
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>,
      );
    });

    await vi.waitFor(() => expect(container.textContent).toContain("Portfolio Roof Replacement"));
    expect(container.textContent).toContain("Value not synced");
    expect(container.textContent).not.toContain("$0");
  });
});
