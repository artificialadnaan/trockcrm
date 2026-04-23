import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { LeadDetailPage } from "./lead-detail-page";

const stages = [
  { id: "stage-new", name: "New Lead", slug: "new_lead", workflowFamily: "lead", displayOrder: 0 },
  { id: "stage-validation", name: "Sales Validation Stage", slug: "sales_validation_stage", workflowFamily: "lead", displayOrder: 1 },
  { id: "stage-opportunity", name: "Opportunity", slug: "opportunity", workflowFamily: "lead", displayOrder: 2 },
  { id: "stage-estimating", name: "Estimating", slug: "estimating", workflowFamily: "standard_deal", displayOrder: 3 },
];

let lead: Record<string, any> = {
  id: "lead-1",
  name: "Alpha Roofing Follow-Up",
  stageId: "stage-new",
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
  qualificationPayload: {},
  projectTypeQuestionPayload: { projectTypeId: null, answers: {} },
  projectTypeId: null,
  projectType: null,
  status: "open",
};
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
  getLeadStageMetadata: vi.fn((stageId: string, currentStages: typeof stages) => {
    const stage = currentStages.find((entry) => entry.id === stageId) ?? null;
    return { stage, slug: stage?.slug ?? null };
  }),
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

vi.mock("@/lib/record-detail-summary", () => ({
  buildLeadDetailSummary: () => ({
    ageDays: 5,
    freshnessDays: 1,
    isConverted: Boolean(lead.convertedAt || lead.convertedDealId || lead.status === "converted"),
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/leads/lead-form", () => ({
  LeadForm: () => <div>Lead Form</div>,
}));

vi.mock("@/components/leads/lead-stage-badge", () => ({
  LeadStageBadge: ({ stageId }: { stageId: string }) => <span>{stageId}</span>,
}));

vi.mock("@/components/leads/lead-timeline-tab", () => ({
  LeadTimelineTab: () => <div>Lead Timeline</div>,
}));

vi.mock("@/components/assignment/record-assignment-card", () => ({
  RecordAssignmentCard: ({ label }: { label: string }) => <div>{label}</div>,
}));
vi.mock("@/components/shared/forecast-editor", () => ({
  ForecastEditor: () => <div>Forecast Editor</div>,
}));
vi.mock("@/components/shared/next-step-editor", () => ({
  NextStepEditor: () => <div>Next Step Editor</div>,
}));
vi.mock("@/components/leads/lead-qualification-panel", () => ({
  LeadQualificationPanel: () => <div>Qualification Panel</div>,
}));
vi.mock("@/components/leads/lead-scoping-workspace", () => ({
  LeadScopingWorkspace: () => <div>Scoping Workspace</div>,
}));
vi.mock("@/components/leads/lead-stage-change-dialog", () => ({
  LeadStageChangeDialog: () => null,
}));
vi.mock("@/components/leads/lead-convert-dialog", () => ({
  LeadConvertDialog: () => null,
}));

function renderLeadDetail(initialEntry = "/leads/lead-1") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/leads/:id" element={<LeadDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LeadDetailPage", () => {
  beforeEach(() => {
    currentUserRole = "director";
    lead = {
      ...lead,
      stageId: "stage-new",
      convertedAt: null,
      convertedDealId: null,
      convertedDealNumber: null,
      status: "open",
    };
  });

  it("renders the lead detail surface with assignment and context", () => {
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
    expect(html).toContain("New Lead");
  });

  it("shows converted opportunity leads with CRM stage context and linked deal access", () => {
    lead = {
      ...lead,
      stageId: "stage-opportunity",
      status: "converted",
      convertedAt: "2026-04-11T09:00:00.000Z",
      convertedDealId: "deal-1",
      convertedDealNumber: "TR-1001",
    };

    const html = renderLeadDetail();

    expect(html).toContain("Pipeline context");
    expect(html).toContain("Opportunity");
    expect(html).toContain("Conversion status");
    expect(html).toContain("Converted");
    expect(html).toContain("Lead context");
    expect(html).toContain("This lead has already been converted, but the pre-RFP history remains available here.");
    expect(html).toContain("Open Deal");
  });

  it("shows converted downstream stages with the merged lead history shell intact", () => {
    lead = {
      ...lead,
      stageId: "stage-estimating",
      status: "converted",
      convertedAt: "2026-04-11T09:00:00.000Z",
      convertedDealId: "deal-1",
      convertedDealNumber: "TR-1001",
    };

    const html = renderLeadDetail();

    expect(html).toContain("Pipeline context");
    expect(html).toContain("Estimating");
    expect(html).toContain("Conversion status");
    expect(html).toContain("Converted");
    expect(html).toContain("Lead context");
    expect(html).toContain("This lead has already been converted, but the pre-RFP history remains available here.");
    expect(html).toContain("Open Deal");
  });
});
