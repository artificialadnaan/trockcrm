import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { LeadDetailPage } from "./lead-detail-page";

const stages = [
  { id: "stage-lead", name: "New", slug: "lead_new", workflowFamily: "lead", displayOrder: 0 },
  {
    id: "stage-qualified",
    name: "Qualified for Opportunity",
    slug: "qualified_for_opportunity",
    workflowFamily: "lead",
    displayOrder: 1,
  },
  { id: "stage-converted", name: "Converted", slug: "converted", workflowFamily: "lead", displayOrder: 2 },
  {
    id: "stage-estimating",
    name: "Estimating",
    slug: "estimating",
    workflowFamily: "standard_deal",
    displayOrder: 3,
  },
];

let lead: {
  id: string;
  name: string;
  stageId: string;
  companyId: string;
  propertyId: string;
  primaryContactId: string | null;
  assignedRepId: string;
  companyName: string | null;
  property: {
    id: string;
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  } | null;
  source: string | null;
  description: string | null;
  stageEnteredAt: string;
  convertedAt: string | null;
  convertedDealId: string | null;
  convertedDealNumber: string | null;
  updatedAt: string;
  lastActivityAt: string | null;
  forecastWindow: null;
  forecastCategory: null;
  forecastConfidencePercent: null;
  forecastRevenue: null;
  forecastGrossProfit: null;
  forecastBlockers: null;
  nextMilestoneAt: null;
  nextStep: null;
  nextStepDueAt: null;
  supportNeededType: null;
  supportNeededNotes: null;
  decisionMakerName: null;
  budgetStatus: null;
  status: "open" | "converted";
} = {
  id: "lead-1",
  name: "Alpha Roofing Follow-Up",
  stageId: "stage-lead",
  companyId: "company-1",
  propertyId: "property-1",
  primaryContactId: "contact-1",
  assignedRepId: "rep-1",
  companyName: "Alpha Roofing",
  property: {
    id: "property-1",
    name: "Dallas HQ",
    address: "123 Main St",
    city: "Dallas",
    state: "TX",
    zip: "75201",
  },
  source: "trade show",
  description: "Initial pre-RFP lead.",
  stageEnteredAt: "2026-04-10T10:00:00.000Z",
  convertedAt: null,
  convertedDealId: null,
  convertedDealNumber: null,
  updatedAt: "2026-04-11T10:00:00.000Z",
  lastActivityAt: "2026-04-11T10:00:00.000Z",
  forecastWindow: null,
  forecastCategory: null,
  forecastConfidencePercent: null,
  forecastRevenue: null,
  forecastGrossProfit: null,
  forecastBlockers: null,
  nextMilestoneAt: null,
  nextStep: null,
  nextStepDueAt: null,
  supportNeededType: null,
  supportNeededNotes: null,
  decisionMakerName: null,
  budgetStatus: null,
  status: "open",
};

let activities: Array<{
  id: string;
  type: string;
  subject: string;
  body: string;
  occurredAt: string;
}> = [];
let currentUserRole: "director" | "admin" | "rep" = "director";

