import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { LeadListPage, buildLeadIntakePath, isImmediateNextStageMove } from "./lead-list-page";

const mocks = vi.hoisted(() => ({
  useLeadBoardMock: vi.fn(),
  useLeadsMock: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, className }: { children: ReactNode; className?: string }) => (
    <button className={className}>{children}</button>
  ),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("@/hooks/use-leads", () => ({
  LEAD_BOARD_STAGE_SLUGS: ["new_lead", "qualified_lead", "sales_validation_stage"],
  getLeadBoardStageLabel: (slug: string) =>
    ({
      new_lead: "New Lead",
      qualified_lead: "Qualified Lead",
      sales_validation_stage: "Sales Validation Stage",
    })[slug] ?? slug,
  useLeadBoard: mocks.useLeadBoardMock,
  useLeads: mocks.useLeadsMock,
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
        companyName: "Keller ISD",
        source: "referral",
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
        companyName: "DFW Logistics",
        source: "inbound",
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
  {
    stage: { id: "stage-opportunity", name: "Opportunity", slug: "opportunity" },
    count: 1,
    cards: [
      {
        id: "lead-legacy-opportunity",
        name: "Legacy Opportunity Lead",
        stageId: "stage-opportunity",
        stageEnteredAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
  },
];

const defaultBoardColumns = structuredClone(boardColumns);

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    id: "lead-row-1",
    companyId: "company-1",
    propertyId: "property-1",
    primaryContactId: "contact-1",
    primaryContactRole: null,
    primaryContactRoleOtherLabel: null,
    name: "Fresh Prospect",
    stageId: "stage-new",
    assignedRepId: "rep-1",
    assignedRepName: "Brett Jones",
    status: "open",
    source: "referral",
    sourceCategory: null,
    sourceDetail: null,
    description: null,
    projectTypeId: null,
    bidDueDate: null,
    qualificationPayload: {},
    projectTypeQuestionPayload: { projectTypeId: null, answers: {} },
    qualificationScope: null,
    qualificationBudgetAmount: "250000",
    qualificationCompanyFit: null,
    directorReviewDecision: null,
    directorReviewReason: null,
    decisionMakerName: null,
    decisionProcess: null,
    budgetStatus: null,
    incumbentVendor: null,
    unitCount: null,
    buildYear: null,
    forecastWindow: null,
    forecastCategory: null,
    forecastConfidencePercent: null,
    forecastRevenue: null,
    forecastGrossProfit: null,
    forecastBlockers: null,
    nextStep: null,
    nextStepDueAt: null,
    nextMilestoneAt: null,
    supportNeededType: null,
    supportNeededNotes: null,
    forecastUpdatedAt: null,
    forecastUpdatedBy: null,
    lastActivityAt: null,
    verificationStatus: "not_required",
    verificationRequiredReason: null,
    stageEnteredAt: "2026-04-20T10:00:00.000Z",
    convertedAt: null,
    isActive: true,
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    companyName: "Keller ISD",
    property: null,
    convertedDealId: null,
    convertedDealNumber: null,
    ...overrides,
  };
}

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function renderPage(path = "/leads?scope=mine", role = "rep") {
  mocks.useAuthMock.mockReturnValue({
    user: {
      id: "user-1",
      email: `${role}@example.test`,
      displayName: "Test User",
      role,
      officeId: "office-1",
      activeOfficeId: "office-1",
    },
    loading: false,
  });

  return normalize(
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <LeadListPage />
      </MemoryRouter>
    )
  );
}

describe("LeadListPage", () => {
  beforeEach(() => {
    mocks.useAuthMock.mockReset();
    boardColumns.splice(0, boardColumns.length, ...structuredClone(defaultBoardColumns));
    mocks.useLeadBoardMock.mockReturnValue({
      board: {
        columns: boardColumns,
        defaultConversionDealStageId: null,
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.useLeadsMock.mockReturnValue({
      leads: [makeLead(), makeLead({ id: "lead-row-2", name: "Qualified Lead", source: "inbound", qualificationBudgetAmount: "125000" })],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
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

  it("renders the readonly lead board and excludes legacy opportunity from the board", () => {
    const html = renderPage();

    expect(mocks.useLeadBoardMock).toHaveBeenCalledWith("mine");
    expect(mocks.useLeadsMock).toHaveBeenCalledWith({ status: "open", isActive: "all", scope: "mine" });
    expect(html).toContain("Read-only lead board");
    expect(html).toContain("New Lead");
    expect(html).toContain("Qualified Lead");
    expect(html).toContain("Sales Validation Stage");
    expect(html).toContain("Fresh Prospect");
    expect(html).not.toContain("Legacy Opportunity Lead");
  });

  it("loads summary leads with the active scope", () => {
    renderPage("/leads?scope=mine");
    expect(mocks.useLeadsMock).toHaveBeenLastCalledWith({ status: "open", isActive: "all", scope: "mine" });

    renderPage("/leads?scope=team");
    expect(mocks.useLeadsMock).toHaveBeenLastCalledWith({ status: "open", isActive: "all", scope: "team" });

    renderPage("/leads?scope=all");
    expect(mocks.useLeadsMock).toHaveBeenLastCalledWith({ status: "open", isActive: "all", scope: "all" });
  });

  it("defaults the board scope by role when the query param is absent", () => {
    renderPage("/leads", "rep");
    expect(mocks.useLeadBoardMock).toHaveBeenLastCalledWith("mine");

    renderPage("/leads", "director");
    expect(mocks.useLeadBoardMock).toHaveBeenLastCalledWith("team");

    renderPage("/leads", "admin");
    expect(mocks.useLeadBoardMock).toHaveBeenLastCalledWith("all");

    renderPage("/leads?scope=mine", "director");
    expect(mocks.useLeadBoardMock).toHaveBeenLastCalledWith("mine");
  });

  it("filters columns by the dashboard bucket query param", () => {
    const bucketedHtml = renderPage("/leads?scope=mine&bucket=qualified_lead");

    expect(bucketedHtml).not.toContain('aria-label="New Lead leads"');
    expect(bucketedHtml).toContain('aria-label="Qualified Lead leads"');
    expect(bucketedHtml).not.toContain('aria-label="Sales Validation Stage leads"');

    const fullHtml = renderPage("/leads?scope=mine");

    expect(fullHtml).toContain('aria-label="New Lead leads"');
    expect(fullHtml).toContain('aria-label="Qualified Lead leads"');
    expect(fullHtml).toContain('aria-label="Sales Validation Stage leads"');
  });

  it("uses byte-for-byte stage labels from the workflow source", () => {
    const html = renderPage();

    expect(html).toContain("Sales Validation Stage");
    expect(html).not.toContain("Sales Validation</p>");
  });
});
