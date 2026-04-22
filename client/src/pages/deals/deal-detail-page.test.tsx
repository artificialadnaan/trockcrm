// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { DealDetailPage } from "./deal-detail-page";

const mocks = vi.hoisted(() => ({
  useDealDetailMock: vi.fn(),
  useCompanyDetailMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  useAuthMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  useTasksMock: vi.fn(),
  useActivitiesMock: vi.fn(),
  updateDealMock: vi.fn(),
  deleteDealMock: vi.fn(),
  dealFormMock: vi.fn(),
  refetchMock: vi.fn(),
}));

const scrollIntoViewMock = vi.fn();
const focusMock = vi.fn();

vi.mock("@/hooks/use-deals", () => ({
  useDealDetail: mocks.useDealDetailMock,
  updateDeal: mocks.updateDealMock,
  deleteDeal: mocks.deleteDealMock,
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
  createActivity: vi.fn(),
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
vi.mock("@/components/deals/deal-form", () => ({
  DealForm: (props: { deal: { name: string }; onSuccess: () => void }) => {
    mocks.dealFormMock(props);
    return <button onClick={props.onSuccess}>Save {props.deal.name}</button>;
  },
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    className,
  }: {
    children: ReactNode;
    onClick?: () => void;
    className?: string;
  }) => (
    <button className={className} onClick={onClick}>
      {children}
    </button>
  ),
}));

const baseDeal = {
  id: "deal-1",
  name: "Hill Place Interior Upgrade",
  dealNumber: "TR-2026-0001",
  stageId: "stage-estimating",
  pipelineDisposition: "opportunity",
  workflowRoute: "estimating",
  assignedRepId: "rep-1",
  companyId: "company-1",
  propertyId: "property-1",
  sourceLeadId: "lead-1",
  primaryContactId: null,
  ddEstimate: null,
  bidEstimate: "450000",
  awardedAmount: null,
  changeOrderTotal: null,
  description: null,
  propertyAddress: "123 Main St",
  propertyCity: "Dallas",
  propertyState: "TX",
  propertyZip: "75201",
  projectTypeId: null,
  regionId: null,
  source: null,
  winProbability: null,
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
  stageEnteredAt: "2026-04-01T10:00:00.000Z",
  isActive: true,
  hubspotDealId: null,
  createdAt: "2026-04-01T10:00:00.000Z",
  updatedAt: "2026-04-11T10:00:00.000Z",
  proposalNotes: null,
  estimatingSubstage: null,
  proposalStatus: null,
  proposalSentAt: null,
  proposalAcceptedAt: null,
  proposalRevisionCount: 0,
  stageHistory: [],
  approvals: [],
  changeOrders: [],
  routingHistory: [],
  departmentOwnership: {
    currentDepartment: "sales",
    acceptanceStatus: "accepted",
    effectiveOwnerUserId: "rep-1",
    pendingDepartment: null,
  },
  postConversionEnrichment: {
    applies: true,
    isComplete: false,
    requiredFields: ["projectTypeId", "regionId", "expectedCloseDate", "nextStep"],
    missingFields: ["projectTypeId", "regionId", "expectedCloseDate", "nextStep"],
  },
};

function LocationProbe() {
  const location = useLocation();
  return <div data-location={`${location.pathname}${location.search}`} />;
}

function NavigateButton({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>Navigate</button>;
}

function renderDealDetail(initialEntry = "/deals/deal-1") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/deals/:id"
            element={
              <>
                <DealDetailPage />
                <LocationProbe />
                <NavigateButton to="/deals/deal-2" />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    );
  });

  return { container, root };
}

