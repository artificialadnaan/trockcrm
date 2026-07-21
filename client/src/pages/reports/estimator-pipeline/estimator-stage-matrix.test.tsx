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
    cohort: "current_open_pipeline_plus_won_ytd",
    note: "Current open base projects plus projects won this calendar year.",
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
    { stageSlug: "due-diligence", stageLabel: "Due Diligence", displayOrder: 10 },
    { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20 },
  ],
  estimators: [
    {
      key: "estimator-sidney",
      configuredName: "Sidney Gibson",
      estimatorUserId: "estimator-sidney",
      estimatorName: "Sidney Gibson",
      resolved: true,
      active: true,
      count: 4,
      value: 400_000,
      won: { count: 1, value: 250_000 },
      stages: [
        { stageSlug: "due-diligence", stageLabel: "Due Diligence", displayOrder: 10, count: 1, value: 100_000 },
        { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20, count: 3, value: 300_000 },
      ],
    },
    {
      key: "estimator-alex",
      configuredName: "Alex Koch",
      estimatorUserId: "estimator-alex",
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
      { stageSlug: "due-diligence", stageLabel: "Due Diligence", displayOrder: 10, count: 1, value: 125_000 },
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

function buttonByName(name: string, scope: ParentNode = container): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (candidate) => candidate.getAttribute("aria-label") === name,
  );
  if (!button) throw new Error(`No button with aria-label: ${name}`);
  return button as HTMLButtonElement;
}

describe("EstimatorStageMatrix", () => {
  it("renders ordered open stages, a separate Won column, and every assignment bucket without horizontal scrolling", () => {
    renderMatrix();

    const desktop = container.querySelector('[data-testid="estimator-stage-table"]') as HTMLElement;
    const cards = container.querySelector('[data-testid="estimator-stage-cards"]') as HTMLElement;
    const headers = Array.from(desktop.querySelectorAll("thead th")).map((cell) => cell.textContent?.trim());
    expect(headers).toEqual(["Assignment", "Due Diligence", "Estimating", "Open total", "Won YTD"]);
    expect(container.textContent).toContain("Sidney Gibson");
    expect(container.textContent).toContain("Alex Koch");
    expect(container.textContent).toContain("Other assigned");
    expect(container.textContent).toContain("Missing estimator");
    expect(desktop.querySelector("caption")?.textContent).toContain("open pipeline stage and Won YTD");
    expect(desktop.className).toContain("xl:block");
    expect(desktop.querySelector("table")?.className).toContain("table-fixed");
    expect(cards.className).toContain("xl:hidden");
    expect(cards.querySelectorAll("article")).toHaveLength(4);
    expect(container.querySelector('[data-testid="scrollsync-body"]')).toBeNull();
    expect(container.innerHTML).not.toContain("min-w-[980px]");
    expect(container.innerHTML).not.toContain("overflow-x-auto");
  });

  it("drills a nonzero estimator-stage cell using the stable estimator key and exact stage slug", () => {
    const onDrill = renderMatrix();
    const button = buttonByName(
      "Show 3 projects for Sidney Gibson in Estimating with $300,000",
    );

    act(() => button.click());

    expect(onDrill).toHaveBeenCalledWith({
      cohort: "open",
      bucket: "target",
      estimatorKey: "estimator-sidney",
      stageSlug: "estimating",
      title: "Sidney Gibson: Estimating",
      description: "Current open projects in Estimating.",
    });
  });

  it("drills Won YTD independently from the open stages and open total", () => {
    const onDrill = renderMatrix();
    const desktop = container.querySelector('[data-testid="estimator-stage-table"]')!;
    const button = buttonByName(
      "Show 1 project for Sidney Gibson Won YTD with $250,000",
      desktop,
    );

    act(() => button.click());

    expect(onDrill).toHaveBeenCalledWith({
      cohort: "won",
      period: { from: "2026-01-01", to: "2026-07-13", label: "Won YTD" },
      bucket: "target",
      estimatorKey: "estimator-sidney",
      title: "Sidney Gibson: Won YTD",
      description: "Projects won from Jan 1, 2026 through Jul 13, 2026.",
    });
    expect(button.className).toContain("bg-emerald-50");
  });

  it("drills the Missing estimator total without inventing an estimator key or stage filter", () => {
    const onDrill = renderMatrix();
    const button = buttonByName(
      "Show 2 projects for Missing estimator open pipeline with $175,000",
    );

    act(() => button.click());

    expect(onDrill).toHaveBeenCalledWith({
      cohort: "open",
      bucket: "missing",
      estimatorKey: undefined,
      title: "Missing estimator",
      description: "Current open projects across every active pipeline stage.",
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
    expect(container.querySelector('[aria-label="Sidney Gibson open pipeline: 4 projects, $400,000"]')).not.toBeNull();
  });

  it("shows a focused empty state when no active stage columns exist", () => {
    renderMatrix({ stageColumns: [], won: { count: 0, value: 0 } });

    expect(container.textContent).toContain("No open or Won YTD projects are assigned in this office.");
    expect(container.querySelector("table")).toBeNull();
  });
});
