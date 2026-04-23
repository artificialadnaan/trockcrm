import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { DealDetailPage } from "./deal-detail-page";

const mocks = vi.hoisted(() => ({
  useDealDetailMock: vi.fn(),
  useCompanyDetailMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  useAuthMock: vi.fn(),
  useActivitiesMock: vi.fn(),
  createActivityMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  useTasksMock: vi.fn(),
  updateDealMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  useDealDetail: mocks.useDealDetailMock,
  deleteDeal: vi.fn(),
  updateDeal: mocks.updateDealMock,
}));
vi.mock("@/hooks/use-companies", () => ({
  useCompanyDetail: mocks.useCompanyDetailMock,
}));
vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: mocks.usePipelineStagesMock,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));
vi.mock("@/hooks/use-task-assignees", () => ({
  useTaskAssignees: mocks.useTaskAssigneesMock,
}));
vi.mock("@/hooks/use-tasks", () => ({
  useTasks: mocks.useTasksMock,
  getTaskStatusLabel: vi.fn((status: string) => status),
}));
vi.mock("@/hooks/use-activities", () => ({
  useActivities: mocks.useActivitiesMock,
  createActivity: mocks.createActivityMock,
}));
vi.mock("@/lib/deal-utils", () => ({
  formatCurrency: vi.fn(() => "$0"),
  bestEstimate: vi.fn(() => 0),
}));
vi.mock("@/lib/record-detail-summary", () => ({
  buildDealDetailSummary: () => ({
    ageDays: 5,
    freshnessDays: 1,
  }),
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => (
    <div data-disabled={disabled ? "true" : "false"}>{children}</div>
  ),
}));
vi.mock("@/components/deals/deal-stage-badge", () => ({
  DealStageBadge: ({ stageId }: { stageId: string }) => <span>{stageId}</span>,
}));
vi.mock("@/components/email/deal-email-tab", () => ({ DealEmailTab: () => <div>Email Tab</div> }));
vi.mock("@/components/deals/deal-overview-tab", () => ({ DealOverviewTab: () => <div>Overview Tab</div> }));
vi.mock("@/components/deals/deal-history-tab", () => ({ DealHistoryTab: () => <div>History Tab</div> }));
vi.mock("@/components/deals/deal-timeline-tab", () => ({ DealTimelineTab: () => <div>Timeline Tab</div> }));
vi.mock("@/components/deals/deal-scoping-workspace", () => ({ DealScopingWorkspace: () => <div>Scoping Workspace</div> }));
vi.mock("@/components/files/deal-file-tab", () => ({ DealFileTab: () => <div>Files Tab</div> }));
vi.mock("./deal-team-tab", () => ({ DealTeamTab: () => <div>Team Tab</div> }));
vi.mock("./deal-payments-tab", () => ({ DealPaymentsTab: () => <div>Payments Tab</div> }));
vi.mock("./deal-estimates-tab", () => ({ DealEstimatesTab: () => <div>Estimates Tab</div> }));
vi.mock("./deal-punch-list-tab", () => ({ DealPunchListTab: () => <div>Punch List Tab</div> }));
vi.mock("./deal-closeout-tab", () => ({ DealCloseoutTab: () => <div>Closeout Tab</div> }));
vi.mock("./deal-timers-banner", () => ({ DealTimersBanner: () => <div>Timers Banner</div> }));
vi.mock("./deal-proposal-card", () => ({ DealProposalCard: () => <div>Proposal Card</div> }));
vi.mock("./deal-estimating-substage", () => ({ DealEstimatingSubstage: () => <div>Estimating Substage</div> }));
vi.mock("@/components/deals/opportunity-routing-panel", () => ({ OpportunityRoutingPanel: () => null }));
vi.mock("@/components/leads/lead-form", () => ({ LeadForm: () => <div>Lead Form</div> }));
vi.mock("@/components/leads/lead-timeline-tab", () => ({ LeadTimelineTab: () => <div>Lead Timeline</div> }));
vi.mock("@/components/activities/activity-log-form", () => ({ ActivityLogForm: () => <div>Activity Form</div> }));
vi.mock("@/components/deals/stage-change-dialog", () => ({ StageChangeDialog: () => null }));
vi.mock("@/components/tasks/task-create-dialog", () => ({ TaskCreateDialog: () => null }));
vi.mock("@/components/assignment/record-assignment-card", () => ({
  RecordAssignmentCard: ({ label }: { label: string }) => <div>{label}</div>,
}));
vi.mock("@/components/shared/forecast-editor", () => ({
  ForecastEditor: () => <div>Forecast Editor</div>,
}));
vi.mock("@/components/shared/next-step-editor", () => ({
  NextStepEditor: () => <div>Next Step Editor</div>,
}));

