import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { PipelineBoard } from "./pipeline-board";

const columns = [
  {
    stage: { id: "stage-estimating", name: "Estimating", slug: "estimating" },
    count: 12,
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
    expect(html).toContain("View all 12");
  });
});
