import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { LeadDetailPage } from "./lead-detail-page";

const stages = [
  { id: "stage-lead", name: "Lead", slug: "dd" },
  { id: "stage-estimating", name: "Estimating", slug: "estimating" },
];

let deal: {
  id: string;
  dealNumber: string;
  name: string;
  stageId: string;
  companyId: string;
  primaryContactId: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  source: string | null;
  description: string | null;
  stageEnteredAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
} = {
  id: "deal-1",
  dealNumber: "T-1001",
  name: "Alpha Roofing Follow-Up",
  stageId: "stage-lead",
  companyId: "company-1",
  primaryContactId: "contact-1",
  propertyAddress: "123 Main St",
  propertyCity: "Dallas",
  propertyState: "TX",
  propertyZip: "75201",
  source: "trade show",
  description: "Initial pre-RFP lead.",
  stageEnteredAt: "2026-04-10T10:00:00.000Z",
  updatedAt: "2026-04-11T10:00:00.000Z",
  lastActivityAt: "2026-04-11T10:00:00.000Z",
};

let company = {
  id: "company-1",
  name: "Alpha Roofing",
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

vi.mock("@/hooks/use-deals", () => ({
  useDealDetail: vi.fn(() => ({
    deal,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
}));

vi.mock("@/hooks/use-companies", () => ({
  useCompanyDetail: vi.fn(() => ({
    company,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
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
    <MemoryRouter initialEntries={["/leads/deal-1"]}>
      <Routes>
        <Route path="/leads/:id" element={<LeadDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("LeadDetailPage", () => {
  it("renders the lead detail surface with the lead CTA", () => {
    deal = { ...deal, stageId: "stage-lead" };
    activities = [];

    const html = renderLeadDetail();

    expect(html).toContain("Alpha Roofing Follow-Up");
    expect(html).toContain("Alpha Roofing");
    expect(html).toContain("123 Main St");
    expect(html).toContain("Convert to Deal");
    expect(html).toContain("Lead");
  });

  it("switches the CTA to open the deal once the lead is converted", () => {
    deal = { ...deal, stageId: "stage-estimating" };
    activities = [];

    const html = renderLeadDetail();

    expect(html).toContain("Open Deal");
    expect(html).not.toContain("Convert to Deal");
  });

  it("splits lead and post-conversion activity into separate timeline sections", () => {
    deal = { ...deal, stageId: "stage-estimating" };
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