function renderDealDetail() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/deals/deal-1"]}>
      <Routes>
        <Route path="/deals/:id" element={<DealDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function makeDealDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    dealNumber: "TR-2026-0001",
    name: "Hill Place Interior Upgrade",
    stageId: "stage-estimating",
    workflowRoute: "normal",
    assignedRepId: "rep-1",
    companyId: "company-1",
    propertyId: "property-1",
    sourceLeadId: "lead-1",
    primaryContactId: null,
    ddEstimate: null,
    bidEstimate: "450000",
    awardedAmount: null,
    changeOrderTotal: "0",
    description: null,
    propertyAddress: null,
    propertyCity: null,
    propertyState: null,
    propertyZip: null,
    projectTypeId: null,
    regionId: null,
    source: null,
    winProbability: null,
    procoreProjectId: null,
    procoreBidId: null,
    procoreLastSyncedAt: null,
    lostReasonId: null,
    lostNotes: null,
    lostCompetitor: null,
    lostAt: null,
    expectedCloseDate: null,
    actualCloseDate: null,
    lastActivityAt: null,
    stageEnteredAt: "2026-04-21T10:00:00.000Z",
    isActive: true,
    hubspotDealId: null,
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-21T10:00:00.000Z",
    proposalStatus: "drafting",
    proposalSentAt: null,
    proposalAcceptedAt: null,
    proposalRevisionCount: 0,
    proposalNotes: null,
    estimatingSubstage: "building_estimate",
    isBidBoardOwned: true,
    bidBoardStageSlug: "estimate_in_progress",
    readOnlySyncedAt: "2026-04-21T10:00:00.000Z",
    bidBoardOwnership: {
      isOwned: true,
      sourceOfTruth: "bid_board",
      handoffStageSlug: "estimate_in_progress",
      downstreamStagesReadOnly: true,
      canEditInCrm: ["deal details", "files", "activity", "notes"],
      mirroredInCrm: ["stage progression", "proposal status", "estimating progress"],
      reason: "Bid Board now owns downstream progression after the deal entered Estimate in Progress.",
      message: "Bid Board is now the source of truth once this deal entered Estimate in Progress.",
    },
    stageHistory: [],
    approvals: [],
    changeOrders: [],
    ...overrides,
  };
}

describe("DealDetailPage", () => {
  beforeEach(() => {
    mocks.useCompanyDetailMock.mockReset();
    mocks.useDealDetailMock.mockReset();
    mocks.usePipelineStagesMock.mockReset();
    mocks.useAuthMock.mockReset();
    mocks.useActivitiesMock.mockReset();
    mocks.useTaskAssigneesMock.mockReset();
    mocks.useTasksMock.mockReset();

    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "director-1",
        displayName: "Dana Director",
        role: "director",
        officeId: "office-1",
      },
    });
    mocks.usePipelineStagesMock.mockReturnValue({
      stages: [
        { id: "stage-estimating", name: "Estimate in Progress", slug: "estimate_in_progress", displayOrder: 2, isTerminal: false },
        { id: "stage-close-out", name: "Sent to Production", slug: "sent_to_production", displayOrder: 9, isTerminal: true },
      ],
    });
    mocks.useCompanyDetailMock.mockReturnValue({
      company: null,
    });
    mocks.useActivitiesMock.mockReturnValue({
      activities: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.useTaskAssigneesMock.mockReturnValue({
      assignees: [{ id: "rep-1", displayName: "Rep One" }],
      loading: false,
      error: null,
    });
    mocks.useTasksMock.mockReturnValue({
      tasks: [],
      loading: false,
      error: null,
    });
    mocks.useDealDetailMock.mockReturnValue({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail(),
    });
  });

  it("renders the assignment card on the deal detail page", () => {
    const html = renderDealDetail();

    expect(html).toContain("Hill Place Interior Upgrade");
    expect(html).toContain("Pipeline context");
    expect(html).toContain("Stage age");
    expect(html).toContain("Last update");
    expect(html).toContain("Next action");
    expect(html).toContain("Assigned Rep");
    expect(html).toContain("Tasks");
    expect(html).toContain("Payments");
  });

  it("keeps bid board owned deals read-only for downstream proposal workflow while preserving valid stage controls", () => {
    const html = renderDealDetail();

    expect(html).toContain("Move Stage");
    expect(html).toContain("Estimate in Progress");
    expect(html).not.toContain("Proposal Card");
  });

  it("keeps punch list and close-out tabs reachable once a deal is sent to production", () => {
    mocks.useDealDetailMock.mockReturnValue({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "stage-close-out",
        bidBoardStageSlug: "sent_to_production",
      }),
    });

    const html = renderDealDetail();

    expect(html).toContain("Punch List");
    expect(html).toContain("Close-Out");
  });
});
