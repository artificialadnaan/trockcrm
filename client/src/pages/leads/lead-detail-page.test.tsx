import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { LeadDetailPage } from "./lead-detail-page";

const stages = [
  { id: "stage-lead", name: "Lead", slug: "dd" },
  { id: "stage-estimating", name: "Estimating", slug: "estimating" },
];

let lead: {
  id: string;
  name: string;
  stageId: string;
  companyId: string;
  propertyId: string;
  primaryContactId: string | null;
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
} = {
  id: "lead-1",
  name: "Alpha Roofing Follow-Up",
  stageId: "stage-lead",
  companyId: "company-1",
  propertyId: "property-1",
  primaryContactId: "contact-1",
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
};

let activities: Array<{
  id: string;
  type: string;
  subject: string;
  body: string;
  occurredAt: string;
}> = [
  {
    id: "activity-1",
    type: "call",
    subject: "Intro call",
    body: "Discussed scope",
    occurredAt: "2026-04-09T09:00:00.000Z",
  },
  {
    id: "activity-2",
    type: "email",
    subject: "Converted follow-up",
    body: "Sent estimate",
    occurredAt: "2026-04-11T09:00:00.000Z",
  },
];

vi.mock("@/hooks/use-leads", () => ({
  useLeadDetail: vi.fn(() => ({
    lead,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
  formatLeadPropertyLine: vi.fn((currentLead: typeof lead) =>
    [currentLead.property?.address, [currentLead.property?.city, currentLead.property?.state].filter(Boolean).join(", "), currentLead.property?.zip]
      .filter(Boolean)
      .join(" ")
  ),
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: vi.fn(() => ({
    stages,
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

describe("LeadDetailPage", () => {
  it("renders the lead detail surface with the lead CTA", () => {
    lead = { ...lead, stageId: "stage-lead", convertedAt: null, convertedDealId: null, convertedDealNumber: null };
    activities = [];

    const html = renderLeadDetail();

    expect(html).toContain("Alpha Roofing Follow-Up");
    expect(html).toContain("Alpha Roofing");
    expect(html).toContain("123 Main St");
    expect(html).toContain("Convert to Deal");
    expect(html).toContain("Lead");
  });

  it("switches the CTA to open the deal once the lead is converted", () => {
    lead = { ...lead, stageId: "stage-estimating", convertedAt: "2026-04-11T09:00:00.000Z", convertedDealId: "deal-1", convertedDealNumber: "TR-1001" };
    activities = [];

    const html = renderLeadDetail();

    expect(html).toContain("Open Deal");
    expect(html).not.toContain("Convert to Deal");
  });

  it("splits lead and post-conversion activity into separate timeline sections", () => {
    lead = { ...lead, stageId: "stage-estimating", convertedAt: "2026-04-11T09:00:00.000Z", convertedDealId: "deal-1", convertedDealNumber: "TR-1001" };
    activities = [
      {
        id: "activity-1",
        type: "call",
        subject: "Intro call",
        body: "Discussed scope",
        occurredAt: "2026-04-09T09:00:00.000Z",
      },
      {
        id: "activity-2",
        type: "email",
        subject: "Converted follow-up",
        body: "Sent estimate",
        occurredAt: "2026-04-11T09:00:00.000Z",
      },
    ];

    const html = renderLeadDetail();

    expect(html).toContain("Lead Activity");
    expect(html).toContain("Post-Conversion Activity");
    expect(html).toContain("Intro call");
    expect(html).toContain("Converted follow-up");
  });
});
