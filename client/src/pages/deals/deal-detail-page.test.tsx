// @vitest-environment jsdom

import { act } from "react";
import { cloneElement, isValidElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { DealDetailPage, DealScopingReadOnlyPanel } from "./deal-detail-page";

const mocks = vi.hoisted(() => ({
  useDealDetailMock: vi.fn(),
  useCompanyDetailMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  useAuthMock: vi.fn(),
  useActivitiesMock: vi.fn(),
  createActivityMock: vi.fn(),
  apiMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastInfoMock: vi.fn(),
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

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
  resolveApiBase: vi.fn(() => "/api"),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccessMock,
    info: mocks.toastInfoMock,
  },
}));

vi.mock("@/hooks/use-activities", () => ({
  useActivities: mocks.useActivitiesMock,
  createActivity: mocks.createActivityMock,
}));

vi.mock("@/lib/deal-utils", () => ({
  formatCurrency: vi.fn((value: number | string | null | undefined) => {
    const amount = Number(value ?? 0);
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
  }),
  bestEstimate: vi.fn((deal: { awardedAmount?: string | null; bidEstimate?: string | null; ddEstimate?: string | null }) =>
    Number(deal.awardedAmount ?? deal.bidEstimate ?? deal.ddEstimate ?? 0)
  ),
}));

