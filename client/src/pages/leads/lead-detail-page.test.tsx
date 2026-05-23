// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { LeadDetailPage } from "./lead-detail-page";

const mocks = vi.hoisted(() => ({
  useLeadDetailMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock("@/hooks/use-leads", () => ({
  useLeadDetail: mocks.useLeadDetailMock,
  getLeadStageMetadata: vi.fn((stageId: string, stages: Array<{ id: string; name: string; slug: string }>) => {
    const stage = stages.find((entry) => entry.id === stageId) ?? null;
    const slug = stage?.slug ?? null;
    return {
      stage,
      slug,
      label: stage?.name ?? "Lead",
      isCrmOwnedLeadStage: ["new_lead", "qualified_lead", "sales_validation_stage", "opportunity"].includes(slug ?? ""),
      isBoardStage: ["new_lead", "qualified_lead", "sales_validation_stage"].includes(slug ?? ""),
      isOpportunityStage: slug === "opportunity",
    };
  }),
  formatLeadPropertyLine: vi.fn(
    (lead: {
      property?: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null;
    }) =>
      [lead.property?.address, [lead.property?.city, lead.property?.state].filter(Boolean).join(", "), lead.property?.zip]
        .filter(Boolean)
        .join(" ")
  ),
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: mocks.usePipelineStagesMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("@/lib/sales-workflow", () => ({
  CRM_OWNED_LEAD_STAGE_SLUGS: [
    "new_lead",
    "qualified_lead",
    "sales_validation_stage",
    "opportunity",
  ],
  BID_BOARD_MIRRORED_STAGE_SLUGS: [
    "estimating",
    "bid_sent",
    "in_production",
    "close_out",
    "closed_won",
    "closed_lost",
  ],
}));

vi.mock("@/components/leads/lead-form", () => ({
  LeadForm: () => <div>Lead Form</div>,
  LeadQuestionnaireSummary: () => <div>Lead Questionnaire Summary</div>,
}));

vi.mock("@/components/leads/lead-timeline-tab", () => ({
  LeadTimelineTab: () => <div>Lead Timeline</div>,
}));

vi.mock("@/components/leads/lead-questionnaire-editor", () => ({
  LeadQuestionnaireEditor: () => <div>Lead Questionnaire Editor</div>,
}));

vi.mock("@/components/leads/lead-stage-badge", () => ({
  LeadStageBadge: ({ stageId, converted }: { stageId: string; converted?: boolean }) => (
    <span>{converted ? "Converted" : stageId}</span>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  buttonVariants: vi.fn(({ variant, size }: { variant?: string; size?: string } = {}) =>
    ["mock-button", variant, size].filter(Boolean).join(" ")
  ),
  Button: ({
    children,
    onClick,
    variant,
    size,
    type,
    className,
  }: {
    children: ReactNode;
    onClick?: () => void;
    variant?: string;
    size?: string;
    type?: "button" | "submit" | "reset";
    className?: string;
  }) => (
    <button
      type={type ?? "button"}
      data-variant={variant}
      data-size={size}
      className={className}
      onClick={onClick}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/leads/lead-convert-dialog", () => ({
  LeadConvertDialog: ({ open }: { open: boolean }) => (open ? <div>Lead Convert Dialog</div> : null),
}));

vi.mock("@/components/leads/lead-stage-change-dialog", () => ({
  LeadStageChangeDialog: ({ open }: { open: boolean }) => (open ? <div>Lead Stage Dialog</div> : null),
}));

vi.mock("@/components/call-recordings/recording-list", () => ({
  RecordingList: () => <div>Recording List</div>,
}));

vi.mock("@/components/activities/entity-activity-tab", () => ({
  EntityActivityTab: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div>Activity tab for {entityType}:{entityId}</div>
  ),
}));

vi.mock("@/components/email/lead-email-tab", () => ({
  LeadEmailTab: ({ leadId }: { leadId: string }) => <div>Lead Email Tab {leadId}</div>,
}));

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    id: "lead-1",
    companyId: "company-1",
    propertyId: "property-1",
    primaryContactId: "contact-1",
    name: "Alpha Roofing Follow-Up",
    stageId: "stage-sales-validation",
    assignedRepId: "rep-1",
    status: "open",
    source: "trade show",
    sourceCategory: "Referral",
    sourceDetail: "BOMA Expo",
    description: "Initial pre-RFP lead.",
    projectTypeId: "project-type-1",
    projectType: {
      id: "project-type-1",
      name: "Re-Roof",
      slug: "re_roof",
    },
    qualificationPayload: {},
    projectTypeQuestionPayload: {
      projectTypeId: "project-type-1",
      answers: {},
    },
    lastActivityAt: "2026-04-11T10:00:00.000Z",
    stageEnteredAt: "2026-04-10T10:00:00.000Z",
    convertedAt: null,
    isActive: true,
    createdAt: "2026-04-10T09:00:00.000Z",
    updatedAt: "2026-04-11T10:00:00.000Z",
    companyName: "Alpha Roofing",
    assignedRepName: "Brett Rios",
    property: {
      id: "property-1",
      name: "Dallas HQ",
      address: "123 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75201",
    },
    convertedDealId: null,
    convertedDealNumber: null,
    emailCount: 4,
    ...overrides,
  };
}

function makeQuestionnaire() {
  return {
    projectTypeId: "project-type-1",
    nodes: [],
    allNodes: [],
    answers: {},
  };
}

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function renderLeadDetail() {
  return normalize(
    renderToStaticMarkup(
      <MemoryRouter initialEntries={["/leads/lead-1"]}>
        <Routes>
          <Route path="/leads/:id" element={<LeadDetailPage />} />
        </Routes>
      </MemoryRouter>
    )
  );
}

function mountLeadDetail() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={["/leads/lead-1"]}>
        <Routes>
          <Route path="/leads/:id" element={<LeadDetailPage />} />
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

describe("LeadDetailPage", () => {
  let mounted: ReturnType<typeof mountLeadDetail> | null = null;

  beforeEach(() => {
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "rep-1",
        role: "rep",
      },
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
    mocks.usePipelineStagesMock.mockReset();
    mocks.useLeadDetailMock.mockReset();

    mocks.usePipelineStagesMock.mockReturnValue({
      stages: [
        { id: "stage-new-lead", name: "New Lead", slug: "new_lead" },
        { id: "stage-qualified-lead", name: "Qualified Lead", slug: "qualified_lead" },
        { id: "stage-sales-validation", name: "Sales Validation Stage", slug: "sales_validation_stage" },
        { id: "stage-opportunity", name: "Opportunity", slug: "opportunity" },
        { id: "stage-estimating", name: "Estimating", slug: "estimating" },
      ],
    });

    mocks.useLeadDetailMock.mockReturnValue({
      lead: makeLead(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("renders lead hero with name and stage badge", () => {
    const html = renderLeadDetail();

    expect(html).toContain("Alpha Roofing Follow-Up");
    expect(html).toContain("stage-sales-validation");
    expect(html).toContain("Alpha Roofing");
    expect(html).toContain("123 Main St");
  });

  it("renders all expected tabs", () => {
    const html = renderLeadDetail();

    expect(html).toContain("Timeline");
    expect(html).toContain("Questionnaire");
    expect(html).toContain("Activity");
    expect(html).toContain("Recordings");
  });

  it("renders the email count badge from the lead payload and lazy-loads the tab", () => {
    mounted = mountLeadDetail();

    const emailsTab = mounted.container.querySelector('button[aria-label="Emails"]');
    expect(emailsTab?.textContent).toContain("4");
    expect(mounted.container.textContent).not.toContain("Lead Email Tab lead-1");

    act(() => {
      emailsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain("Lead Email Tab lead-1");
  });

  it("renders right-rail with company, owner, property, source, and system references", () => {
    const html = renderLeadDetail();

    expect(html).toContain("Company");
    expect(html).toContain("Alpha Roofing");
    expect(html).toContain("Owner");
    expect(html).toContain("Brett Rios");
    expect(html).toContain("Property");
    expect(html).toContain("Dallas HQ");
    expect(html).toContain("Source");
    expect(html).toContain("trade show");
    expect(html).toContain("BOMA Expo");
    expect(html).toContain("System references");
    expect(html).toContain("Tracked internally");
    expect(html).not.toContain("lead-1");
  });

  it("uses the questionnaire estimated value in the prominent KPI", () => {
    mocks.useLeadDetailMock.mockReturnValue({
      lead: makeLead({
        forecastRevenue: null,
        qualificationBudgetAmount: null,
        qualificationPayload: { estimated_value: 2200 },
      }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderLeadDetail();
    const estimatedValueKpi = html.slice(html.indexOf("Estimated value"), html.indexOf("Days in stage"));

    expect(estimatedValueKpi).toContain("$2,200");
    expect(estimatedValueKpi).not.toContain("Unknown");
  });

  it("renders the primary contact link with the resolved contact name", () => {
    mocks.useLeadDetailMock.mockReturnValue({
      lead: makeLead({
        primaryContactId: "contact-1",
        primaryContactName: "Morgan Carter",
      }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderLeadDetail();

    expect(html).toContain('href="/contacts/contact-1"');
    expect(html).toContain("Morgan Carter");
    expect(html).not.toContain("Primary contact linked");
  });

  it("shows owner badges for the associated company and primary contact", () => {
    mocks.useLeadDetailMock.mockReturnValue({
      lead: makeLead({
        companyOwnerUserId: "company-owner-1",
        companyOwnerUserName: "Alicia Adams",
        primaryContactId: "contact-1",
        primaryContactName: "Morgan Carter",
        primaryContactOwnerUserId: "contact-owner-1",
        primaryContactOwnerUserName: "Kai Morgan",
      }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderLeadDetail();

    expect(html).toContain("Alicia Adams");
    expect(html).toContain("Kai Morgan");
    expect(html).toContain(">AA<");
    expect(html).toContain(">KM<");
  });

  it("shows Unassigned owner state for unowned associated company and primary contact", () => {
    mocks.useLeadDetailMock.mockReturnValue({
      lead: makeLead({
        companyOwnerUserId: null,
        companyOwnerUserName: null,
        primaryContactId: "contact-1",
        primaryContactName: "Morgan Carter",
        primaryContactOwnerUserId: null,
        primaryContactOwnerUserName: null,
      }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderLeadDetail();

    expect(html.match(/Unassigned/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(html).toContain(">UA<");
  });

  it("tab change updates active tab", () => {
    mounted = mountLeadDetail();

    const recordingsTab = mounted.container.querySelector('button[aria-label="Recordings"]');
    expect(recordingsTab).not.toBeNull();

    act(() => {
      recordingsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain("Recording List");
    expect(mounted.container.textContent).not.toContain("Lead Timeline");
  });

  it("renders the activity tab scoped to the current lead", () => {
    mounted = mountLeadDetail();

    const activityTab = mounted.container.querySelector('button[aria-label="Activity"]');
    expect(activityTab).not.toBeNull();

    act(() => {
      activityTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain("Activity tab for lead:lead-1");
    expect(mounted.container.textContent).not.toContain("Activity tab for company:lead-1");
  });

  it("convert action opens conversion dialog", () => {
    mounted = mountLeadDetail();

    const convertButton = Array.from(mounted.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Convert to Opportunity")
    );
    expect(convertButton).not.toBeNull();

    act(() => {
      convertButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain("Lead Convert Dialog");
  });

  it("edit action switches to questionnaire editor", () => {
    mocks.useLeadDetailMock.mockReturnValue({
      lead: makeLead({ leadQuestionnaire: makeQuestionnaire() }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mounted = mountLeadDetail();

    expect(mounted.container.textContent).toContain("Lead Timeline");

    const editButton = Array.from(mounted.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Edit Sales Validation")
    );
    expect(editButton).not.toBeNull();

    act(() => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain("Lead Questionnaire Editor");
    expect(mounted.container.textContent).not.toContain("Lead Timeline");
  });

  it("confirms before leaving questionnaire edit mode through a tab change", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    mocks.useLeadDetailMock.mockReturnValue({
      lead: makeLead({ leadQuestionnaire: makeQuestionnaire() }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mounted = mountLeadDetail();

    const editButton = Array.from(mounted.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Edit Sales Validation")
    );
    act(() => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const recordingsTab = mounted.container.querySelector('button[aria-label="Recordings"]');
    act(() => {
      recordingsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(confirmSpy).toHaveBeenCalledWith(
      "Leave the questionnaire editor? Unsaved lead changes will be lost."
    );
    expect(mounted.container.textContent).toContain("Lead Questionnaire Editor");
    expect(mounted.container.textContent).not.toContain("Recording List");

    confirmSpy.mockRestore();
  });

  it("stage change action opens stage dialog", () => {
    mocks.useLeadDetailMock.mockReturnValue({
      lead: makeLead({ stageId: "stage-new-lead" }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mounted = mountLeadDetail();

    const stageButton = Array.from(mounted.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Move to Qualified Lead")
    );
    expect(stageButton).not.toBeNull();

    act(() => {
      stageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain("Lead Stage Dialog");
  });

  it("shows null-safe state when stageEnteredAt is missing", () => {
    mocks.useLeadDetailMock.mockReturnValue({
      lead: makeLead({ stageEnteredAt: null }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderLeadDetail();

    expect(html).toContain("Days in stage");
    expect(html).toContain("Unknown");
    expect(html).toContain("No data");
    expect(html).not.toContain("On track");
  });

  it("keeps opportunity scoping editable in CRM before the estimating handoff", () => {
    mocks.useLeadDetailMock.mockReturnValue({
      lead: makeLead({
        stageId: "stage-opportunity",
        status: "converted",
        convertedAt: "2026-04-11T09:00:00.000Z",
        convertedDealId: "deal-1",
        convertedDealNumber: "TR-1001",
      }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderLeadDetail();

    expect(html).toContain("Opportunity is still CRM-owned before estimating handoff.");
    expect(html).toContain("Open Opportunity Scope");
    expect(html).toContain("Opportunity Scope");
  });

  it("keeps the legacy read-only summary path when the questionnaire payload is absent", () => {
    const html = renderLeadDetail();

    expect(html).toContain("Lead Form");
    expect(html).toContain("Edit Sales Validation");
    expect(html).not.toContain("Lead Questionnaire Editor");
  });

  it("shows mirrored downstream deal states as read-only after handoff", () => {
    mocks.useLeadDetailMock.mockReturnValue({
      lead: makeLead({
        stageId: "stage-estimating",
        status: "converted",
        convertedAt: "2026-04-11T09:00:00.000Z",
        convertedDealId: "deal-1",
        convertedDealNumber: "TR-1001",
      }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderLeadDetail();

    expect(html).toContain("Bid Board Mirror");
    expect(html).toContain("Downstream deal state is mirrored from Bid Board and read-only in CRM after estimating starts.");
    expect(html).toContain("Open Read-Only Deal");
  });

  it("treats hidden leads as read-only and suppresses the editable surface CTA", () => {
    mocks.useLeadDetailMock.mockReturnValue({
      lead: makeLead({
        isActive: false,
        status: "open",
      }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderLeadDetail();

    expect(html).toContain("Hidden lead records are read-only.");
    expect(html).not.toContain("Edit Lead");
  });
});
