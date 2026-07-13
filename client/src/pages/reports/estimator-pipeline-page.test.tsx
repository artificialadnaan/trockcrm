// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EstimatorPipelineReport } from "@trock-crm/shared/types";

const state = vi.hoisted(() => ({
  data: null as EstimatorPipelineReport | null,
  loading: false,
  error: null as string | null,
  refetch: vi.fn(),
}));

vi.mock("@/hooks/use-estimator-pipeline-report", () => ({
  useEstimatorPipelineReport: () => ({
    data: state.data,
    loading: state.loading,
    error: state.error,
    refetch: state.refetch,
  }),
}));

vi.mock("./estimator-pipeline/estimator-evidence-sheet", () => ({
  EstimatorEvidenceSheet: () => <div data-testid="estimator-evidence-sheet" />,
}));

import { EstimatorPipelinePage } from "./estimator-pipeline-page";

const report: EstimatorPipelineReport = {
  generatedAt: "2026-07-13T15:00:00.000Z",
  scope: {
    kind: "active_office",
    cohort: "current_open_pipeline",
    note: "Current open base projects in the active office.",
  },
  valueBasisLabel: "Best current estimate",
  pipeline: { count: 9, value: 900_000 },
  stageColumns: [
    { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20 },
  ],
  estimators: [
    {
      key: "sidney_gibson",
      configuredName: "Sidney Gibson",
      estimatorUserId: "sidney-user",
      estimatorName: "Sidney Gibson",
      resolved: true,
      active: true,
      count: 4,
      value: 400_000,
      stages: [
        { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20, count: 4, value: 400_000 },
      ],
    },
    {
      key: "alex_koch",
      configuredName: "Alex Koch",
      estimatorUserId: "alex-user",
      estimatorName: "Alex Koch",
      resolved: true,
      active: true,
      count: 2,
      value: 200_000,
      stages: [
        { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20, count: 2, value: 200_000 },
      ],
    },
  ],
  otherAssigned: {
    count: 1,
    value: 125_000,
    stages: [
      { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20, count: 1, value: 125_000 },
    ],
  },
  missingEstimator: {
    count: 2,
    value: 175_000,
    actionableCount: 1,
    actionableValue: 75_000,
    stages: [
      { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20, count: 2, value: 175_000 },
    ],
  },
  warnings: [],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  state.data = report;
  state.loading = false;
  state.error = null;
  state.refetch.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderPage() {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/reports/operations/estimator-pipeline?officeId=office-dallas"]}>
        <EstimatorPipelinePage />
      </MemoryRouter>,
    );
  });
}

function buttonByAccessibleName(name: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.getAttribute("aria-label") === name,
  );
}

describe("EstimatorPipelinePage", () => {
  it("renders target, other-assigned, and missing-estimator summaries with their exact totals", () => {
    renderPage();

    expect(container.textContent).toContain("Estimator Pipeline");
    expect(container.textContent).toContain("9");
    expect(container.textContent).toContain("$900,000");
    expect(buttonByAccessibleName("Show 4 Sidney Gibson projects with $400,000 in pipeline value")).toBeTruthy();
    expect(buttonByAccessibleName("Show 2 Alex Koch projects with $200,000 in pipeline value")).toBeTruthy();
    expect(buttonByAccessibleName("Show 1 Other assigned projects with $125,000 in pipeline value")).toBeTruthy();
    expect(buttonByAccessibleName("Show 2 Missing estimator projects with $175,000 in pipeline value")).toBeTruthy();
  });

  it("distinguishes the actionable missing subset from the total missing cohort", () => {
    renderPage();

    const missingCard = buttonByAccessibleName(
      "Show 2 Missing estimator projects with $175,000 in pipeline value",
    );
    expect(missingCard?.textContent).toContain("2 projects");
    expect(missingCard?.textContent).toContain("1 at Estimating or later need assignment");
    expect(missingCard?.className).toContain("border-red-300");
  });

  it("renders the stage matrix and the report definition alongside the summaries", () => {
    renderPage();

    expect(container.textContent).toContain("Current pipeline by stage");
    expect(container.querySelector("table caption")?.textContent).toContain("Estimator project counts");
    expect(container.textContent).toContain("How this report is defined");
    expect(container.textContent).toContain("Current open base projects in the active office.");
  });

  it("surfaces every estimator identity warning without hiding the report", () => {
    state.data = {
      ...report,
      warnings: [
        "Sidney Gibson could not be resolved to an active CRM user.",
        "Alex Koch is currently inactive.",
      ],
    };

    renderPage();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Estimator identity check");
    expect(alert?.textContent).toContain("Sidney Gibson could not be resolved to an active CRM user.");
    expect(alert?.textContent).toContain("Alex Koch is currently inactive.");
    expect(container.textContent).toContain("Current pipeline by stage");
  });

  it("shows the load error and retries through the report hook", () => {
    state.data = null;
    state.error = "Report service unavailable";

    renderPage();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("The estimator report could not be loaded.");
    expect(alert?.textContent).toContain("Report service unavailable");
    const retry = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Try again"),
    ) as HTMLButtonElement | undefined;
    expect(retry).toBeTruthy();

    act(() => retry!.click());

    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
});
