// @vitest-environment jsdom

import { act } from "react";
import { cloneElement, isValidElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { DealDetailPage } from "./deal-detail-page";
// Type-only import: survives the vi.mock of @/hooks/use-deals (mocks replace runtime values, not types)
// so the FINDING-1 type guard below checks the REAL UpdateDealPayload shape at typecheck:tests time.
import type { UpdateDealPayload } from "@/hooks/use-deals";

// Mirrors deal-detail-page.test.tsx scaffolding, but additionally surfaces the dedicated
// `updateDealEstimator` mutation so the estimator picker (admin/director only, native <select>)
// can be exercised end to end.
const mocks = vi.hoisted(() => ({
  useDealDetailMock: vi.fn(),
  useCompanyDetailMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  useAuthMock: vi.fn(),
  useActivitiesMock: vi.fn(),
  createActivityMock: vi.fn(),
  updateDealMock: vi.fn(),
  updateDealEstimatorMock: vi.fn(),
  apiMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastInfoMock: vi.fn(),
  toastErrorMock: vi.fn(),
  useSalesRepsMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  useDealDetail: mocks.useDealDetailMock,
  deleteDeal: vi.fn(),
  updateDeal: mocks.updateDealMock,
  updateDealEstimator: mocks.updateDealEstimatorMock,
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

vi.mock("@/hooks/use-sales-reps", () => ({
  useSalesReps: mocks.useSalesRepsMock,
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccessMock,
    info: mocks.toastInfoMock,
    error: mocks.toastErrorMock,
  },
}));

vi.mock("@/hooks/use-activities", () => ({
  useActivities: mocks.useActivitiesMock,
  createActivity: mocks.createActivityMock,
}));

vi.mock("@/lib/deal-utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/deal-utils")>("@/lib/deal-utils");
  return {
    ...actual,
    formatCurrency: vi.fn((value: number | string | null | undefined) => {
      const amount = Number(value ?? 0);
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
    }),
    bestEstimate: vi.fn((deal: { awardedAmount?: string | null; bidEstimate?: string | null; ddEstimate?: string | null }) =>
      Number(deal.awardedAmount ?? deal.bidEstimate ?? deal.ddEstimate ?? 0)
    ),
  };
});

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
  Badge: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => <span {...props}>{children}</span>,
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
  DealScopingWorkspace: () => <div>Scoping Tab</div>,
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
  TaskCreateDialog: () => <div>New Task</div>,
}));

vi.mock("@/components/call-recordings/recording-list", () => ({
  RecordingList: () => <div>Recording List</div>,
}));

function renderPage(path = "/deals/deal-1") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
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
  const base = {
    id: "deal-1",
    dealNumber: "TR-2026-0001",
    name: "Palm Villas",
    stageId: "stage-estimating",
    workflowRoute: "normal",
    assignedRepId: "rep-1",
    assignedRepName: "Brett Rios",
    estimatorUserId: "est-1",
    estimatorUserName: "Casey Estimator",
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
    hubspotDealId: null as string | null,
    isHubspotSourced: false,
    bidBoardProjectNumber: "DFW-3-12826-aa",
    emailCount: 5,
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-21T10:00:00.000Z",
    proposalStatus: "drafting",
    proposalSentAt: null,
    proposalAcceptedAt: null,
    proposalRevisionCount: 0,
    proposalNotes: null,
    estimatingSubstage: "building_estimate",
    isBidBoardOwned: false,
    bidBoardOwnership: null,
    stageHistory: [],
    approvals: [],
    changeOrders: [],
  };
  return { ...base, ...overrides } as typeof base;
}

