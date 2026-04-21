import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import {
  LeadListPage,
  isImmediateNextStageMove,
  isValidDirectorDecisionForTarget,
} from "./lead-list-page";

const boardColumns = [
  {
    stage: { id: "stage-contacted", name: "Lead", slug: "contacted" },
    count: 1,
    cards: [
      {
        id: "lead-1",
        name: "Contacted Lead",
        stageId: "stage-contacted",
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
    stage: { id: "stage-director", name: "Director Review", slug: "director_go_no_go" },
    count: 0,
    cards: [],
  },
  {
    stage: { id: "stage-ready", name: "Ready", slug: "ready_for_opportunity" },
    count: 0,
    cards: [],
  },
];

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { role: "rep" },
  }),
}));

vi.mock("@/hooks/use-leads", () => ({
  useLeadBoard: () => ({
    board: {
      columns: boardColumns,
      defaultConversionDealStageId: "deal-stage-1",
    },
    loading: false,
    convertLead: vi.fn(),
    refetch: vi.fn(),
  }),
  transitionLeadStage: vi.fn(),
}));

vi.mock("@/components/leads/lead-conversion-dialog", () => ({
  LeadConversionDialog: () => null,
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("LeadListPage", () => {
  it("treats sparse display-order stages as valid immediate moves when mapped as next stage", () => {
    const nextStageById = new Map<string, string | null>([
      ["stage-ready", "stage-converted"],
      ["stage-converted", null],
    ]);

    expect(isImmediateNextStageMove("stage-ready", "stage-converted", nextStageById)).toBe(true);
    expect(isImmediateNextStageMove("stage-ready", "stage-contacted", nextStageById)).toBe(false);
  });

  it("requires a go decision for ready_for_opportunity transitions", () => {
    expect(isValidDirectorDecisionForTarget("ready_for_opportunity", "go")).toBe(true);
    expect(isValidDirectorDecisionForTarget("ready_for_opportunity", "no_go")).toBe(false);
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
    expect(html).not.toContain("Contacted Lead");
  });
});
