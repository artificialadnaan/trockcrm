import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { LeadListPage } from "./lead-list-page";

const mocks = vi.hoisted(() => ({
  useLeadsMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
}));

vi.mock("@/hooks/use-leads", () => ({
  useLeads: mocks.useLeadsMock,
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
  getLeadBoardStageLabel: vi.fn((slug: string) =>
    ({
      new_lead: "New Lead",
      qualified_lead: "Qualified Lead",
      sales_validation_stage: "Sales Validation Stage",
    })[slug] ?? slug
  ),
  LEAD_BOARD_STAGE_SLUGS: ["new_lead", "qualified_lead", "sales_validation_stage"],
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

vi.mock("@/components/leads/lead-stage-badge", () => ({
  LeadStageBadge: ({ stageId }: { stageId: string }) => <span>{stageId}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: () => <input />,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function makeLead(stageId: string, name: string) {
  return {
    id: `${stageId}-${name}`,
    companyId: "company-1",
    propertyId: "property-1",
    primaryContactId: null,
    name,
    stageId,
    assignedRepId: "rep-1",
    status: "open",
    source: "referral",
    description: null,
    projectTypeId: null,
    projectType: null,
    qualificationPayload: {},
    projectTypeQuestionPayload: { projectTypeId: null, answers: {} },
    lastActivityAt: null,
    stageEnteredAt: "2026-04-20T10:00:00.000Z",
    convertedAt: null,
    isActive: true,
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
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
  };
}

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function renderPage() {
  return normalize(
    renderToStaticMarkup(
      <MemoryRouter>
        <LeadListPage />
      </MemoryRouter>
    )
  );
}

describe("LeadListPage", () => {
  beforeEach(() => {
    mocks.usePipelineStagesMock.mockReset();
    mocks.useLeadsMock.mockReset();

    mocks.usePipelineStagesMock.mockReturnValue({
      stages: [
        { id: "stage-new", name: "New Lead", slug: "new_lead" },
        { id: "stage-qualified", name: "Qualified Lead", slug: "qualified_lead" },
        { id: "stage-sales-validation", name: "Sales Validation Stage", slug: "sales_validation_stage" },
        { id: "stage-opportunity", name: "Opportunity", slug: "opportunity" },
      ],
    });

    mocks.useLeadsMock.mockReturnValue({
      leads: [
        makeLead("stage-new", "Inbound Church Lead"),
        makeLead("stage-qualified", "Apartment Walkthrough"),
        makeLead("stage-sales-validation", "Municipal Gym"),
        makeLead("stage-opportunity", "Should Stay Off Board"),
      ],
      loading: false,
      error: null,
    });
  });

  it("renders the CRM-owned lead board columns and excludes opportunity work", () => {
    const html = renderPage();

    expect(html).toContain("New Lead");
    expect(html).toContain("Qualified Lead");
    expect(html).toContain("Sales Validation Stage");
    expect(html).toContain("Inbound Church Lead");
    expect(html).toContain("Apartment Walkthrough");
    expect(html).toContain("Municipal Gym");
    expect(html).not.toContain("Should Stay Off Board");
  });
});
