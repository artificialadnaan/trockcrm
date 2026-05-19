import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { LeadListPage, buildLeadIntakePath, buildLeadStageNavigationPath, isImmediateNextStageMove } from "./lead-list-page";

const mocks = vi.hoisted(() => ({
  useLeadBoardMock: vi.fn(),
  useLeadsMock: vi.fn(),
  useAuthMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
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

vi.mock("@/hooks/use-task-assignees", () => ({
  useTaskAssignees: mocks.useTaskAssigneesMock,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children, placeholder }: { children?: ReactNode; placeholder?: string }) => (
    <span>{children ?? placeholder ?? ""}</span>
  ),
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
    mocks.useTaskAssigneesMock.mockReset();
    mocks.useTaskAssigneesMock.mockReturnValue({
      assignees: [{ id: "rep-1", displayName: "Brett Jones" }],
      loading: false,
    });
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

    expect(mocks.useLeadBoardMock).toHaveBeenCalledWith("mine", undefined);
    expect(mocks.useLeadsMock).toHaveBeenCalledWith({ status: "open", isActive: true, scope: "mine" });
    expect(html).toContain("Read-only lead board");
    expect(html).toContain("New Lead");
    expect(html).toContain("Qualified Lead");
    expect(html).toContain("Sales Validation Stage");
    expect(html).toContain("Fresh Prospect");
    expect(html).not.toContain("Legacy Opportunity Lead");
  });

  it("renders lead descriptions as a muted responsive column with hover title and dash fallback", () => {
    mocks.useLeadsMock.mockReturnValue({
      leads: [
        makeLead({
          description: "Long lead description that should stay available on hover in the recent leads list.",
        }),
        makeLead({
          id: "lead-row-2",
          name: "No Description Lead",
          description: null,
        }),
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage();

    expect(html).toContain('aria-label="Long lead description that should stay available on hover in the recent leads list."');
    expect(html).toContain('title="Long lead description that should stay available on hover in the recent leads list."');
    expect(html).toContain("Long lead description that should stay available on hover in the recent leads list.");
    expect(html).toContain("No Description Lead");
    expect(html).toContain(">—<");
    expect(html).toContain("hidden min-w-0 md:block");
  });

  it("renders every lead card returned for a busy column inside an internally scrollable body", () => {
    const busyCards = Array.from({ length: 13 }).map((_, index) => ({
      id: `lead-busy-${index + 1}`,
      name: `Busy Lead ${index + 1}`,
      stageId: "stage-new",
      companyName: "Keller ISD",
      source: "referral",
      stageEnteredAt: "2026-04-20T10:00:00.000Z",
      updatedAt: "2026-04-20T10:00:00.000Z",
    }));
    boardColumns[0] = {
      ...boardColumns[0],
      count: busyCards.length,
      cards: busyCards,
    };

    const html = renderPage();

    expect(html).toContain("overflow-y-auto");
    expect(html).toContain('aria-label="New Lead leads"');
    expect(html).toContain(">13</p>");
    for (const lead of busyCards) {
      expect(html).toContain(lead.name);
    }
  });

  it("loads summary leads with the active scope when role is director", () => {
    renderPage("/leads?scope=team", "director");
    expect(mocks.useLeadsMock).toHaveBeenLastCalledWith({ status: "open", isActive: true, scope: "team" });
  });

  it("renders selected owner filter names instead of raw selected owner ids", () => {
    const html = renderPage("/leads?scope=team&assignedRepId=rep-1", "director");

    expect(html).toContain("Brett Jones");
    expect(html).not.toContain(">rep-1<");
    expect(mocks.useLeadsMock).toHaveBeenLastCalledWith({
      status: "open",
      isActive: true,
      scope: "team",
      assignedRepId: "rep-1",
    });
  });

  it("preserves selected owner filter when building a lead stage navigation path", () => {
    expect(buildLeadStageNavigationPath("stage-new", "team", "rep-1")).toBe(
      "/leads/stages/stage-new?scope=team&assignedRepId=rep-1"
    );
    expect(buildLeadStageNavigationPath("stage-new", "team", "")).toBe("/leads/stages/stage-new?scope=team");
    expect(buildLeadStageNavigationPath("stage-new", "mine", "rep-1")).toBe("/leads/stages/stage-new?scope=mine");
  });

  it("ignores stale owner query params when the lead scope is mine", () => {
    const html = renderPage("/leads?scope=mine&assignedRepId=rep-1", "director");

    expect(mocks.useLeadBoardMock).toHaveBeenLastCalledWith("mine", undefined);
    expect(mocks.useLeadsMock).toHaveBeenLastCalledWith({ status: "open", isActive: true, scope: "mine" });
    expect(html).not.toContain("All reps");
  });

  it("does not fire board fetch before auth resolves", () => {
    mocks.useAuthMock.mockReturnValue({
      user: null,
      loading: true,
    });
    mocks.useLeadBoardMock.mockClear();

    const loadingHtml = normalize(
      renderToStaticMarkup(
        <MemoryRouter initialEntries={["/leads"]}>
          <LeadListPage />
        </MemoryRouter>
      )
    );

    expect(loadingHtml).toContain("Loading lead board...");
    expect(mocks.useLeadBoardMock).not.toHaveBeenCalled();

    renderPage("/leads", "director");

    expect(mocks.useLeadBoardMock).toHaveBeenCalledWith("mine", undefined);
  });

  it("shows the deferred Team empty state when team scope is requested", () => {
    renderPage("/leads?scope=team", "rep");

    expect(mocks.useLeadBoardMock).toHaveBeenLastCalledWith("team", undefined);
    expect(mocks.useLeadsMock).toHaveBeenLastCalledWith({ status: "open", isActive: true, scope: "team" });
  });

  it("defaults the board scope by role when the query param is absent", () => {
    renderPage("/leads", "rep");
    expect(mocks.useLeadBoardMock).toHaveBeenLastCalledWith("mine", undefined);

    renderPage("/leads", "director");
    expect(mocks.useLeadBoardMock).toHaveBeenLastCalledWith("mine", undefined);

    renderPage("/leads", "admin");
    expect(mocks.useLeadBoardMock).toHaveBeenLastCalledWith("mine", undefined);

    renderPage("/leads?scope=mine", "director");
    expect(mocks.useLeadBoardMock).toHaveBeenLastCalledWith("mine", undefined);
  });

  it("renders Team as a first-class scope option even before it is configured", () => {
    const html = renderPage("/leads?scope=team", "rep");

    expect(mocks.useLeadBoardMock).toHaveBeenLastCalledWith("team", undefined);
    expect(html).toContain('aria-pressed="true">Team');
    expect(html).toContain("Team view is not yet configured");
  });

  it("allows reps to opt into all-office scope", () => {
    const html = renderPage("/leads?scope=all", "rep");

    expect(mocks.useLeadBoardMock).toHaveBeenLastCalledWith("all", undefined);
    expect(html).toContain('aria-pressed="false">Mine');
    expect(html).toContain('aria-pressed="true">All');
    expect(html).toContain('aria-pressed="false">Team');
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
