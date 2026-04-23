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
}));

vi.mock("@/hooks/use-deals", () => ({
  useDealDetail: mocks.useDealDetailMock,
  deleteDeal: vi.fn(),
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

vi.mock("@/hooks/use-activities", () => ({
  useActivities: mocks.useActivitiesMock,
  createActivity: mocks.createActivityMock,
}));

vi.mock("@/lib/deal-utils", () => ({
  formatCurrency: vi.fn(() => "$0"),
  bestEstimate: vi.fn(() => 0),
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

vi.mock("@/components/email/deal-email-tab", () => ({
  DealEmailTab: () => <div>Email Tab</div>,
}));

vi.mock("@/components/deals/deal-overview-tab", () => ({
  DealOverviewTab: () => <div>Overview Tab</div>,
}));

vi.mock("@/components/deals/deal-history-tab", () => ({
  DealHistoryTab: () => <div>History Tab</div>,
}));

vi.mock("@/components/deals/deal-timeline-tab", () => ({
  DealTimelineTab: () => <div>Timeline Tab</div>,
}));

vi.mock("@/components/deals/deal-scoping-workspace", () => ({
  DealScopingWorkspace: () => <div>Scoping Tab</div>,
}));

vi.mock("@/components/files/deal-file-tab", () => ({
  DealFileTab: () => <div>Files Tab</div>,
}));

vi.mock("./deal-team-tab", () => ({
  DealTeamTab: () => <div>Team Tab</div>,
}));

vi.mock("./deal-estimates-tab", () => ({
  DealEstimatesTab: () => <div>Estimates Tab</div>,
}));

vi.mock("./deal-punch-list-tab", () => ({
  DealPunchListTab: () => <div>Punch List Tab</div>,
}));

vi.mock("./deal-closeout-tab", () => ({
  DealCloseoutTab: () => <div>Closeout Tab</div>,
}));

vi.mock("./deal-timers-banner", () => ({
  DealTimersBanner: () => <div>Timers Banner</div>,
}));

vi.mock("./deal-proposal-card", () => ({
  DealProposalCard: () => <div>Proposal Card</div>,
}));

vi.mock("./deal-estimating-substage", () => ({
  DealEstimatingSubstage: () => <div>Estimating Substage</div>,
}));

vi.mock("@/components/leads/lead-form", () => ({
  LeadForm: () => <div>Lead Form</div>,
}));

vi.mock("@/components/leads/lead-timeline-tab", () => ({
  LeadTimelineTab: () => <div>Lead Timeline</div>,
}));

vi.mock("@/components/activities/activity-log-form", () => ({
  ActivityLogForm: () => <div>Activity Form</div>,
}));

vi.mock("@/components/deals/stage-change-dialog", () => ({
  StageChangeDialog: () => <div>Stage Dialog</div>,
}));

vi.mock("@/components/tasks/task-create-dialog", () => ({
  TaskCreateDialog: () => <div>Task Create</div>,
}));

function renderPage() {
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
    name: "Palm Villas",
    stageId: "stage-estimating",
    workflowRoute: "normal",
    assignedRepId: "rep-1",
    companyId: "company-1",
    propertyId: "property-1",
    sourceLeadId: "lead-1",
    primaryContactId: null,
    ddEstimate: null,
    bidEstimate: null,
    awardedAmount: null,
    changeOrderTotal: "0",
    description: "Exterior refresh",
    propertyAddress: "123 Palm Way",
    propertyCity: "Dallas",
    propertyState: "TX",
    propertyZip: "75201",
    projectTypeId: null,
    regionId: null,
    source: "referral",
    winProbability: 50,
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
    bidBoardStageSlug: "estimating",
    readOnlySyncedAt: "2026-04-21T10:00:00.000Z",
    bidBoardOwnership: {
      isOwned: true,
      sourceOfTruth: "bid_board",
      handoffStageSlug: "estimating",
      downstreamStagesReadOnly: true,
      canEditInCrm: ["deal details", "files", "activity", "notes"],
      mirroredInCrm: ["stage progression", "proposal status", "estimating progress"],
      reason: "Bid Board now owns downstream progression after the deal entered estimating.",
      message: "Bid Board is now the source of truth once this deal entered estimating.",
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

    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "director-1",
        role: "director",
      },
    });

    mocks.usePipelineStagesMock.mockReturnValue({
      stages: [
        { id: "stage-dd", name: "DD", slug: "dd", displayOrder: 0, isTerminal: false },
        { id: "stage-estimating", name: "Estimating", slug: "estimating", displayOrder: 1, isTerminal: false },
        { id: "stage-bid-sent", name: "Bid Sent", slug: "bid_sent", displayOrder: 2, isTerminal: false },
        { id: "stage-in-production", name: "In Production", slug: "in_production", displayOrder: 3, isTerminal: false },
      ],
    });

    mocks.useCompanyDetailMock.mockReturnValue({
      company: { id: "company-1", name: "Alpha Roofing" },
    });

    mocks.useActivitiesMock.mockReturnValue({
      activities: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    mocks.useDealDetailMock.mockReturnValue({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail(),
    });
  });

  it("shows Bid Board ownership messaging while preserving valid CRM stage controls", () => {
    const html = renderPage();

    expect(html).toContain("Bid Board now owns downstream progression");
    expect(html).toContain("Bid Board is now the source of truth once this deal entered estimating.");
    expect(html).toContain("Move Stage");
    expect(html).toContain("Bid Board managed");
  });

  it("explains which fields remain editable in CRM versus mirrored from Bid Board", () => {
    const html = renderPage();

    expect(html).toContain("Still editable in CRM");
    expect(html).toContain("deal details");
    expect(html).toContain("files");
    expect(html).toContain("Mirrored from Bid Board");
    expect(html).toContain("stage progression");
    expect(html).toContain("proposal status");
  });

  it("keeps estimating manually reachable for owned deals that are still before the boundary", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({ stageId: "stage-dd" }),
    });

    const html = renderPage();
    const managedCount = (html.match(/Bid Board managed/g) ?? []).length;

    expect(html).toContain("Move Stage");
    expect(html).toContain('data-disabled="false">Estimating');
    expect(managedCount).toBe(2);
  });
});
