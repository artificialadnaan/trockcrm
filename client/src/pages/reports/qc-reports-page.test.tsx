// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useQcScorecards: vi.fn(),
  fetchDealScorecardDetail: vi.fn(),
  leadershipDetailView: vi.fn(),
  scorecardDetailView: vi.fn(),
}));

vi.mock("@/hooks/use-qc-scorecards", () => ({
  useQcScorecards: mocks.useQcScorecards,
}));
vi.mock("@/hooks/use-deal-scorecards", () => ({
  fetchDealScorecardDetail: mocks.fetchDealScorecardDetail,
  downloadDealScorecardPdf: vi.fn(),
}));
vi.mock("@/pages/deals/deal-scorecards-tab", () => ({
  LeadershipDetailView: (props: unknown) => {
    mocks.leadershipDetailView(props);
    return null;
  },
  ScorecardDetailView: (props: unknown) => {
    mocks.scorecardDetailView(props);
    return null;
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import QcReportsPage from "./qc-reports-page";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.useQcScorecards.mockReset();
  mocks.fetchDealScorecardDetail.mockReset();
  mocks.leadershipDetailView.mockReset();
  mocks.scorecardDetailView.mockReset();
  mocks.fetchDealScorecardDetail.mockImplementation((_dealId: string, scorecardId: string) =>
    Promise.resolve({ scorecardId }),
  );
  mocks.useQcScorecards.mockReturnValue({
    scorecards: [
      {
        scorecardId: "leadership-1",
        dealId: "deal-1",
        projectName: "Leadership Job",
        projectNumber: "DFW-101",
        regionName: "Dallas",
        superintendentName: "Adam Shaw",
        kind: "leadership",
        totalScore: 85,
        formVersion: 2,
        averageScore: 8.5,
        rating: "on_standard",
        deficiencyCount: 0,
        weekOf: "2026-07-14",
        submittedAt: "2026-07-14T18:34:03.000Z",
        submittedByName: "Adam Shaw",
        pdfAvailable: true,
      },
      {
        scorecardId: "project-1",
        dealId: "deal-2",
        projectName: "Project Job",
        projectNumber: "DFW-102",
        regionName: "Dallas",
        superintendentName: "Sam Reyes",
        kind: "project",
        totalScore: 86,
        formVersion: 1,
        averageScore: null,
        rating: "on_standard",
        deficiencyCount: 0,
        weekOf: "2026-07-14",
        submittedAt: "2026-07-14T17:00:00.000Z",
        submittedByName: "Sam Reyes",
        pdfAvailable: true,
        status: "corrective_action_open",
      },
    ],
    regions: ["Dallas"],
    superintendents: ["Adam Shaw", "Sam Reyes"],
    truncated: false,
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("QcReportsPage", () => {
  it("shows project and leadership cards together with a report-type filter and kind-aware labels", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/projects/qc-reports?officeId=office-dallas"]}>
          <QcReportsPage />
        </MemoryRouter>,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Project and Leadership Scorecards");
    expect(text).toContain("Leadership Job");
    expect(text).toContain("Project Job");
    expect(text).toContain("Leadership");
    expect(text).toContain("Project");
    expect(text).toContain("Meets Standard");
    expect(text).toContain("On Standard");

    const typeFilter = Array.from(container.querySelectorAll("select")).find((select) =>
      Array.from(select.options).some((option) => option.textContent === "All scorecards"),
    );
    expect(typeFilter).toBeTruthy();
    expect(Array.from(typeFilter!.options).map((option) => option.textContent)).toEqual([
      "All scorecards",
      "Project",
      "Leadership",
    ]);
  });

  it("renders the Corrective Action status column + filter", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/projects/qc-reports?officeId=office-dallas"]}>
          <QcReportsPage />
        </MemoryRouter>,
      );
    });

    const text = container.textContent ?? "";
    // The column header + the open pill for the project row.
    expect(text).toContain("Corrective Action");
    expect(text).toContain("Open");

    // A dedicated Any-status filter dropdown offering Open / Closed.
    const caFilter = Array.from(container.querySelectorAll("select")).find((select) =>
      Array.from(select.options).some((option) => option.textContent === "Any status"),
    );
    expect(caFilter).toBeTruthy();
    expect(Array.from(caFilter!.options).map((o) => o.textContent)).toEqual(["Any status", "Open", "Closed"]);
  });

  it.each([
    {
      kind: "leadership",
      projectName: "Leadership Job",
      expectedRenderer: "leadershipDetailView",
      unexpectedRenderer: "scorecardDetailView",
    },
    {
      kind: "project",
      projectName: "Project Job",
      expectedRenderer: "scorecardDetailView",
      unexpectedRenderer: "leadershipDetailView",
    },
  ] as const)("renders the $kind detail view when its row is opened", async ({
    kind,
    projectName,
    expectedRenderer,
    unexpectedRenderer,
  }) => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/projects/qc-reports?officeId=office-dallas"]}>
          <QcReportsPage />
        </MemoryRouter>,
      );
    });

    const row = container.querySelector(`[aria-label^="Open ${kind} scorecard for ${projectName},"]`);
    expect(row).toBeTruthy();

    await act(async () => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.fetchDealScorecardDetail).toHaveBeenCalledWith(
      kind === "leadership" ? "deal-1" : "deal-2",
      kind === "leadership" ? "leadership-1" : "project-1",
    );
    expect(mocks[expectedRenderer]).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({
        scorecardId: kind === "leadership" ? "leadership-1" : "project-1",
      }),
    }));
    expect(mocks[unexpectedRenderer]).not.toHaveBeenCalled();
  });
});
