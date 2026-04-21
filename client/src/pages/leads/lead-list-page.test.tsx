import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LeadListPage } from "./lead-list-page";

const stages = [
  { id: "stage-new", name: "New", slug: "lead_new", workflowFamily: "lead", displayOrder: 1, isActivePipeline: true, isTerminal: false },
  { id: "stage-prequal", name: "Company Pre-Qualified", slug: "company_pre_qualified", workflowFamily: "lead", displayOrder: 2, isActivePipeline: true, isTerminal: false },
  { id: "stage-go", name: "Lead Go/No-Go", slug: "lead_go_no_go", workflowFamily: "lead", displayOrder: 5, isActivePipeline: true, isTerminal: false },
  { id: "stage-qualified", name: "Qualified for Opportunity", slug: "qualified_for_opportunity", workflowFamily: "lead", displayOrder: 6, isActivePipeline: true, isTerminal: false },
];

const leads = [
  {
    id: "lead-1",
    companyId: "company-1",
    propertyId: "property-1",
    primaryContactId: null,
    name: "Alpha Roofing",
    stageId: "stage-new",
    assignedRepId: "rep-1",
    status: "open",
    source: "Referral",
    description: null,
    lastActivityAt: null,
    stageEnteredAt: "2026-04-20T10:00:00.000Z",
    convertedAt: null,
    isActive: true,
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    companyName: "Alpha Roofing",
    property: null,
    convertedDealId: null,
    convertedDealNumber: null,
  },
  {
    id: "lead-2",
    companyId: "company-2",
    propertyId: "property-2",
    primaryContactId: null,
    name: "Bravo Services",
    stageId: "stage-go",
    assignedRepId: "rep-1",
    status: "open",
    source: "Inbound",
    description: null,
    lastActivityAt: null,
    stageEnteredAt: "2026-04-20T10:00:00.000Z",
    convertedAt: null,
    isActive: true,
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    companyName: "Bravo Services",
    property: null,
    convertedDealId: null,
    convertedDealNumber: null,
  },
];

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

vi.mock("@/hooks/use-leads", () => ({
  useLeads: () => ({
    leads,
    loading: false,
    error: null,
  }),
  formatLeadPropertyLine: () => "",
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: () => ({
    stages,
    loading: false,
  }),
}));

describe("LeadListPage", () => {
  it("renders ordered lead kanban columns even when some columns are empty", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadListPage />
      </MemoryRouter>
    );

    expect(html).toContain("New");
    expect(html).toContain("Company Pre-Qualified");
    expect(html).toContain("Lead Go/No-Go");
    expect(html).toContain("Qualified for Opportunity");
    expect(html).toContain("Alpha Roofing");
    expect(html).toContain("Bravo Services");
  });
});
