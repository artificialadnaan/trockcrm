// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PropertyDetailPage } from "./property-detail-page";

const mocks = vi.hoisted(() => ({
  usePropertyDetailMock: vi.fn(),
}));

vi.mock("@/hooks/use-properties", () => ({
  usePropertyDetail: mocks.usePropertyDetailMock,
  formatPropertyLabel: vi.fn((property: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null; name?: string }) =>
    [property.address, [property.city, property.state].filter(Boolean).join(", "), property.zip].filter(Boolean).join(" ") || property.name || "Unassigned Property"
  ),
}));

vi.mock("@/components/deals/deal-stage-badge", () => ({
  DealStageBadge: ({ stageId }: { stageId: string }) => <span>{stageId}</span>,
}));

vi.mock("@/components/leads/lead-stage-badge", () => ({
  LeadStageBadge: ({ stageId, converted }: { stageId: string; converted?: boolean }) => (
    <span>{converted ? "converted" : stageId}</span>
  ),
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

function mountPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={["/properties/property-1"]}>
        <Routes>
          <Route path="/properties/:id" element={<PropertyDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
  });

  return {
    container,
    unmount() {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

function makeProperty(overrides: Record<string, unknown> = {}) {
  return {
    id: "property-1",
    companyId: "company-1",
    companyName: "Dallas Independent SD",
    name: "Building A - Main Campus",
    address: "9400 N Central Expy",
    city: "Dallas",
    state: "TX",
    zip: "75231",
    type: null,
    propertyType: "school",
    buildYear: 1968,
    unitCount: 3,
    floors: 3,
    roofArea: 138000,
    notes: "Three-story administration building with phasing required.",
    procorePropertyId: "pc_property_dallas_1",
    companycamProjectId: "ccam_8821",
    hubspotPropertyId: "hs_property_9400",
    photosCount: 47,
    activePipelineValue: "875000",
    isActive: true,
    createdAt: "2026-04-10T10:00:00.000Z",
    updatedAt: "2026-04-11T10:00:00.000Z",
    leadCount: 2,
    dealCount: 3,
    convertedDealCount: 1,
    lastActivityAt: "2026-04-11T09:00:00.000Z",
    lat: 32.8801,
    lng: -96.7689,
    ...overrides,
  };
}

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    id: "lead-1",
    companyId: "company-1",
    propertyId: "property-1",
    primaryContactId: null,
    name: "Building A Lead",
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
    ...overrides,
  };
}

function makeDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    dealNumber: "TR-0001",
    name: "Dallas ISD Roof Replacement",
    stageId: "stage-estimating",
    workflowRoute: "normal",
    assignedRepId: "rep-1",
    companyId: "company-1",
    propertyId: "property-1",
    sourceLeadId: "lead-1",
    primaryContactId: null,
    ddEstimate: null,
    bidEstimate: "875000",
    awardedAmount: null,
    changeOrderTotal: null,
    description: null,
    propertyAddress: "9400 N Central Expy",
    propertyCity: "Dallas",
    propertyState: "TX",
    propertyZip: "75231",
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
    isActive: true,
    hubspotDealId: null,
    createdAt: "2026-04-10T10:00:00.000Z",
    updatedAt: "2026-04-11T10:00:00.000Z",
    ...overrides,
  };
}

