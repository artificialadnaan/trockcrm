import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { LeadDetailPage } from "./lead-detail-page";

const mocks = vi.hoisted(() => ({
  useLeadDetailMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
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

vi.mock("@/lib/sales-workflow", () => ({
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
}));

vi.mock("@/components/leads/lead-timeline-tab", () => ({
  LeadTimelineTab: () => <div>Lead Timeline</div>,
}));

vi.mock("@/components/leads/lead-stage-badge", () => ({
  LeadStageBadge: ({ stageId }: { stageId: string }) => <span>{stageId}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
    ...overrides,
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

describe("LeadDetailPage", () => {
  beforeEach(() => {
    mocks.usePipelineStagesMock.mockReset();
    mocks.useLeadDetailMock.mockReset();

    mocks.usePipelineStagesMock.mockReturnValue({
      stages: [
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
});
