import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { PipelineBoard, resolvePipelineBoardMove } from "./pipeline-board";

const columns = [
  {
    stage: { id: "stage-estimating", name: "Estimating", slug: "estimating" },
    count: 12,
    totalValue: 245000,
    cards: [
      {
        id: "deal-1",
        name: "North Campus",
        stageId: "stage-estimating",
        stageEnteredAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-21T10:00:00.000Z",
        dealNumber: "TR-2026-0001",
        propertyCity: "Dallas",
      },
    ],
  },
];

describe("PipelineBoard", () => {
  it("renders stage headers and cards", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PipelineBoard
          entity="deal"
          columns={columns}
          loading={false}
          onOpenStage={() => undefined}
          onOpenRecord={() => undefined}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Estimating");
    expect(html).toContain("North Campus");
    expect(html).toContain("TR-2026-0001");
    expect(html).toContain("$245K");
    expect(html).toContain("Dallas");
    expect(html).toContain("4d in stage");
    expect(html).toContain("View all 12");
  });

  it("resolves drag moves from explicit stage metadata", () => {
    const move = resolvePipelineBoardMove(
      columns,
      {
        active: {
          id: "deal-1",
          data: { current: { record: { id: "deal-1" } } },
        },
        over: {
          id: "stage-estimating",
          data: { current: { stageId: "stage-estimating", stageSlug: "estimating" } },
        },
      } as any
    );

    expect(move).toEqual({
      activeId: "deal-1",
      targetStageId: "stage-estimating",
      targetStageSlug: "estimating",
    });
  });

  it("falls back to active and over ids when drag payload metadata is missing", () => {
    const move = resolvePipelineBoardMove(
      columns,
      {
        active: {
          id: "deal-1",
          data: { current: undefined },
        },
        over: {
          id: "stage-estimating",
          data: { current: undefined },
        },
      } as any
    );

    expect(move).toEqual({
      activeId: "deal-1",
      targetStageId: "stage-estimating",
      targetStageSlug: "estimating",
    });
  });
});
