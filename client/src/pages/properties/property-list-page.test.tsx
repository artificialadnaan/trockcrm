import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { PropertyListPage } from "./property-list-page";

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
    <MemoryRouter>
      <PropertyListPage />
    </MemoryRouter>
  );
}

describe("PropertyListPage", () => {
  beforeEach(() => {
    mocks.useDealsMock.mockReturnValue({ deals, loading: false, error: null });
    mocks.useCompaniesMock.mockReturnValue({ companies, loading: false, error: null });
    mocks.usePipelineStagesMock.mockReturnValue({ stages: [{ id: "stage-lead", slug: "dd" }] });
    mocks.useDealsMock.mockClear();
    mocks.useCompaniesMock.mockClear();
    mocks.usePipelineStagesMock.mockClear();
  });

  it("includes inactive historical deals and keeps same-address properties split by company", () => {
    const html = normalize(renderPage());

    expect(mocks.useDealsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 2000,
        page: 1,
        sortBy: "updated_at",
        sortDir: "desc",
      })
    );
    expect(mocks.useDealsMock.mock.calls[0][0]).not.toHaveProperty("isActive", true);
    expect(html).toContain("2 properties across 3 deals");
    expect(html).toContain("Alpha Roofing");
    expect(html).toContain("Beta Roofing");
    expect(html).toContain("123 Main St");
    expect(html).toContain("2 deals");
    expect(html).toContain("1 deals");
  });
});