describe("PropertyDetailPage", () => {
  let mounted: ReturnType<typeof mountPage> | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
    mocks.usePropertyDetailMock.mockReset();
    mocks.usePropertyDetailMock.mockReturnValue({
      property: makeProperty(),
      leads: [makeLead()],
      deals: [makeDeal()],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("renders property hero with name and type badge", () => {
    const html = normalize(renderPage());

    expect(mocks.usePropertyDetailMock).toHaveBeenCalledWith("property-1");
    expect(html).toContain("Building A - Main Campus");
    expect(html).toContain("SCHOOL");
    expect(html).toContain("ACTIVE DEAL");
    expect(html).toContain("Dallas Independent SD");
  });

  it("renders all expected tabs", () => {
    const html = normalize(renderPage());

    expect(html).toContain("Overview");
    expect(html).toContain("Photos");
    expect(html).toContain("Contacts");
    expect(html).toContain("Deals");
    expect(html).toContain("Leads");
    expect(html).toContain("Activity");
    expect(html).toContain("Files");
  });

  it("renders right-rail with owner company, address, type, and system IDs", () => {
    const html = normalize(renderPage());

    expect(html).toContain("Owner Company");
    expect(html).toContain("Dallas Independent SD");
    expect(html).toContain("9400 N Central Expy");
    expect(html).toContain("Dallas, TX 75231");
    expect(html).toContain("Type");
    expect(html).toContain("School");
    expect(html).toContain("System IDs");
    expect(html).toContain("hs_property_9400");
    expect(html).toContain("pc_property_dallas_1");
    expect(html).toContain("ccam_8821");
    expect(html).toContain("32.88010, -96.76890");
  });

  it("renders coordinates when lat/lng arrive as strings from API", () => {
    mocks.usePropertyDetailMock.mockReturnValueOnce({
      property: makeProperty({ lat: "32.7767", lng: "-96.7970" }),
      leads: [],
      deals: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = normalize(renderPage());

    expect(html).toContain("Coordinates");
    expect(html).toContain("32.77670, -96.79700");
  });

  it("omits coordinates when lat/lng are non-finite", () => {
    mocks.usePropertyDetailMock.mockReturnValueOnce({
      property: makeProperty({ lat: "not-a-number", lng: "-96.7970" }),
      leads: [],
      deals: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = normalize(renderPage());

    expect(html).not.toContain("Coordinates");
    expect(html).not.toContain("not-a-number");
  });

  it("keeps company navigation when company name is missing", () => {
    mocks.usePropertyDetailMock.mockReturnValueOnce({
      property: makeProperty({ companyName: null }),
      leads: [],
      deals: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = normalize(renderPage());

    expect(html).toContain('href="/companies/company-1"');
    expect(html).toContain("View company");
    expect(html).not.toContain("No owner company");
  });

  it("shows Not categorized when propertyType is null", () => {
    mocks.usePropertyDetailMock.mockReturnValueOnce({
      property: makeProperty({ propertyType: null }),
      leads: [],
      deals: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = normalize(renderPage());

    expect(html).toContain("UNCATEGORIZED");
    expect(html).toContain("Not categorized");
  });

  it("tab change updates active tab", () => {
    mounted = mountPage();

    const photosTab = mounted.container.querySelector('button[aria-label="Photos"]');
    expect(photosTab).not.toBeNull();

    act(() => {
      photosTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain("Photo gallery coming soon");
    expect(mounted.container.textContent).not.toContain("Building specs");
  });

  it("deals tab shows related deals", () => {
    mounted = mountPage();

    const dealsTab = mounted.container.querySelector('button[aria-label="Deals"]');
    act(() => {
      dealsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain("Dallas ISD Roof Replacement");
    expect(mounted.container.textContent).toContain("TR-0001");
  });

  it("Deals tab badge matches rendered deals count", () => {
    mocks.usePropertyDetailMock.mockReturnValue({
      property: makeProperty({ dealCount: 1 }),
      leads: [],
      deals: [
        makeDeal({ id: "active-deal", name: "Active Property Deal", isActive: true }),
        makeDeal({ id: "inactive-deal", name: "Inactive Property Deal", isActive: false }),
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    mounted = mountPage();

    const dealsTab = mounted.container.querySelector('button[aria-label="Deals"]');
    expect(dealsTab?.textContent).toContain("2");

    act(() => {
      dealsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain("Active Property Deal");
    expect(mounted.container.textContent).toContain("Inactive Property Deal");
  });

  it("leads tab shows related leads", () => {
    mounted = mountPage();

    const leadsTab = mounted.container.querySelector('button[aria-label="Leads"]');
    act(() => {
      leadsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain("Building A Lead");
    expect(mounted.container.textContent).toContain("Open lead");
  });

  it("edit button navigates to edit page with link semantics", () => {
    const html = normalize(renderPage());

    expect(html).toContain('href="/properties/property-1/edit"');
    expect(html).toContain("Edit");
  });

  it("new deal button passes property and company context", () => {
    const html = normalize(renderPage());

    expect(html).toContain('href="/deals/new?propertyId=property-1&amp;companyId=company-1"');
    expect(html).toContain("New deal");
  });
});
