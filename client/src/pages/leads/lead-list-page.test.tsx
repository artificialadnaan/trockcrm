import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LeadListPage } from "./lead-list-page";

const leads = [
  {
    id: "lead-1",
    companyId: "company-1",
    propertyId: "property-1",
    primaryContactId: null,
    name: "Contacted Lead",
    stageId: "stage-contacted",
    status: "open",
    source: "trade-show",
    description: null,
    lastActivityAt: null,
    stageEnteredAt: "2026-04-20T10:00:00.000Z",
    convertedAt: null,
    isActive: true,
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    assignedRepId: "rep-1",
    companyName: "Alpha",
    property: null,
    convertedDealId: null,
    convertedDealNumber: null,
  },
  {
    id: "lead-2",
    companyId: "company-2",
    propertyId: "property-2",
    primaryContactId: null,
    name: "Qualified Lead",
    stageId: "stage-qualified",
    status: "open",
    source: "referral",
    description: null,
    lastActivityAt: null,
    stageEnteredAt: "2026-04-20T10:00:00.000Z",
    convertedAt: null,
    isActive: true,
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    assignedRepId: "rep-1",
    companyName: "Beta",
    property: null,
    convertedDealId: null,
    convertedDealNumber: null,
  },
];

vi.mock("@/hooks/use-leads", () => ({
  useLeads: () => ({
    leads,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
  formatLeadPropertyLine: () => "",
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: () => ({
    stages: [
      { id: "stage-contacted", name: "Lead", slug: "contacted" },
      { id: "stage-qualified", name: "Qualified Lead", slug: "qualified_lead" },
      { id: "stage-director", name: "Director Review", slug: "director_go_no_go" },
      { id: "stage-ready", name: "Ready", slug: "ready_for_opportunity" },
    ],
    loading: false,
  }),
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

describe("LeadListPage", () => {
  it("filters lead buckets from the bucket query param", () => {
    const html = normalize(
      renderToStaticMarkup(
        <MemoryRouter initialEntries={["/leads?bucket=qualified_lead"]}>
          <LeadListPage />
        </MemoryRouter>
      )
    );

    expect(html).toContain("Qualified Lead");
    expect(html).not.toContain("Contacted Lead");
  });
});
