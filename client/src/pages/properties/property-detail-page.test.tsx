import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PropertyDetailPage } from "./property-detail-page";

const mocks = vi.hoisted(() => ({
  usePropertyDetailMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
}));

vi.mock("@/hooks/use-properties", () => ({
  usePropertyDetail: mocks.usePropertyDetailMock,
  formatPropertyLabel: vi.fn((property: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null; name?: string }) =>
    [property.address, [property.city, property.state].filter(Boolean).join(", "), property.zip].filter(Boolean).join(" ") || property.name || "Unassigned Property"
  ),
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: mocks.usePipelineStagesMock,
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/properties/property-1"]}>
      <Routes>
        <Route path="/properties/:id" element={<PropertyDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("PropertyDetailPage", () => {
  beforeEach(() => {
    mocks.usePipelineStagesMock.mockReset();
    mocks.usePropertyDetailMock.mockReset();
    mocks.usePipelineStagesMock.mockReturnValue({ stages: [{ id: "stage-lead", slug: "dd" }] });
    mocks.usePropertyDetailMock.mockReturnValue({
      property: {
        id: "property-1",
        companyId: "company-1",
        companyName: "Alpha Roofing",
        name: "Dallas HQ",
        address: "123 Main St",
        city: "Dallas",
        state: "TX",
        zip: "75201",
        notes: null,
        isActive: true,
        createdAt: "2026-04-10T10:00:00.000Z",
        updatedAt: "2026-04-11T10:00:00.000Z",
        leadCount: 2,
        dealCount: 3,
        convertedDealCount: 2,
        lastActivityAt: "2026-04-11T09:00:00.000Z",
      },
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Alpha Roofing Lead",
          stageId: "stage-lead",
          assignedRepId: "rep-1",
          status: "open",
          source: null,
          description: null,
          lastActivityAt: "2026-04-11T09:00:00.000Z",
          stageEnteredAt: "2026-04-10T10:00:00.000Z",
          convertedAt: null,
          isActive: true,
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
        {
          id: "lead-2",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Alpha Roofing Historical Lead",
          stageId: "stage-estimating",
          assignedRepId: "rep-1",
          status: "converted",
          source: null,
          description: null,
          lastActivityAt: "2026-04-09T09:00:00.000Z",
          stageEnteredAt: "2026-04-09T09:00:00.000Z",
          convertedAt: "2026-04-10T09:00:00.000Z",
          isActive: false,
          createdAt: "2026-04-09T09:00:00.000Z",
          updatedAt: "2026-04-10T09:00:00.000Z",
        },
      ],
      deals: [
        {
          id: "deal-1",
          dealNumber: "TR-0001",
          name: "Alpha Roofing History",
          stageId: "stage-estimating",
          workflowRoute: "estimating",
          assignedRepId: "rep-1",
          companyId: "company-1",
          propertyId: "property-1",
          sourceLeadId: "lead-2",
          primaryContactId: null,
          ddEstimate: null,
          bidEstimate: null,
          awardedAmount: null,
          changeOrderTotal: null,
          description: null,
          propertyAddress: "123 Main St",
          propertyCity: "Dallas",
          propertyState: "TX",
          propertyZip: "75201",
          projectTypeId: null,
          regionId: null,
          source: null,
          winProbability: null,
          procoreProjectId: null,
          procoreBidId: null,
          procoreLastSyncedAt: null,
          lostReasonId: null,
          lostNotes: null,
          lostCompetitor: null,
          lostAt: null,
          expectedCloseDate: null,
          actualCloseDate: null,
          lastActivityAt: "2026-04-10T10:00:00.000Z",
          stageEnteredAt: "2026-04-10T10:00:00.000Z",
          isActive: false,
          hubspotDealId: null,
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
      ],
      loading: false,
      error: null,
    });
  });

  it("renders first-class property history and converted counts", () => {
    const html = normalize(renderPage());

    expect(mocks.usePropertyDetailMock).toHaveBeenCalledWith("property-1");
    expect(html).toContain("Alpha Roofing");
    expect(html).toContain("123 Main St");
    expect(html).toContain("Converted");
    expect(html).toContain("2");
    expect(html).toContain("All historical opportunities tied to this property.");
    expect(html).toContain("Alpha Roofing Lead");
    expect(html).toContain("Alpha Roofing History");
  });
});
