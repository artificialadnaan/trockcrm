import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PropertyDetailPage } from "./property-detail-page";
import { buildPropertyId } from "@/lib/property-key";

const mocks = vi.hoisted(() => ({
  useDealsMock: vi.fn(),
  useCompaniesMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
}));

const deals = [
  {
    id: "deal-1",
    dealNumber: "T-1001",
    name: "Alpha Roofing Lead",
    stageId: "stage-lead",
    isActive: true,
    companyId: "company-1",
    propertyAddress: "123 Main St",
    propertyCity: "Dallas",
    propertyState: "TX",
    propertyZip: "75201",
    lastActivityAt: "2026-04-11T09:00:00.000Z",
    stageEnteredAt: "2026-04-10T10:00:00.000Z",
    createdAt: "2026-04-10T10:00:00.000Z",
    updatedAt: "2026-04-11T10:00:00.000Z",
  },
  {
    id: "deal-2",
    dealNumber: "T-1002",
    name: "Alpha Roofing History",
    stageId: "stage-estimating",
    isActive: false,
    companyId: "company-1",
    propertyAddress: "123 Main St",
    propertyCity: "Dallas",
    propertyState: "TX",
    propertyZip: "75201",
    lastActivityAt: "2026-04-09T09:00:00.000Z",
    stageEnteredAt: "2026-04-09T09:00:00.000Z",
    createdAt: "2026-04-09T09:00:00.000Z",
    updatedAt: "2026-04-09T09:00:00.000Z",
  },
  {
    id: "deal-3",
    dealNumber: "T-2001",
    name: "Beta Roofing History",
    stageId: "stage-estimating",
    isActive: false,
    companyId: "company-2",
    propertyAddress: "123 Main St",
    propertyCity: "Dallas",
    propertyState: "TX",
    propertyZip: "75201",
    lastActivityAt: "2026-04-08T09:00:00.000Z",
    stageEnteredAt: "2026-04-08T09:00:00.000Z",
    createdAt: "2026-04-08T09:00:00.000Z",
    updatedAt: "2026-04-08T09:00:00.000Z",
  },
];

const companies = [
  { id: "company-1", name: "Alpha Roofing" },
  { id: "company-2", name: "Beta Roofing" },
];

const propertyId = buildPropertyId({
  companyId: "company-1",
  address: "123 Main St",
  city: "Dallas",
  state: "TX",
  zip: "75201",
});

vi.mock("@/hooks/use-deals", () => ({
  useDeals: mocks.useDealsMock,
}));

vi.mock("@/hooks/use-companies", () => ({
  useCompanies: mocks.useCompaniesMock,
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: mocks.usePipelineStagesMock,
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/properties/${propertyId}`]}>
      <Routes>
        <Route path="/properties/:id" element={<PropertyDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("PropertyDetailPage", () => {
  beforeEach(() => {
    mocks.useDealsMock.mockReturnValue({ deals, loading: false, error: null });
    mocks.useCompaniesMock.mockReturnValue({ companies, loading: false, error: null });
    mocks.usePipelineStagesMock.mockReturnValue({ stages: [{ id: "stage-lead", slug: "dd" }] });
    mocks.useDealsMock.mockClear();
    mocks.useCompaniesMock.mockClear();
    mocks.usePipelineStagesMock.mockClear();
  });

  it("uses full historical deals and a historical converted metric", () => {
    const html = normalize(renderPage());

    expect(mocks.useDealsMock.mock.calls.every(([args]) => args?.isActive !== true)).toBe(true);
    expect(html).toContain("Alpha Roofing");
    expect(html).toContain("123 Main St");
    expect(html).toContain("Historical Rollup");
    expect(html).toContain("Converted Deals");
    expect(html).toContain("Inactive");
    expect(html).toContain("All historical opportunities tied to this property.");
    expect(html).toContain("2 items");
  });
});