function clickButton(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text
  );
  expect(button).toBeTruthy();
  act(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("DealDetailPage", () => {
  let root: Root | null;
  let container: HTMLDivElement | null;

  beforeEach(() => {
    root = null;
    container = null;
    document.body.innerHTML = "";
    mocks.useDealDetailMock.mockReset();
    mocks.useCompanyDetailMock.mockReset();
    mocks.usePipelineStagesMock.mockReset();
    mocks.useAuthMock.mockReset();
    mocks.useTaskAssigneesMock.mockReset();
    mocks.useTasksMock.mockReset();
    mocks.useActivitiesMock.mockReset();
    mocks.updateDealMock.mockReset();
    mocks.deleteDealMock.mockReset();
    mocks.dealFormMock.mockReset();
    mocks.refetchMock.mockReset();
    scrollIntoViewMock.mockReset();
    focusMock.mockReset();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    // React 18 expects this flag in jsdom-based tests that call act().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    HTMLElement.prototype.focus = focusMock;

    mocks.useDealDetailMock.mockReturnValue({
      deal: baseDeal,
      loading: false,
      error: null,
      refetch: mocks.refetchMock,
    });
    mocks.useCompanyDetailMock.mockReturnValue({ company: { id: "company-1", name: "Acme" } });
    mocks.usePipelineStagesMock.mockReturnValue({
      stages: [
        { id: "stage-dd", name: "Due Diligence", slug: "dd", displayOrder: 1, isTerminal: false },
        { id: "stage-estimating", name: "Estimating", slug: "estimating", displayOrder: 2, isTerminal: false },
        { id: "stage-close-out", name: "Closed Won", slug: "closed_won", displayOrder: 9, isTerminal: true },
      ],
    });
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "director-1",
        displayName: "Dana Director",
        role: "director",
        officeId: "office-1",
      },
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
    mocks.useActivitiesMock.mockReturnValue({
      activities: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("renders the enrichment panel before the working tabs when post-conversion setup is incomplete", () => {
    ({ container, root } = renderDealDetail());

    expect(container?.textContent).toContain("Complete Deal Setup");
    expect(container?.textContent).toContain("Project Type");
    expect(container?.textContent).toContain("Region");

    const setupHeading = Array.from(container?.querySelectorAll("h2, h3") ?? []).find((node) =>
      node.textContent?.includes("Complete Deal Setup")
    );
    const overviewTab = Array.from(container?.querySelectorAll("button") ?? []).find((node) =>
      node.textContent?.trim() === "Overview"
    );

    expect(setupHeading).toBeTruthy();
    expect(overviewTab).toBeTruthy();
    expect(
      (setupHeading as HTMLElement).compareDocumentPosition(overviewTab as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("keeps a dismissed enrichment panel hidden across tab changes and resets it after remount", () => {
    ({ container, root } = renderDealDetail());

    clickButton(container as HTMLElement, "Dismiss");
    expect(container?.textContent).not.toContain("Complete Deal Setup");

    clickButton(container as HTMLElement, "Lead");
    clickButton(container as HTMLElement, "Overview");
    expect(container?.textContent).not.toContain("Complete Deal Setup");

    act(() => {
      root?.unmount();
    });
    container?.remove();

    ({ container, root } = renderDealDetail());
    expect(container?.textContent).toContain("Complete Deal Setup");
  });

  it("resets the dismissed state when navigating to a different deal id", () => {
    mocks.useDealDetailMock.mockImplementation((dealId?: string) => ({
      deal: {
        ...baseDeal,
        id: dealId ?? "deal-1",
        dealNumber: dealId === "deal-2" ? "TR-2026-0002" : "TR-2026-0001",
        name: dealId === "deal-2" ? "Elm Ridge Exterior Refresh" : baseDeal.name,
      },
      loading: false,
      error: null,
      refetch: mocks.refetchMock,
    }));

    ({ container, root } = renderDealDetail());

    clickButton(container as HTMLElement, "Dismiss");
    expect(container?.textContent).not.toContain("Complete Deal Setup");

    clickButton(container as HTMLElement, "Navigate");

    expect(container?.textContent).toContain("Elm Ridge Exterior Refresh");
    expect(container?.textContent).toContain("Complete Deal Setup");
  });

  it("opens the existing deal form from the enrichment panel", async () => {
    ({ container, root } = renderDealDetail());

    clickButton(container as HTMLElement, "Project Type");

    expect(container?.textContent).toContain("Complete Deal Setup");
    expect(container?.textContent).toContain("Save Hill Place Interior Upgrade");

    const saveButton = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Save Hill Place Interior Upgrade")
    );
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.refetchMock).toHaveBeenCalledTimes(1);
  });

  it("switches back to overview and focuses the next-step area when requested from the panel", () => {
    ({ container, root } = renderDealDetail("/deals/deal-1?tab=lead&enrichment=1"));

    expect(container?.textContent).toContain("Lead Form");
    expect(container?.querySelector("[data-location]")?.getAttribute("data-location")).toBe("/deals/deal-1?tab=lead");

    clickButton(container as HTMLElement, "Next Step");

    expect(container?.textContent).toContain("Overview Tab");
    expect(container?.textContent).toContain("Next Step Editor");
    expect(scrollIntoViewMock).toHaveBeenCalled();
    expect(focusMock).toHaveBeenCalled();
  });
});
