// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineStageSummary, type PipelineStageSummaryColumn } from "./pipeline-stage-summary";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COLUMNS: PipelineStageSummaryColumn[] = [
  { stage: { id: "stage-est", name: "Estimating" }, count: 4, totalValue: 1_200_000 },
  { stage: { id: "stage-contract", name: "Contract" }, count: 2, totalValue: 880_000 },
  { stage: { id: "stage-won", name: "Won" }, count: 9, totalValue: 4_000_000 },
];

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

async function renderDom(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(node);
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("PipelineStageSummary", () => {
  it("renders one md:hidden chip per stage with its name, count and compact value", () => {
    const html = normalize(
      renderToStaticMarkup(
        <PipelineStageSummary columns={COLUMNS} activeStageId={null} onSelectStage={() => {}} />
      )
    );

    // The whole summary is phone-only — the desktop drag board carries >=md.
    expect(html).toContain("md:hidden");
    expect(html).toContain("Estimating");
    expect(html).toContain("Contract");
    expect(html).toContain("Won");
    // Counts and compact values mirror the desktop column header (same formatCurrencyCompact).
    expect(html).toContain(">4<");
    expect(html).toContain("$1.2M");
    expect(html).toContain("$4.0M");
  });

  it("renders nothing when there are no columns", () => {
    const html = renderToStaticMarkup(
      <PipelineStageSummary columns={[]} activeStageId={null} onSelectStage={() => {}} />
    );
    expect(html).toBe("");
  });

  it("marks the active stage chip aria-pressed and leaves the rest unpressed", async () => {
    const { container, cleanup } = await renderDom(
      <PipelineStageSummary columns={COLUMNS} activeStageId="stage-contract" onSelectStage={() => {}} />
    );
    try {
      const pressed = container.querySelectorAll('button[aria-pressed="true"]');
      expect(pressed.length).toBe(1);
      expect(pressed[0]?.textContent).toContain("Contract");
      // Every chip is a >=44px touch target.
      expect(container.querySelector("button")?.className).toContain("min-h-[44px]");
    } finally {
      await cleanup();
    }
  });

  it("calls onSelectStage with the tapped stage id", async () => {
    const onSelectStage = vi.fn();
    const { container, cleanup } = await renderDom(
      <PipelineStageSummary columns={COLUMNS} activeStageId={null} onSelectStage={onSelectStage} />
    );
    try {
      const wonChip = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Won")
      );
      await act(async () => {
        wonChip?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onSelectStage).toHaveBeenCalledWith("stage-won");
    } finally {
      await cleanup();
    }
  });
});
