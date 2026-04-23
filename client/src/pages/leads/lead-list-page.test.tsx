import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LeadListPage, buildLeadIntakePath, isImmediateNextStageMove } from "./lead-list-page";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/pipeline/pipeline-board", () => ({
  PipelineBoard: ({ columns }: { columns: Array<{ stage: { name: string } }> }) => (
    <div>{columns.map((column) => column.stage.name).join(", ")}</div>
  ),
}));

vi.mock("@/lib/pipeline-board-summary", () => ({
  buildLeadBoardSummary: () => ({
    totalCount: 2,
    averageAgeDays: 4,
    qualifiedPressureCount: 1,
    opportunityCount: 0,
    liveStageCount: 3,
  }),
}));

const boardColumns = [
  {
    stage: { id: "stage-new", name: "New Lead", slug: "new_lead" },
    count: 1,
    cards: [
      {
        id: "lead-1",
        name: "Fresh Prospect",
        stageId: "stage-new",
        stageEnteredAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
  },
  {
    stage: { id: "stage-qualified", name: "Qualified Lead", slug: "qualified_lead" },
    count: 1,
    cards: [
      {
        id: "lead-2",
        name: "Qualified Lead",
        stageId: "stage-qualified",
        stageEnteredAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
  },
  {
    stage: { id: "stage-validation", name: "Sales Validation Stage", slug: "sales_validation_stage" },
    count: 0,
    cards: [],
  },
];

const defaultBoardColumns = structuredClone(boardColumns);

vi.mock("@/hooks/use-leads", () => ({
  useLeadBoard: () => ({
    board: {
      columns: boardColumns,
      defaultConversionDealStageId: null,
    },
    loading: false,
    refetch: vi.fn(),
  }),
  preflightLeadStageCheck: vi.fn(),
  transitionLeadStage: vi.fn(),
  updateLead: vi.fn(),
}));

vi.mock("@/lib/pipeline-scope", () => ({
  useNormalizedPipelineRoute: () => ({
    allowedScope: "mine",
    needsRedirect: false,
    redirectTo: "/leads?scope=mine",
  }),
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("LeadListPage", () => {
  beforeEach(() => {
    boardColumns.splice(0, boardColumns.length, ...structuredClone(defaultBoardColumns));
  });

  it("builds the lead intake path for blocked moves", () => {
    expect(buildLeadIntakePath("lead-1")).toBe("/leads/lead-1?focus=qualification");
  });

  it("treats sparse display-order stages as valid immediate moves when mapped as next stage", () => {
    const nextStageById = new Map<string, string | null>([
      ["stage-qualified", "stage-validation"],
      ["stage-validation", null],
    ]);

    expect(isImmediateNextStageMove("stage-qualified", "stage-validation", nextStageById)).toBe(true);
    expect(isImmediateNextStageMove("stage-qualified", "stage-new", nextStageById)).toBe(false);
  });

  it("filters lead buckets from the bucket query param", () => {
    const html = normalize(
      renderToStaticMarkup(
        <MemoryRouter initialEntries={["/leads?bucket=qualified_lead&scope=mine"]}>
          <LeadListPage />
        </MemoryRouter>
      )
    );

    expect(html).toContain("Qualified Lead");
    expect(html).not.toContain("Fresh Prospect");
    expect(html).not.toContain("Sales Validation Stage");
  });

  it("renders the restored board header and summary strip", () => {
    const html = normalize(
      renderToStaticMarkup(
        <MemoryRouter initialEntries={["/leads?scope=mine"]}>
          <LeadListPage />
        </MemoryRouter>
      )
    );

    expect(html).toContain("Lead Pipeline");
    expect(html).toContain("Live engine");
    expect(html).toContain("Qualified pressure");
    expect(html).toContain("Active leads");
    expect(html).toContain("Avg. stage age");
    expect(html).toContain("New Lead");
    expect(html).toContain("Sales Validation Stage");
  });

  it("renders legacy lead stages while the active pipeline config is still transitioning", () => {
    boardColumns.splice(0, boardColumns.length, ...[
      {
        stage: { id: "stage-new", name: "New Lead", slug: "new_lead" },
        count: 1,
        cards: [
          {
            id: "lead-legacy-new",
            name: "Legacy New Lead",
            stageId: "stage-new",
            stageEnteredAt: "2026-04-20T10:00:00.000Z",
            updatedAt: "2026-04-20T10:00:00.000Z",
          },
        ],
      },
      {
        stage: { id: "stage-qualified", name: "Qualified Lead", slug: "qualified_lead" },
        count: 1,
        cards: [
          {
            id: "lead-legacy-qualified",
            name: "Legacy Qualified Lead",
            stageId: "stage-qualified",
            stageEnteredAt: "2026-04-20T10:00:00.000Z",
            updatedAt: "2026-04-20T10:00:00.000Z",
          },
        ],
      },
      {
        stage: { id: "stage-validation", name: "Sales Validation Stage", slug: "sales_validation_stage" },
        count: 1,
        cards: [
          {
            id: "lead-legacy-opportunity",
            name: "Legacy Opportunity Lead",
            stageId: "stage-validation",
            stageEnteredAt: "2026-04-20T10:00:00.000Z",
            updatedAt: "2026-04-20T10:00:00.000Z",
          },
        ],
      },
    ]);

    const html = normalize(
      renderToStaticMarkup(
        <MemoryRouter initialEntries={["/leads?scope=mine"]}>
          <LeadListPage />
        </MemoryRouter>
      )
    );

    expect(html).toContain("New Lead, Qualified Lead, Sales Validation Stage");
    expect(html).toContain("Qualified pressure");
    expect(html).toContain(">2<");
    expect(html).toContain("Opportunity ready");
    expect(html).toContain(">1<");
  });
});
