import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LeadListPage, buildLeadIntakePath, isImmediateNextStageMove } from "./lead-list-page";

const boardColumns = [
  {
    stage: { id: "stage-new", name: "New", slug: "lead_new" },
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
    stage: { id: "stage-prequal", name: "Company Pre-Qualified", slug: "company_pre_qualified" },
    count: 0,
    cards: [],
  },
  {
    stage: { id: "stage-scoping", name: "Scoping In Progress", slug: "scoping_in_progress" },
    count: 0,
    cards: [],
  },
  {
    stage: {
      id: "stage-value",
      name: "Pre-Qual Value Assigned",
      slug: "pre_qual_value_assigned",
    },
    count: 1,
    cards: [
      {
        id: "lead-2",
        name: "Qualified Lead",
        stageId: "stage-value",
        stageEnteredAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
  },
  {
    stage: { id: "stage-go", name: "Lead Go/No-Go", slug: "lead_go_no_go" },
    count: 0,
    cards: [],
  },
  {
    stage: {
      id: "stage-opportunity",
      name: "Qualified for Opportunity",
      slug: "qualified_for_opportunity",
    },
    count: 0,
    cards: [],
  },
];

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
  it("builds the lead intake path for blocked moves", () => {
    expect(buildLeadIntakePath("lead-1")).toBe("/leads/lead-1?focus=qualification");
    expect(buildLeadIntakePath("lead-1", "scoping")).toBe("/leads/lead-1?focus=scoping");
  });

  it("treats sparse display-order stages as valid immediate moves when mapped as next stage", () => {
    const nextStageById = new Map<string, string | null>([
      ["stage-go", "stage-opportunity"],
      ["stage-opportunity", null],
    ]);

    expect(isImmediateNextStageMove("stage-go", "stage-opportunity", nextStageById)).toBe(true);
    expect(isImmediateNextStageMove("stage-go", "stage-new", nextStageById)).toBe(false);
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
    expect(html).not.toContain("Qualified for Opportunity");
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
  });
});
