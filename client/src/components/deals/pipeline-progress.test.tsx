// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineProgress, type PipelineProgressStage } from "./pipeline-progress";

const standardStages: PipelineProgressStage[] = [
  { id: "stage-opportunity", name: "Opportunity", slug: "opportunity", displayOrder: 0, isTerminal: false },
  { id: "stage-estimating", name: "Estimating", slug: "estimating", displayOrder: 1, isTerminal: false },
  { id: "stage-under-review", name: "Under Review", slug: "estimate_under_review", displayOrder: 2, isTerminal: false },
  { id: "stage-sent", name: "Estimate Sent", slug: "estimate_sent_to_client", displayOrder: 3, isTerminal: false },
  { id: "stage-contract", name: "Contract", slug: "contract", displayOrder: 4, isTerminal: false },
  { id: "stage-won", name: "Won", slug: "won", displayOrder: 5, isTerminal: true },
  { id: "stage-lost", name: "Lost", slug: "lost", displayOrder: 6, isTerminal: true },
];

function serviceStages(): PipelineProgressStage[] {
  return standardStages.map((stage) =>
    stage.slug === "estimating"
      ? { ...stage, id: "stage-service-estimating", name: "Service Estimating", slug: "service_estimating" }
      : stage
  );
}

function mount(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  act(() => {
    root = createRoot(container);
    root.render(ui);
  });

  return {
    container,
    unmount() {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

describe("PipelineProgress", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("renders the standard deal flow with the current stage highlighted", () => {
    const html = renderToStaticMarkup(
      <PipelineProgress
        stages={standardStages}
        currentStageId="stage-under-review"
        workflowRoute="normal"
        isBidBoardOwned={false}
        handoffStageDisplayOrder={null}
        canMoveBackward
        onStageClick={() => undefined}
      />
    );

    expect(html).toContain("Pipeline progress");
    expect(html).toContain("Opportunity");
    expect(html).toContain("Estimating");
    expect(html).toContain("Under Review");
    expect(html).toContain("Estimate Sent");
    expect(html).toContain("Contract");
    expect(html).toContain("Won");
    expect(html).toContain("Lost");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('data-stage-slug="estimate_under_review"');
    expect(html).toContain('data-state="current"');
  });

  it("renders service estimating instead of standard estimating for service deals", () => {
    const html = renderToStaticMarkup(
      <PipelineProgress
        stages={serviceStages()}
        currentStageId="stage-service-estimating"
        workflowRoute="service"
        isBidBoardOwned={false}
        handoffStageDisplayOrder={null}
        canMoveBackward
        onStageClick={() => undefined}
      />
    );

    expect(html).toContain("Service Estimating");
    expect(html).not.toContain(">Estimating<");
    expect(html).toContain('data-state="current"');
  });

  it("marks terminal stages correctly when the deal is currently won or lost", () => {
    const wonHtml = renderToStaticMarkup(
      <PipelineProgress
        stages={standardStages}
        currentStageId="stage-won"
        workflowRoute="normal"
        isBidBoardOwned={false}
        handoffStageDisplayOrder={null}
        canMoveBackward
        onStageClick={() => undefined}
      />
    );

    expect(wonHtml).toContain('data-stage-slug="won"');
    expect(wonHtml).toContain('data-state="current"');

    const lostHtml = renderToStaticMarkup(
      <PipelineProgress
        stages={standardStages}
        currentStageId="stage-lost"
        workflowRoute="normal"
        isBidBoardOwned={false}
        handoffStageDisplayOrder={null}
        canMoveBackward
        onStageClick={() => undefined}
      />
    );

    expect(lostHtml).toContain('data-stage-slug="lost"');
    expect(lostHtml).toContain('data-stage-slug="won"');
    expect(lostHtml).toContain('data-disabled-reason="terminal-passed"');
  });

  it("disables Bid Board-managed stages after the handoff boundary", () => {
    const html = renderToStaticMarkup(
      <PipelineProgress
        stages={standardStages}
        currentStageId="stage-estimating"
        workflowRoute="normal"
        isBidBoardOwned
        handoffStageDisplayOrder={1}
        canMoveBackward
        onStageClick={() => undefined}
      />
    );

    expect(html).toContain('data-stage-slug="estimate_under_review"');
    expect(html).toContain('data-disabled-reason="bid-board-managed"');
  });

  it("disables backward stage movement for non-director users", () => {
    const html = renderToStaticMarkup(
      <PipelineProgress
        stages={standardStages}
        currentStageId="stage-contract"
        workflowRoute="normal"
        isBidBoardOwned={false}
        handoffStageDisplayOrder={null}
        canMoveBackward={false}
        onStageClick={() => undefined}
      />
    );

    expect(html).toContain('data-stage-slug="estimate_sent_to_client"');
    expect(html).toContain('data-disabled-reason="backward-restricted"');
  });

  it("opens the stage-change flow when an enabled stage is clicked", () => {
    const onStageClick = vi.fn();
    const rendered = mount(
      <PipelineProgress
        stages={standardStages}
        currentStageId="stage-estimating"
        workflowRoute="normal"
        isBidBoardOwned={false}
        handoffStageDisplayOrder={null}
        canMoveBackward
        onStageClick={onStageClick}
      />
    );

    const contractButton = rendered.container.querySelector<HTMLButtonElement>('[data-stage-slug="contract"]');
    expect(contractButton).not.toBeNull();

    act(() => {
      contractButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onStageClick).toHaveBeenCalledWith("stage-contract");
    rendered.unmount();
  });
});