describe("DealDetailPage estimator picker", () => {
  let mounted: ReturnType<typeof mountPage> | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
    vi.clearAllMocks();

    mocks.apiMock.mockImplementation((url: string) => {
      if (url.includes("/photos")) return Promise.resolve({ pagination: { total: 0 } });
      if (url.includes("/scoping-intake/readiness")) return Promise.resolve({ readiness: { status: "draft" } });
      return Promise.resolve({});
    });

    mocks.useAuthMock.mockReturnValue({ user: { id: "director-1", role: "director", activeOfficeId: "office-1" } });

    mocks.usePipelineStagesMock.mockReturnValue({
      stages: [
        { id: "stage-estimating", name: "Estimating", slug: "estimating", workflowFamily: "standard_deal", displayOrder: 1, isTerminal: false },
        { id: "stage-won", name: "Won", slug: "won", workflowFamily: "standard_deal", displayOrder: 5, isTerminal: true },
      ],
    });

    mocks.useCompanyDetailMock.mockReturnValue({ company: { id: "company-1", name: "Alpha Roofing" } });

    mocks.useActivitiesMock.mockReturnValue({ activities: [], loading: false, error: null, refetch: vi.fn() });

    mocks.useDealDetailMock.mockReturnValue({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail(),
    });

    mocks.useSalesRepsMock.mockReturnValue({
      salesReps: [
        { id: "rep-1", displayName: "Brett Rios", email: "brett@example.com" },
        { id: "est-2", displayName: "Dana Estimator", email: "dana@example.com" },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    mocks.updateDealEstimatorMock.mockResolvedValue({ deal: makeDealDetail() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows an editable estimator <select> to directors and saves through the dedicated route", async () => {
    const refetch = vi.fn();
    mocks.useAuthMock.mockReturnValueOnce({ user: { id: "director-1", role: "director", activeOfficeId: "office-1" } });
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch,
      deal: makeDealDetail({ estimatorUserId: "est-1", estimatorUserName: "Casey Estimator" }),
    });

    mounted = mountPage();

    const select = mounted.container.querySelector('select[aria-label="Edit estimator"]') as HTMLSelectElement | null;
    expect(select).toBeTruthy();

    await act(async () => {
      select!.value = "est-2";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // FINDING 2: the office option is forwarded, mirroring the deal record load. With no officeId in
    // the URL it resolves to null (the default tenant), but the option is always present in the call.
    expect(mocks.updateDealEstimatorMock).toHaveBeenCalledWith("deal-1", "est-2", { officeId: null });
    expect(refetch).toHaveBeenCalled();
  });

  it("clears the estimator (null) when '— None —' is selected", async () => {
    mocks.useAuthMock.mockReturnValueOnce({ user: { id: "admin-1", role: "admin", activeOfficeId: "office-1" } });
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({ estimatorUserId: "est-1", estimatorUserName: "Casey Estimator" }),
    });

    mounted = mountPage();

    const select = mounted.container.querySelector('select[aria-label="Edit estimator"]') as HTMLSelectElement | null;
    expect(select).toBeTruthy();

    await act(async () => {
      select!.value = "";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(mocks.updateDealEstimatorMock).toHaveBeenCalledWith("deal-1", null, { officeId: null });
  });

  it("forwards the deal's office context (x-office-id tenant) on the estimator PATCH", async () => {
    mocks.useAuthMock.mockReturnValueOnce({ user: { id: "director-1", role: "director", activeOfficeId: "office-1" } });
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({ estimatorUserId: "est-1", estimatorUserName: "Casey Estimator" }),
    });

    // The detail route carries ?officeId — the same value useDealDetail loaded the record with. The
    // estimator PATCH must reuse it so a cross-office edit hits the right tenant, not the default one.
    mounted = mountPage("/deals/deal-1?officeId=office-9");

    const select = mounted.container.querySelector('select[aria-label="Edit estimator"]') as HTMLSelectElement | null;
    expect(select).toBeTruthy();

    await act(async () => {
      select!.value = "est-2";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(mocks.updateDealEstimatorMock).toHaveBeenCalledWith("deal-1", "est-2", { officeId: "office-9" });
  });

  it("admins see the editable estimator <select>", () => {
    mocks.useAuthMock.mockReturnValueOnce({ user: { id: "admin-1", role: "admin", activeOfficeId: "office-1" } });
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail(),
    });

    const html = renderPage();
    expect(html).toContain('aria-label="Edit estimator"');
    expect(html).toContain("— None —");
  });

  // FINDING 1: estimatorUserId/estimatorUserName are read-only/display-only on the Deal shape but are
  // EXCLUDED from UpdateDealPayload, so the generic (rep-reachable) updateDeal can never smuggle the
  // commission-bearing estimator field. The @ts-expect-error lines are verified at typecheck:tests
  // time; the runtime body is a no-op so the spec still EXECUTES under the runtime gate.
  it("type guard: the generic updateDeal payload cannot carry estimatorUserId / estimatorUserName", () => {
    // @ts-expect-error estimatorUserId is excluded from UpdateDealPayload (dedicated route only)
    const withEstimatorId: UpdateDealPayload = { estimatorUserId: "11111111-1111-4111-8111-111111111111" };
    // @ts-expect-error estimatorUserName is excluded from UpdateDealPayload (read-only/display-only)
    const withEstimatorName: UpdateDealPayload = { estimatorUserName: "Casey Estimator" };
    // An allowlisted field still type-checks, proving the Omit didn't break the generic payload.
    const allowed: UpdateDealPayload = { name: "Renamed" };
    void withEstimatorId;
    void withEstimatorName;
    expect(allowed.name).toBe("Renamed");
  });

  it("reps see the estimator read-only with a leadership-only note (no edit control)", () => {
    mocks.useAuthMock.mockReturnValueOnce({ user: { id: "rep-1", role: "rep", activeOfficeId: "office-1" } });
    mocks.useDealDetailMock.mockReturnValueOnce({
      loading: false,
      error: null,
      refetch: vi.fn(),
      deal: makeDealDetail({ assignedRepId: "rep-1", estimatorUserId: "est-1", estimatorUserName: "Casey Estimator" }),
    });

    const html = renderPage();
    expect(html).toContain("Casey Estimator");
    expect(html).toContain("Only admins and directors can edit the estimator.");
    expect(html).not.toContain('aria-label="Edit estimator"');
  });
});
