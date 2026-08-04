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
  "estimating",
  "pre-construction",
  "buyout",
  "contract executed",
  "in production",
  "close out",
  "close out - final invoice",
  "closed",
  "service - estimating",
  "service - in production",
  "service - close out",
  "service - close out final invoice",
  "service - lost",
];

function boardResponse(
  projects: Array<Record<string, unknown>> = [],
  overrides: { stages?: Array<Record<string, unknown>> } = {},
) {
  return {
    stages: overrides.stages ?? stageNames.map((stage) => ({
      stage,
      label: stage.replace(/\b\w/g, (char) => char.toUpperCase()),
      totalValue: 0,
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
    vi.useRealTimers();
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

    // Pin the clock so the synced date (May 25) is <7 days old -> non-stale "As of" label, regardless
    // of when CI runs. Fake only Date so vi.waitFor / async React render stay real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-26T12:00:00.000Z"));

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

  it("renders the Other / No Column bucket so unmapped projects stay visible", async () => {
    const surprise = {
      id: "00000000-0000-4000-8000-000000000009",
      procoreProjectId: "9",
      procoreCompanyId: "co",
      projectNumber: "PN-9",
      name: "Brand New Procore Stage",
      currentStage: "Warranty - Punch List",
      currentStageNormalized: "warranty - punch list",
      currentStageEnteredAt: null,
      totalValue: 777,
      valueSyncedAt: null,
      firstSeenAt: "2026-05-18T12:00:00.000Z",
      updatedAt: "2026-05-21T12:00:00.000Z",
    };
    mocks.api.mockResolvedValue(
      boardResponse([surprise], {
        stages: [
          ...stageNames.map((stage) => ({
            stage,
            label: stage.replace(/\b\w/g, (char) => char.toUpperCase()),
            totalValue: 0,
            projects: [],
          })),
          { stage: "unmapped", label: "Other / No Column", totalValue: 777, projects: [surprise] },
        ],
      }),
    );

    await act(async () => {
      root.render(
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>,
      );
    });

    await vi.waitFor(() => expect(container.textContent).toContain("Brand New Procore Stage"));
    const column = container.querySelector('[aria-label="Other / No Column projects"]');
    expect(column).not.toBeNull();
    expect(column!.textContent).toContain("Unmapped");
    expect(column!.textContent).toContain("Stages with no board column of their own");
    // Counted in the board header total too, not just shown.
    expect(container.textContent).toContain("1 project");
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
    // Scoped to the project CARD: stage/summary totals elsewhere on the page legitimately render
    // "$0", but a project whose value never synced must never be dressed up as a real $0.
    const card = container.querySelector('a[href="/projects/00000000-0000-4000-8000-000000000001"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("Value not synced");
    expect(card!.textContent).not.toContain("$0");
  });
});