vi.mock("@/hooks/use-leads", () => ({
  useLeadDetail: vi.fn(() => ({
    lead,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
  useLeadQualification: vi.fn(() => ({
    qualification: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
  useLeadScoping: vi.fn(() => ({
    intake: null,
    readiness: {
      status: "draft",
      isReadyForGoNoGo: false,
      completionState: {},
      errors: { sections: {}, attachments: {} },
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
  formatLeadPropertyLine: vi.fn((currentLead: typeof lead) =>
    [
      currentLead.property?.address,
      [currentLead.property?.city, currentLead.property?.state].filter(Boolean).join(", "),
      currentLead.property?.zip,
    ]
      .filter(Boolean)
      .join(" ")
  ),
  updateLead: vi.fn(),
  preflightLeadStageCheck: vi.fn(),
  convertLeadToOpportunity: vi.fn(),
  updateLeadScoping: vi.fn(),
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: vi.fn(() => ({
    stages,
  })),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: vi.fn(() => ({
    user: {
      id: currentUserRole === "rep" ? "rep-1" : "director-1",
      displayName: currentUserRole === "rep" ? "Riley Rep" : "Dana Director",
      role: currentUserRole,
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

vi.mock("@/hooks/use-activities", () => ({
  useActivities: vi.fn(() => ({
    activities,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
}));

function renderLeadDetail() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/leads/lead-1"]}>
      <Routes>
        <Route path="/leads/:id" element={<LeadDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderLeadDetailWithQualificationFocus() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/leads/lead-1?focus=qualification"]}>
      <Routes>
        <Route path="/leads/:id" element={<LeadDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderLeadDetailWithScopingFocus() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/leads/lead-1?focus=scoping"]}>
      <Routes>
        <Route path="/leads/:id" element={<LeadDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LeadDetailPage", () => {
  it("renders the lead detail surface with assignment and context", () => {
    currentUserRole = "director";
    lead = {
      ...lead,
      stageId: "stage-lead",
      convertedAt: null,
      convertedDealId: null,
      convertedDealNumber: null,
      status: "open",
    };

    const html = renderLeadDetail();

    expect(html).toContain("Alpha Roofing Follow-Up");
    expect(html).toContain("Pipeline context");
    expect(html).toContain("Stage age");
    expect(html).toContain("Last update");
    expect(html).toContain("Conversion status");
    expect(html).toContain("Alpha Roofing");
    expect(html).toContain("123 Main St");
    expect(html).toContain("Assigned Rep");
    expect(html).toContain("Lead context");
    expect(html).toContain("New");
  });

  it("shows the opportunity conversion CTA once the lead reaches the qualified stage", () => {
    currentUserRole = "director";
    lead = {
      ...lead,
      stageId: "stage-qualified",
      convertedAt: null,
      convertedDealId: null,
      convertedDealNumber: null,
      status: "open",
    };

    const html = renderLeadDetail();

    expect(html).toContain("Convert to Opportunity");
  });

  it("shows a qualification-intake helper when opened from a blocked stage move", () => {
    currentUserRole = "director";
    lead = {
      ...lead,
      stageId: "stage-lead",
      convertedAt: null,
      convertedDealId: null,
      convertedDealNumber: null,
      status: "open",
    };

    const html = renderLeadDetailWithQualificationFocus();

    expect(html).toContain("Complete Qualification Intake");
    expect(html).toContain("Complete the qualification intake below to satisfy the current stage requirements.");
  });

  it("renders property city and state inputs in the qualification intake", () => {
    currentUserRole = "director";
    lead = {
      ...lead,
      stageId: "stage-lead",
      convertedAt: null,
      convertedDealId: null,
      convertedDealNumber: null,
      status: "open",
    };

    const html = renderLeadDetailWithQualificationFocus();

    expect(html).toContain("Property City");
    expect(html).toContain("Property State");
  });

  it("shows a lead-scoping helper when opened from a blocked scoping gate", () => {
    currentUserRole = "director";
    lead = {
      ...lead,
      stageId: "stage-lead",
      convertedAt: null,
      convertedDealId: null,
      convertedDealNumber: null,
      status: "open",
    };

    const html = renderLeadDetailWithScopingFocus();

    expect(html).toContain("Complete Lead Scoping Checklist");
    expect(html).toContain("Complete the lead scoping checklist below before moving this lead into Lead Go/No-Go.");
  });

  it("shows the recommendation and approval handoff sections to reps on active leads", () => {
    currentUserRole = "rep";
    lead = {
      ...lead,
      stageId: "stage-lead",
      convertedAt: null,
      convertedDealId: null,
      convertedDealNumber: null,
      status: "open",
    };

    const html = renderLeadDetail();

    expect(html).toContain("Rep Recommendation");
    expect(html).toContain("Rep Recommendation Notes");
    expect(html).toContain("Approval Status");
    expect(html).toContain("Director/Admin Decision");
  });

  it("switches the CTA to open the deal once the lead is converted", () => {
    currentUserRole = "director";
    lead = {
      ...lead,
      stageId: "stage-estimating",
      convertedAt: "2026-04-11T09:00:00.000Z",
      convertedDealId: "deal-1",
      convertedDealNumber: "TR-1001",
      status: "converted",
    };

    const html = renderLeadDetail();

    expect(html).toContain("Open Deal");
    expect(html).toContain("This lead has already been converted");
  });
});
