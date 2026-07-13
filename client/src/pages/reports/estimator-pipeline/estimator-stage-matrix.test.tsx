// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EstimatorPipelineReport } from "@trock-crm/shared/types";
import { EstimatorStageMatrix } from "./estimator-stage-matrix";
import type { EstimatorDrillSelection } from "./types";

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
    { stageSlug: "due-diligence", stageLabel: "Due Diligence", displayOrder: 10 },
    { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20 },
  ],
  estimators: [
    {
      key: "sidney_gibson",
      configuredName: "Sidney Gibson",
      estimatorUserId: "estimator-sidney",
      estimatorName: "Sidney Gibson",
      resolved: true,
      active: true,
      count: 4,
      value: 400_000,
      stages: [
        { stageSlug: "due-diligence", stageLabel: "Due Diligence", displayOrder: 10, count: 1, value: 100_000 },
        { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20, count: 3, value: 300_000 },
      ],
    },
    {
      key: "alex_koch",
      configuredName: "Alex Koch",
      estimatorUserId: "estimator-alex",
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
      { stageSlug: "due-diligence", stageLabel: "Due Diligence", displayOrder: 10, count: 1, value: 125_000 },
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderMatrix(overrides: Partial<EstimatorPipelineReport> = {}) {
  const onDrill = vi.fn<(selection: EstimatorDrillSelection) => void>();
  act(() => {
    root.render(<EstimatorStageMatrix report={{ ...report, ...overrides }} onDrill={onDrill} />);
  });
  return onDrill;
}

function buttonByName(name: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.getAttribute("aria-label") === name,
  );
  if (!button) throw new Error(`No button with aria-label: ${name}`);
  return button as HTMLButtonElement;
}

describe("EstimatorStageMatrix", () => {
  it("renders the server-provided stage order and every assignment bucket in a scrollable semantic table", () => {
    renderMatrix();

    const headers = Array.from(container.querySelectorAll("thead th")).map((cell) => cell.textContent?.trim());
    expect(headers).toEqual(["Assignment", "Due Diligence", "Estimating", "Total"]);
    expect(container.textContent).toContain("Sidney Gibson");
    expect(container.textContent).toContain("Alex Koch");
    expect(container.textContent).toContain("Other assigned");
    expect(container.textContent).toContain("Missing estimator");
    expect(container.querySelector("caption")?.textContent).toContain("Estimator project counts");
    expect(container.querySelector('[data-testid="scrollsync-body"]')).not.toBeNull();
    expect(container.querySelector("table")?.className).toContain("min-w-[980px]");
  });

  it("drills a nonzero estimator-stage cell using the stable estimator key and exact stage slug", () => {
    const onDrill = renderMatrix();
    const button = buttonByName(
      "Show 3 Sidney Gibson in Estimating projects with $300,000 in pipeline value",
    );

    act(() => button.click());

    expect(onDrill).toHaveBeenCalledWith({
      bucket: "target",
      estimatorKey: "sidney_gibson",
      stageSlug: "estimating",
      title: "Sidney Gibson: Estimating",
      description: "Current active projects in Estimating.",
    });
  });

  it("drills the Missing estimator total without inventing an estimator key or stage filter", () => {
    const onDrill = renderMatrix();
    const button = buttonByName(
      "Show 2 Missing estimator across all stages projects with $175,000 in pipeline value",
    );

    act(() => button.click());

    expect(onDrill).toHaveBeenCalledWith({
      bucket: "missing",
      estimatorKey: undefined,
      title: "Missing estimator",
      description: "Current active projects across every open pipeline stage.",
    });
  });

  it("keeps zero cells visible for comparison but non-interactive", () => {
    renderMatrix();

    expect(
      container.querySelector('button[aria-label*="Alex Koch in Due Diligence"]'),
    ).toBeNull();
    const zeroMetric = container.querySelector('[aria-label="Alex Koch in Due Diligence: 0 projects, $0"]');
    expect(zeroMetric).not.toBeNull();
    expect(zeroMetric?.textContent).toContain("0");
    expect(container.textContent).not.toContain("NaN");
  });

  it("does not offer evidence drills for an unresolved configured estimator", () => {
    renderMatrix({
      estimators: [
        {
          ...report.estimators[0],
          estimatorUserId: null,
          resolved: false,
          active: null,
        },
        report.estimators[1],
      ],
    });

    expect(container.textContent).toContain("CRM identity not resolved");
    expect(container.querySelector('button[aria-label*="Sidney Gibson"]')).toBeNull();
    expect(container.querySelector('[aria-label="Sidney Gibson across all stages: 4 projects, $400,000"]')).not.toBeNull();
  });

  it("shows a focused empty state when no active stage columns exist", () => {
    renderMatrix({ stageColumns: [] });

    expect(container.textContent).toContain("No active pipeline stages contain projects in this office.");
    expect(container.querySelector("table")).toBeNull();
  });
});
