import { afterEach, describe, expect, it, vi } from "vitest";
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

const terminalColumns = [
  {
    stage: { id: "stage-won", name: "Won", slug: "won" },
    count: 3,
    totalValue: 125000,
    cards: [],
  },
  {
    stage: { id: "stage-lost", name: "Lost", slug: "lost" },
    count: 1,
    totalValue: 25000,
    cards: [],
  },
];

describe("PipelineBoard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders stage headers and cards", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

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
    expect(html).toContain("11d in stage");
    expect(html).toContain("View all 12");
  });

  it("renders terminal date filter controls for deal Won and Lost columns", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PipelineBoard
          entity="deal"
          columns={terminalColumns}
          loading={false}
          onOpenStage={() => undefined}
          onOpenRecord={() => undefined}
          terminalDateFilters={{
            won: { preset: "30" },
            lost: { preset: "custom", customStart: "2026-04-01", customEnd: "2026-04-30" },
          }}
          onTerminalDateFilterChange={() => undefined}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Won");
    expect(html).toContain("Lost");
    expect(html).toContain("· 30d");
    expect(html).toContain("· custom");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Show Won deals from the last 30 days"');
    expect(html).toContain('aria-label="Show Lost deals from a custom date range"');
    expect(html).not.toContain("<select");
    expect(html).toContain('aria-label="Lost start date"');
    expect(html).toContain("2026-04-01");
  });

  it("renders the deal stage age from stageEnteredAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PipelineBoard
          entity="deal"
          columns={[
            {
              ...columns[0],
              cards: [{ ...columns[0].cards[0], stageEnteredAt: "2026-04-26T12:00:00.000Z" }],
            },
          ]}
          loading={false}
          onOpenStage={() => undefined}
          onOpenRecord={() => undefined}
        />
      </MemoryRouter>
    );

    expect(html).toContain("5d in stage");
  });

  it("uses fixed-height scroll regions and virtualizes oversized columns", () => {
    const oversizedColumns = [
      {
        ...columns[0],
        count: 205,
        cards: Array.from({ length: 205 }, (_, index) => ({
          id: `deal-${index + 1}`,
          name: `Deal ${String(index + 1).padStart(3, "0")}`,
          stageId: "stage-estimating",
          stageEnteredAt: "2026-04-20T10:00:00.000Z",
          updatedAt: "2026-04-21T10:00:00.000Z",
        })),
      },
    ];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PipelineBoard
          entity="deal"
          columns={oversizedColumns}
          loading={false}
          onOpenStage={() => undefined}
          onOpenRecord={() => undefined}
        />
      </MemoryRouter>
    );

    expect(html).toContain("calc(100vh - var(--pipeline-board-header-offset, 12rem))");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain('data-virtualized-card-count="205"');
    expect(html).toContain("Deal 001");
    expect(html).not.toContain("Deal 205");
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
