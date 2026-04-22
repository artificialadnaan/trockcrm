import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DealDetailPage } from "./deal-detail-page";

const deal = {
  id: "deal-1",
  name: "Hill Place Interior Upgrade",
  dealNumber: "TR-2026-0001",
  stageId: "stage-estimating",
  assignedRepId: "rep-1",
  companyId: "company-1",
  sourceLeadId: "lead-1",
  primaryContactId: null,
  workflowRoute: "estimating",
  isActive: true,
  createdAt: "2026-04-01T10:00:00.000Z",
  updatedAt: "2026-04-11T10:00:00.000Z",
  ddEstimate: null,
  bidEstimate: "450000",
  awardedAmount: null,
  description: null,
  propertyAddress: null,
  propertyCity: null,
  propertyState: null,
  propertyZip: null,
  projectTypeId: null,
  regionId: null,
  source: null,
  winProbability: null,
  expectedCloseDate: null,
  proposalNotes: null,
  estimatingSubstage: null,
  proposalStatus: null,
  proposalSentAt: null,
  proposalAcceptedAt: null,
  proposalRevisionCount: 0,
};

vi.mock("@/hooks/use-deals", () => ({
  useDealDetail: vi.fn(() => ({
    deal,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
  deleteDeal: vi.fn(),
}));

vi.mock("@/hooks/use-companies", () => ({
  useCompanyDetail: vi.fn(() => ({ company: null })),
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: vi.fn(() => ({
    stages: [
      { id: "stage-estimating", name: "Estimating", slug: "estimating", displayOrder: 2, isTerminal: false },
      { id: "stage-close-out", name: "Closed Won", slug: "closed_won", displayOrder: 9, isTerminal: true },
    ],
  })),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: vi.fn(() => ({
    user: {
      id: "director-1",
      displayName: "Dana Director",
      role: "director",
      officeId: "office-1",
    },
  })),
}));

vi.mock("@/hooks/use-task-assignees", () => ({
  useTaskAssignees: vi.fn(() => ({
    assignees: [{ id: "rep-1", displayName: "Rep One" }],
    loading: false,
    error: null,
  })),
}));

vi.mock("@/hooks/use-tasks", () => ({
  useTasks: vi.fn(() => ({
    tasks: [],
    loading: false,
    error: null,
  })),
  getTaskStatusLabel: vi.fn((status: string) => status),
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
vi.mock("@/hooks/use-activities", () => ({
  useActivities: vi.fn(() => ({ activities: [], loading: false, error: null, refetch: vi.fn() })),
  createActivity: vi.fn(),
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

describe("DealDetailPage", () => {
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
});