vi.mock("@/components/ui/button", () => ({
  buttonVariants: vi.fn(({ variant, size }: { variant?: string; size?: string } = {}) =>
    ["mock-button", variant, size].filter(Boolean).join(" ")
  ),
  Button: ({
    children,
    render,
    onClick,
    disabled,
    type,
    title,
    className,
  }: {
    children: ReactNode;
    render?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    title?: string;
    className?: string;
  }) =>
    isValidElement(render) ? (
      cloneElement(render, { onClick, children } as Record<string, unknown>)
    ) : (
      <button type={type ?? "button"} disabled={disabled} onClick={onClick} title={title} className={className}>
        {children}
      </button>
    ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" data-disabled={disabled ? "true" : "false"} disabled={disabled} onClick={onClick}>
      {children}
    </button>
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
  DealScopingWorkspace: ({ onReadinessChanged }: { onReadinessChanged?: () => void }) => (
    <div>
      Scoping Tab
      <button type="button" onClick={onReadinessChanged}>Simulate scope saved</button>
    </div>
  ),
}));

vi.mock("@/components/files/deal-file-tab", () => ({
  DealFileTab: () => <div>Files Tab</div>,
}));

vi.mock("./deal-photos-tab", () => ({
  DealPhotosTab: () => <div>Photos Tab</div>,
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

vi.mock("./deal-contract-signed-card", () => ({
  DealContractSignedCard: () => <div>Contract Signed Card</div>,
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

vi.mock("@/components/call-recordings/recording-list", () => ({
  RecordingList: () => <div>Recording List</div>,
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

function mountPage(path = "/deals/deal-1") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/deals/:id" element={<DealDetailPage />} />
          <Route path="/deals/:id/photos" element={<DealDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
  });

  return {
    container,
    unmount() {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

function makeDealDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    dealNumber: "TR-2026-0001",
    name: "Palm Villas",
    stageId: "stage-estimating",
    workflowRoute: "normal",
    assignedRepId: "rep-1",
    assignedRepName: "Brett Rios",
    companyId: "company-1",
    companyName: "Dallas Independent SD",
    propertyId: "property-1",
    sourceLeadId: "lead-1",
    primaryContactId: null,
    ddEstimate: null,
    bidEstimate: "875000",
    awardedAmount: null,
    changeOrderTotal: "0",
    description: "Exterior refresh",
    propertyAddress: "123 Palm Way",
    propertyCity: "Dallas",
    propertyState: "TX",
    propertyZip: "75201",
    projectType: "Roofing",
    projectTypeId: "project-type-1",
    projectNumber: "DFW-1-12826-aa",
    regionId: null,
    source: "referral",
    winProbability: 50,
    procoreProjectId: 123456,
    procoreCompanyId: "598134325683880",
    procoreBidId: 78910,
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
    bidBoardProjectNumber: "DFW-3-12826-aa",
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
    bidBoardStatus: "Estimate in Progress",
    bidBoardTotalSales: "9876.54",
    bidBoardLastUpdatedAt: "2026-04-21T10:00:00.000Z",
    bidBoardAssignedPm: null,
    readOnlySyncedAt: "2026-04-21T10:00:00.000Z",
    isRfpTriggerEnabled: true,
    bidBoardOwnership: {
      isOwned: true,
      sourceOfTruth: "bid_board" as const,
      handoffStageSlug: "estimate_in_progress",
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
  let mounted: ReturnType<typeof mountPage> | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
    mocks.useCompanyDetailMock.mockReset();
    mocks.useDealDetailMock.mockReset();
    mocks.usePipelineStagesMock.mockReset();
    mocks.useAuthMock.mockReset();
    mocks.useActivitiesMock.mockReset();
    mocks.apiMock.mockReset();
    mocks.toastSuccessMock.mockReset();
    mocks.toastInfoMock.mockReset();
    mocks.apiMock.mockImplementation((url: string, options?: { method?: string }) => {
      if (url.includes("/photos")) {
        return Promise.resolve({ pagination: { total: 0 } });
      }
      if (url.includes("/scoping-intake/readiness")) {
        return Promise.resolve({ readiness: { status: "draft" } });
      }
      if (url.includes("/trigger-rfp") && options?.method === "POST") {
        return Promise.resolve({ success: true, status: "pending_outbox" });
      }
      return Promise.resolve({});
    });

    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "director-1",
        role: "director",
      },
    });

    mocks.usePipelineStagesMock.mockReturnValue({
      stages: [
        { id: "stage-opportunity", name: "Opportunity", slug: "opportunity", workflowFamily: "standard_deal", displayOrder: 0, isTerminal: false },
        { id: "stage-estimating", name: "Estimating", slug: "estimating", workflowFamily: "standard_deal", displayOrder: 1, isTerminal: false },
        { id: "stage-service-estimating", name: "Service Estimating", slug: "service_estimating", workflowFamily: "service_deal", displayOrder: 2, isTerminal: false },
        { id: "stage-under-review", name: "Estimate Under Review", slug: "estimate_under_review", workflowFamily: "standard_deal", displayOrder: 2, isTerminal: false },
        { id: "stage-sent", name: "Estimate Sent to Client", slug: "estimate_sent_to_client", workflowFamily: "standard_deal", displayOrder: 3, isTerminal: false },
        { id: "stage-contract", name: "Contract", slug: "contract", workflowFamily: "standard_deal", displayOrder: 4, isTerminal: false },
        { id: "stage-won", name: "Won", slug: "won", workflowFamily: "standard_deal", displayOrder: 5, isTerminal: true },
        { id: "stage-lost", name: "Lost", slug: "lost", workflowFamily: "standard_deal", displayOrder: 6, isTerminal: true },
        { id: "historical-estimate-in-progress", name: "Estimate in Progress", slug: "estimate_in_progress", workflowFamily: "standard_deal", displayOrder: 7, isTerminal: false, isActivePipeline: false },
        { id: "historical-sent-to-production", name: "Sent to Production", slug: "sent_to_production", workflowFamily: "standard_deal", displayOrder: 8, isTerminal: true, isActivePipeline: false },
        { id: "historical-production-lost", name: "Production Lost", slug: "production_lost", workflowFamily: "standard_deal", displayOrder: 9, isTerminal: true, isActivePipeline: false },
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

  it("renders deal hero with name and stage badge", () => {
    const html = renderPage();

    expect(html).toContain("Palm Villas");
    expect(html).toContain("Estimate in Progress");
    expect(html).toContain("TR-2026-0001");
    expect(html).toContain("Dallas Independent SD");
  });

  it("renders all expected tabs", () => {
    const html = renderPage();

    expect(html).toContain("Overview");
    expect(html).toContain("Lead");
    expect(html).toContain("Scoping");
    expect(html).toContain("Files");
    expect(html).toContain("Photos");
    expect(html).toContain("Email");
    expect(html).toContain("Activity");
    expect(html).toContain("Timeline");
    expect(html).toContain("History");
    expect(html).toContain("Team");
    expect(html).toContain("Estimates");
  });

  it("renders right-rail with company, owner, and system IDs", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({ hubspotDealId: "hs_deal_82211" }),
    });

    const html = renderPage();

    expect(html).toContain("Company");
    expect(html).toContain("Dallas Independent SD");
    expect(html).toContain("Owner");
    expect(html).toContain("Brett Rios");
    expect(html).toContain("System IDs");
    expect(html).toContain("hs_deal_82211");
    expect(html).toContain("123456");
    expect(html).toContain("DFW-3-12826-aa");
  });

  it("renders project number as the primary deal identifier when assigned", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        dealNumber: "HS-319925219003",
        projectNumber: "DFW-1-12826-aa",
        hubspotDealId: "HS-319925219003",
      }),
    });

    const html = renderPage();

    expect(html).toContain("Project number");
    expect(html).toContain("DFW-1-12826-aa");
    expect(html).not.toContain("Not yet assigned");
  });

  it("falls back to muted deal number with caption when project number is missing", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        dealNumber: "HS-319925219003",
        projectNumber: null,
        hubspotDealId: "HS-319925219003",
      }),
    });

    const html = renderPage();

    expect(html).toContain("Project number");
    expect(html).toContain("HS-319925219003");
    expect(html).toContain("Not yet assigned");
    expect(html).toContain("text-slate-500");
  });

  it("shows deal number as Deal ID in system IDs regardless of project number state", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        dealNumber: "HS-319925219003",
        projectNumber: "DFW-1-12826-aa",
        hubspotDealId: "hubspot-system-id",
      }),
    });

    const html = renderPage();

    expect(html).toContain("System IDs");
    expect(html).toContain("Deal ID");
    expect(html).toContain("HS-319925219003");
    expect(html).toContain("hubspot-system-id");
  });

  it("displays project type with proper casing", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        projectType: "Exterior Renovation",
      }),
    });

    const html = renderPage();

    expect(html).toContain("Exterior Renovation");
    expect(html).not.toContain("exterior renovation");
  });

  it("tab change updates active tab", () => {
    mounted = mountPage();

    const emailTab = mounted.container.querySelector('button[aria-label="Email"]');
    expect(emailTab).not.toBeNull();

    act(() => {
      emailTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain("Email Tab");
    expect(mounted.container.textContent).not.toContain("Overview Tab");
  });

  it("stage change action triggers handler", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        isBidBoardOwned: false,
        bidBoardOwnership: null,
        bidBoardStageSlug: null,
        bidBoardStatus: null,
        readOnlySyncedAt: null,
      }),
    });

    mounted = mountPage();

    const contractButton = Array.from(mounted.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Contract")
    );
    expect(contractButton).not.toBeNull();

    act(() => {
      contractButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain("Stage Dialog");
  });

  it("renders pipeline progress from canonical deal stages", () => {
    const html = renderPage();

    expect(html).toContain("Pipeline progress");
    expect(html).toContain('data-stage-slug="opportunity"');
    expect(html).toContain('data-stage-slug="estimating"');
    expect(html).toContain('data-stage-slug="estimate_under_review"');
    expect(html).toContain('data-stage-slug="estimate_sent_to_client"');
    expect(html).toContain('data-stage-slug="contract"');
    expect(html).toContain('data-stage-slug="won"');
    expect(html).toContain('data-stage-slug="lost"');
  });

  it("uses service estimating in pipeline progress for service workflow deals", () => {
    mocks.usePipelineStagesMock.mockReturnValueOnce({
      stages: [
        { id: "stage-opportunity", name: "Opportunity", slug: "opportunity", workflowFamily: "standard_deal", displayOrder: 0, isTerminal: false },
        { id: "stage-estimating", name: "Estimating", slug: "estimating", workflowFamily: "standard_deal", displayOrder: 1, isTerminal: false },
        { id: "stage-service-estimating", name: "Service Estimating", slug: "service_estimating", workflowFamily: "service_deal", displayOrder: 1, isTerminal: false },
        { id: "stage-under-review", name: "Estimate Under Review", slug: "estimate_under_review", workflowFamily: "service_deal", displayOrder: 2, isTerminal: false },
        { id: "stage-sent", name: "Estimate Sent to Client", slug: "estimate_sent_to_client", workflowFamily: "service_deal", displayOrder: 3, isTerminal: false },
        { id: "stage-contract", name: "Contract", slug: "contract", workflowFamily: "service_deal", displayOrder: 4, isTerminal: false },
        { id: "stage-won", name: "Won", slug: "won", workflowFamily: "service_deal", displayOrder: 5, isTerminal: true },
        { id: "stage-lost", name: "Lost", slug: "lost", workflowFamily: "service_deal", displayOrder: 6, isTerminal: true },
      ],
    });
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "stage-service-estimating",
        workflowRoute: "service",
        isBidBoardOwned: false,
        bidBoardOwnership: null,
      }),
    });

    const html = renderPage();

    expect(html).toContain('data-stage-slug="service_estimating"');
    expect(html).not.toContain('data-stage-slug="estimating"');
  });

  it("edit button navigates to edit page", () => {
    const html = renderPage();

    expect(html).toContain('href="/deals/deal-1/edit"');
    expect(html).toContain("Edit");
  });

  it("shows unknown SLA state when stage age is unavailable", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({ stageEnteredAt: null }),
    });

    const html = renderPage();

    expect(html).toContain("Days in stage");
    expect(html).toContain("SLA status");
    expect(html).toContain("Unknown");
    expect(html).toContain("No data");
    expect(html).not.toContain("On track");
    expect(html).not.toContain("Current");
  });

  it("shows Bid Board ownership messaging while preserving valid CRM stage controls", () => {
    const html = renderPage();

    expect(html).toContain("Bid Board now owns downstream progression");
    expect(html).toContain("Bid Board is now the source of truth once this deal entered estimating.");
    expect(html).toContain("Move Stage");
    expect(html).toContain("Bid Board managed");
  });

  it("renders the Bid Board summary panel only for BidBoard-owned deals", () => {
    const ownedHtml = renderPage();

    expect(ownedHtml).toContain("Bid Board summary");
    expect(ownedHtml).toContain("Estimate in Progress");

    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        isBidBoardOwned: false,
        bidBoardOwnership: null,
      }),
    });
    const crmOwnedHtml = renderPage();

    expect(crmOwnedHtml).not.toContain("Bid Board summary");
  });

  it("does not render the Bid Board summary panel for HubSpot-sourced deals", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        hubspotDealId: "hubspot-123",
        isBidBoardOwned: true,
      }),
    });

    const html = renderPage();

    expect(html).not.toContain("Bid Board summary");
  });

  it("formats Bid Board estimate and falls back when assigned PM is missing", () => {
    const html = renderPage();

    expect(html).toContain("$9,877");
    expect(html).toContain("Not yet assigned");
  });

  it("renders an Open in Bid Board link only when both Procore ids exist", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        procoreCompanyId: "598134325683880",
        procoreBidId: 123456,
      }),
    });

    const linkedHtml = renderPage();

    expect(linkedHtml).toContain("Open in Bid Board");
    expect(linkedHtml).toContain(
      "https://us02.procore.com/webclients/host/companies/598134325683880/tools/bid-board/project/123456/details"
    );

    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        procoreCompanyId: null,
        procoreBidId: 123456,
      }),
    });
    const missingCompanyHtml = renderPage();

    expect(missingCompanyHtml).not.toContain("Open in Bid Board");
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

  it("renders an unknown RFP status with a safe fallback label", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        rfpApprovalStatus: "frobnicate",
      }),
    });

    const html = renderPage();

    expect(html).toContain("Unknown RFP status");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown RFP status"),
      expect.objectContaining({ rfpApprovalStatus: "frobnicate", dealId: "deal-1" })
    );
  });

  it("shows Trigger RFP disabled on untriggered Opportunity deals until scope is ready", () => {
    mocks.useAuthMock.mockReturnValueOnce({
      user: {
        id: "rep-1",
        role: "rep",
      },
    });
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "stage-opportunity",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
        bidBoardOwnership: null,
        rfpApprovalStatus: null,
        rfpApprovalRequestedAt: null,
      }),
    });

    const html = renderPage();

    expect(html).toContain("Trigger RFP");
    expect(html).toContain("Complete Opportunity Scope to enable");
    expect(html).toContain("disabled");
    expect(html).toContain("bg-brand-red");
    expect(html).toContain("font-black uppercase");
  });

  it("hides Trigger RFP outside Opportunity, when already triggered, and when Bid Board owned", () => {
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "rep-1",
        role: "rep",
      },
    });
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "stage-estimating",
        isBidBoardOwned: false,
        bidBoardOwnership: null,
      }),
    });
    expect(renderPage()).not.toContain("Trigger RFP");

    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "stage-opportunity",
        isBidBoardOwned: false,
        bidBoardOwnership: null,
        rfpApprovalStatus: "pending_outbox",
      }),
    });
    expect(renderPage()).not.toContain("Trigger RFP");

    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "stage-opportunity",
        isBidBoardOwned: true,
      }),
    });
    expect(renderPage()).not.toContain("Trigger RFP");
  });

  it("hides Trigger RFP from directors and non-assigned reps", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "stage-opportunity",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
        bidBoardOwnership: null,
        rfpApprovalStatus: null,
        rfpApprovalRequestedAt: null,
      }),
    });
    expect(renderPage()).not.toContain("Trigger RFP");

    mocks.useAuthMock.mockReturnValueOnce({
      user: {
        id: "rep-2",
        role: "rep",
      },
    });
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "stage-opportunity",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
        bidBoardOwnership: null,
        rfpApprovalStatus: null,
        rfpApprovalRequestedAt: null,
      }),
    });
    expect(renderPage()).not.toContain("Trigger RFP");
  });

  it("enables Trigger RFP after readiness passes and posts only after confirmation", async () => {
    const refetch = vi.fn();
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "rep-1",
        role: "rep",
      },
    });
    mocks.apiMock.mockImplementation((url: string, options?: { method?: string }) => {
      if (url.includes("/photos")) {
        return Promise.resolve({ pagination: { total: 0 } });
      }
      if (url.includes("/scoping-intake/readiness")) {
        return Promise.resolve({ readiness: { status: "ready" } });
      }
      if (url.includes("/trigger-rfp") && options?.method === "POST") {
        return Promise.resolve({ success: true, status: "pending_outbox" });
      }
      return Promise.resolve({});
    });
    mocks.useDealDetailMock.mockReturnValue({
      loading: false,
      error: null,
      refetch,
      deal: makeDealDetail({
        stageId: "stage-opportunity",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
        bidBoardOwnership: null,
        rfpApprovalStatus: null,
        rfpApprovalRequestedAt: null,
      }),
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    mounted = mountPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const triggerButton = Array.from(mounted.container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Trigger RFP")
    ) as HTMLButtonElement | undefined;
    expect(triggerButton).toBeTruthy();
    expect(triggerButton?.disabled).toBe(false);

    await act(async () => {
      triggerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(confirmSpy).toHaveBeenCalledWith(
      "Send this deal to RFP review? This will notify the approval team and cannot be undone from this screen."
    );
    expect(mocks.apiMock).not.toHaveBeenCalledWith("/deals/deal-1/trigger-rfp", { method: "POST" });

    await act(async () => {
      triggerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-1/trigger-rfp", { method: "POST" });
    expect(mocks.toastSuccessMock).toHaveBeenCalledWith("RFP request sent to approval team.");
    expect(refetch).toHaveBeenCalled();
  });

  it("hides Trigger RFP when the server-side RFP feature flag is disabled", async () => {
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "rep-1",
        role: "rep",
      },
    });
    mocks.useDealDetailMock.mockReturnValue({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "stage-opportunity",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
        bidBoardOwnership: null,
        rfpApprovalStatus: null,
        rfpApprovalRequestedAt: null,
        isRfpTriggerEnabled: false,
      }),
    });

    mounted = mountPage();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mounted.container.textContent).not.toContain("Trigger RFP");
    expect(mocks.apiMock).not.toHaveBeenCalledWith("/deals/deal-1/scoping-intake/readiness");
  });

  it("refreshes Trigger RFP readiness after the scoping workspace reports a readiness change", async () => {
    let readinessStatus: "draft" | "ready" = "draft";
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "rep-1",
        role: "rep",
      },
    });
    mocks.apiMock.mockImplementation((url: string) => {
      if (url.includes("/photos")) {
        return Promise.resolve({ pagination: { total: 0 } });
      }
      if (url.includes("/scoping-intake/readiness")) {
        return Promise.resolve({ readiness: { status: readinessStatus } });
      }
      return Promise.resolve({});
    });
    mocks.useDealDetailMock.mockReturnValue({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "stage-opportunity",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
        bidBoardOwnership: null,
        rfpApprovalStatus: null,
        rfpApprovalRequestedAt: null,
      }),
    });

    mounted = mountPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const triggerButton = Array.from(mounted.container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Trigger RFP")
    ) as HTMLButtonElement | undefined;
    expect(triggerButton?.disabled).toBe(true);

    readinessStatus = "ready";
    const saveButton = Array.from(mounted.container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Simulate scope saved")
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(triggerButton?.disabled).toBe(false);
  });

  it("keeps trigger success separate from a later refetch failure", async () => {
    const refetch = vi.fn().mockRejectedValue(new Error("network down"));
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "rep-1",
        role: "rep",
      },
    });
    mocks.apiMock.mockImplementation((url: string, options?: { method?: string }) => {
      if (url.includes("/photos")) {
        return Promise.resolve({ pagination: { total: 0 } });
      }
      if (url.includes("/scoping-intake/readiness")) {
        return Promise.resolve({ readiness: { status: "ready" } });
      }
      if (url.includes("/trigger-rfp") && options?.method === "POST") {
        return Promise.resolve({ success: true, status: "pending_outbox" });
      }
      return Promise.resolve({});
    });
    mocks.useDealDetailMock.mockReturnValue({
      loading: false,
      error: null,
      refetch,
      deal: makeDealDetail({
        stageId: "stage-opportunity",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
        bidBoardOwnership: null,
        rfpApprovalStatus: null,
        rfpApprovalRequestedAt: null,
      }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mounted = mountPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const triggerButton = Array.from(mounted.container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Trigger RFP")
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      triggerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.toastSuccessMock).toHaveBeenCalledWith("RFP request sent to approval team.");
    expect(mocks.toastInfoMock).toHaveBeenCalledWith("RFP triggered. Refresh page to see updated status.");
    expect(mounted.container.textContent).not.toContain("Failed to trigger RFP review.");
  });

  it("shows an inline error when the trigger request itself fails", async () => {
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "rep-1",
        role: "rep",
      },
    });
    mocks.apiMock.mockImplementation((url: string, options?: { method?: string }) => {
      if (url.includes("/photos")) {
        return Promise.resolve({ pagination: { total: 0 } });
      }
      if (url.includes("/scoping-intake/readiness")) {
        return Promise.resolve({ readiness: { status: "ready" } });
      }
      if (url.includes("/trigger-rfp") && options?.method === "POST") {
        return Promise.reject(new Error("RFP review has already been triggered for this deal."));
      }
      return Promise.resolve({});
    });
    mocks.useDealDetailMock.mockReturnValue({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "stage-opportunity",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
        bidBoardOwnership: null,
        rfpApprovalStatus: null,
        rfpApprovalRequestedAt: null,
      }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mounted = mountPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const triggerButton = Array.from(mounted.container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Trigger RFP")
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      triggerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.toastSuccessMock).not.toHaveBeenCalled();
    expect(mounted.container.textContent).toContain("RFP review has already been triggered for this deal.");
  });

  it("keeps estimating manually reachable for owned deals that are still before the boundary", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "stage-opportunity",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
        bidBoardOwnership: null,
      }),
    });

    const html = renderPage();
    const managedCount = (html.match(/Bid Board managed/g) ?? []).length;

    expect(html).toContain("Move Stage");
    expect(html).toContain('data-disabled="false">Estimating');
    expect(managedCount).toBe(0);
  });

  it("hides legacy stage labels from the move-stage menu when mixed stage config still exists", () => {
    mocks.usePipelineStagesMock.mockReturnValueOnce({
      stages: [
        { id: "stage-opportunity", name: "Opportunity", slug: "opportunity", workflowFamily: "standard_deal", displayOrder: 0, isTerminal: false },
        { id: "legacy-estimating", name: "Estimating", slug: "estimating", workflowFamily: "standard_deal", displayOrder: 1, isTerminal: false },
        { id: "stage-service-estimating", name: "Service Estimating", slug: "service_estimating", workflowFamily: "service_deal", displayOrder: 2, isTerminal: false },
        { id: "stage-under-review", name: "Estimate Under Review", slug: "estimate_under_review", workflowFamily: "standard_deal", displayOrder: 6, isTerminal: false },
        { id: "stage-sent", name: "Estimate Sent to Client", slug: "estimate_sent_to_client", workflowFamily: "standard_deal", displayOrder: 7, isTerminal: false },
        { id: "stage-contract", name: "Contract", slug: "contract", workflowFamily: "standard_deal", displayOrder: 8, isTerminal: false },
        { id: "stage-won", name: "Won", slug: "won", workflowFamily: "standard_deal", displayOrder: 9, isTerminal: true },
        { id: "stage-lost", name: "Lost", slug: "lost", workflowFamily: "standard_deal", displayOrder: 10, isTerminal: true },
        { id: "legacy-estimate-in-progress", name: "Estimate in Progress", slug: "estimate_in_progress", workflowFamily: "standard_deal", displayOrder: 11, isTerminal: false, isActivePipeline: false },
        { id: "legacy-bid-sent", name: "Bid Sent", slug: "bid_sent", workflowFamily: "standard_deal", displayOrder: 12, isTerminal: false, isActivePipeline: false },
        { id: "legacy-production", name: "In Production", slug: "in_production", workflowFamily: "standard_deal", displayOrder: 13, isTerminal: false, isActivePipeline: false },
        { id: "legacy-won", name: "Closed Won", slug: "closed_won", workflowFamily: "standard_deal", displayOrder: 14, isTerminal: true, isActivePipeline: false },
        { id: "legacy-sent-to-production", name: "Sent to Production", slug: "sent_to_production", workflowFamily: "standard_deal", displayOrder: 15, isTerminal: true, isActivePipeline: false },
        { id: "legacy-lost", name: "Closed Lost", slug: "closed_lost", workflowFamily: "standard_deal", displayOrder: 16, isTerminal: true, isActivePipeline: false },
      ],
    });
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "stage-opportunity",
        isBidBoardOwned: false,
        bidBoardStageSlug: null,
        readOnlySyncedAt: null,
        bidBoardOwnership: null,
      }),
    });

    const html = renderPage();

    expect(html).toContain("Estimating");
    expect(html).toContain("Estimate Under Review");
    expect(html).toContain("Contract");
    expect(html).not.toContain("Bid Sent");
    expect(html).not.toContain("Closed Won");
    expect(html).not.toContain("Closed Lost");
    expect(html).not.toContain("In Production");
    expect(html).not.toContain("Sent to Production");
  });

  it("treats legacy estimating as the handoff boundary when the server reports a canonical handoff slug", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        bidBoardOwnership: {
          ...makeDealDetail().bidBoardOwnership,
          handoffStageSlug: "estimate_in_progress",
        },
      }),
    });

    const html = renderPage();
    const managedCount = (html.match(/Bid Board managed/g) ?? []).length;

    expect(html).toContain("Move Stage");
    expect(managedCount).toBe(5);
  });

  it("shows the Close-Out tab for canonical sent-to-production deals", () => {
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({
        stageId: "historical-sent-to-production",
        workflowRoute: "normal",
        bidBoardStageSlug: "sent_to_production",
      }),
    });

    const html = renderPage();

    expect(html).toContain("Close-Out");
  });

  it("renders a read-only scoping panel with clear alternate CRM actions after estimating handoff", () => {
    const html = renderToStaticMarkup(
      <DealScopingReadOnlyPanel
        ownership={makeDealDetail().bidBoardOwnership}
        onOpenTab={() => undefined}
      />
    );

    expect(html).toContain("Opportunity scope is now read-only in CRM");
    expect(html).toContain("Open Overview");
    expect(html).toContain("Open Files");
    expect(html).toContain("Open Activity");
    expect(html).toContain("Open Team");
  });
});
