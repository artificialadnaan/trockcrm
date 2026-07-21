// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EstimatorPipelineReport } from "@trock-crm/shared/types";
import type { EstimatorDrillSelection } from "./estimator-pipeline/types";

const state = vi.hoisted(() => ({
  data: null as EstimatorPipelineReport | null,
  loading: false,
  error: null as string | null,
  refetch: vi.fn(),
  evidenceSelection: null as EstimatorDrillSelection | null,
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
  EstimatorEvidenceSheet: ({ selection }: { selection: EstimatorDrillSelection | null }) => {
    state.evidenceSelection = selection;
    return <div data-testid="estimator-evidence-sheet" />;
  },
}));

import { EstimatorPipelinePage } from "./estimator-pipeline-page";

const report: EstimatorPipelineReport = {
  generatedAt: "2026-07-13T15:00:00.000Z",
  scope: {
    kind: "active_office",
    cohort: "current_open_pipeline_plus_won_ytd",
    note: "Current open base projects plus projects won this calendar year in the active office.",
  },
  valueBasisLabel: "Best current estimate",
  valueBasisLabels: {
    open: "Best current estimate",
    won: "Awarded-first won value",
  },
  pipeline: { count: 9, value: 900_000 },
  won: { count: 3, value: 640_000 },
  wonPeriod: { from: "2026-01-01", to: "2026-07-13", label: "Won YTD" },
  stageColumns: [
    { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20 },
  ],
  estimators: [
    {
      key: "sidney-user",
      configuredName: "Sidney Gibson",
      estimatorUserId: "sidney-user",
      estimatorName: "Sidney Gibson",
      resolved: true,
      active: true,
      count: 4,
      value: 400_000,
      won: { count: 1, value: 250_000 },
      stages: [
        { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20, count: 4, value: 400_000 },
      ],
    },
    {
      key: "alex-user",
      configuredName: "Alex Koch",
      estimatorUserId: "alex-user",
      estimatorName: "Alex Koch",
      resolved: true,
      active: true,
      count: 2,
      value: 200_000,
      won: { count: 1, value: 200_000 },
      stages: [
        { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20, count: 2, value: 200_000 },
      ],
    },
  ],
  otherAssigned: {
    count: 1,
    value: 125_000,
    won: { count: 0, value: 0 },
    stages: [
      { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20, count: 1, value: 125_000 },
    ],
  },
  missingEstimator: {
    count: 2,
    value: 175_000,
    actionableCount: 1,
    actionableValue: 75_000,
    won: { count: 1, value: 190_000 },
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
  state.evidenceSelection = null;
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
  it("renders separate open and Won YTD totals for every assignment bucket", () => {
    renderPage();

    expect(container.textContent).toContain("Estimator Pipeline");
    expect(container.textContent).toContain("Open projects");
    expect(container.textContent).toContain("Won YTD");
    expect(container.textContent).toContain("$900,000");
    expect(container.textContent).toContain("$640,000");
    expect(buttonByAccessibleName("Show Sidney Gibson open pipeline: 4 projects, $400,000")).toBeTruthy();
    expect(buttonByAccessibleName("Show Sidney Gibson Won YTD: 1 project, $250,000")).toBeTruthy();
    expect(buttonByAccessibleName("Show Alex Koch open pipeline: 2 projects, $200,000")).toBeTruthy();
    expect(buttonByAccessibleName("Show Alex Koch Won YTD: 1 project, $200,000")).toBeTruthy();
    expect(buttonByAccessibleName("Show Other assigned open pipeline: 1 project, $125,000")).toBeTruthy();
    expect(buttonByAccessibleName("Show Missing estimator Won YTD: 1 project, $190,000")).toBeTruthy();
  });

  it("opens cohort-specific drills from the separate open and Won summary metrics", () => {
    renderPage();

    act(() => buttonByAccessibleName("Show Sidney Gibson open pipeline: 4 projects, $400,000")!.click());
    expect(state.evidenceSelection).toEqual({
      cohort: "open",
      bucket: "target",
      estimatorKey: "sidney-user",
      title: "Sidney Gibson",
      description: "Current open projects across every active pipeline stage.",
    });

    act(() => buttonByAccessibleName("Show Sidney Gibson Won YTD: 1 project, $250,000")!.click());
    expect(state.evidenceSelection).toEqual({
      cohort: "won",
      period: { from: "2026-01-01", to: "2026-07-13", label: "Won YTD" },
      bucket: "target",
      estimatorKey: "sidney-user",
      title: "Sidney Gibson: Won YTD",
      description: "Projects won from Jan 1, 2026 through Jul 13, 2026.",
    });
  });

  it("distinguishes the actionable missing subset from the total missing cohort", () => {
    renderPage();

    const missingCard = buttonByAccessibleName(
      "Show Missing estimator open pipeline: 2 projects, $175,000",
    );
    expect(missingCard?.textContent).toContain("2");
    expect(missingCard?.closest("article")?.textContent).toContain(
      "1 open project at Estimating or later needs assignment",
    );
    expect(missingCard?.closest("article")?.className).toContain("border-red-300");
  });

  it("renders the stage matrix and the report definition alongside the summaries", () => {
    renderPage();

    expect(container.textContent).toContain("Pipeline distribution");
    expect(container.querySelector("table caption")?.textContent).toContain("Estimator project counts");
    expect(container.textContent).toContain("How this report is defined");
    expect(container.textContent).toContain("Open cohort:");
    expect(container.textContent).toContain("Won cohort:");
    expect(container.textContent).toContain("Current open base projects plus projects won this calendar year");
  });

  it("surfaces every estimator identity warning without hiding the report", () => {
    state.data = {
      ...report,
      // Verbatim server warning strings (resolveTargets in estimator-pipeline-service.ts) so this exercises
      // what the report actually emits, not invented copy.
      warnings: [
        "Sidney Gibson could not be resolved to a CRM user. Check the report identity configuration.",
        "Alex Koch is inactive. Existing assignments remain visible and may need reassignment.",
      ],
    };

    renderPage();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Estimator identity check");
    expect(alert?.textContent).toContain(
      "Sidney Gibson could not be resolved to a CRM user. Check the report identity configuration.",
    );
    expect(alert?.textContent).toContain(
      "Alex Koch is inactive. Existing assignments remain visible and may need reassignment.",
    );
    expect(container.textContent).toContain("Pipeline distribution");
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
