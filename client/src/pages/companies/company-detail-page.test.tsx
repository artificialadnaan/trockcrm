// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { CompanyDetailPage } from "./company-detail-page";

const mocks = vi.hoisted(() => ({
  useCompanyDetailMock: vi.fn(),
  useCompanyContactsMock: vi.fn(),
  useCompanyDealsMock: vi.fn(),
  verifyCompanyMock: vi.fn(),
  useLeadsMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  usePropertiesMock: vi.fn(),
  apiMock: vi.fn(),
}));

vi.mock("@/hooks/use-companies", () => ({
  useCompanyDetail: mocks.useCompanyDetailMock,
  useCompanyContacts: mocks.useCompanyContactsMock,
  useCompanyDeals: mocks.useCompanyDealsMock,
  verifyCompany: mocks.verifyCompanyMock,
}));

vi.mock("@/hooks/use-leads", () => ({
  useLeads: mocks.useLeadsMock,
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: mocks.usePipelineStagesMock,
}));

vi.mock("@/hooks/use-properties", () => ({
  formatPropertyLabel: vi.fn((property: { name?: string; address?: string }) => property.name ?? property.address ?? "Property"),
  useProperties: mocks.usePropertiesMock,
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

vi.mock("@/components/ai/company-copilot-panel", () => ({
  CompanyCopilotPanel: () => <div>Company Copilot</div>,
}));

vi.mock("@/components/call-recordings/recording-list", () => ({
  RecordingList: () => <div>Recording List</div>,
}));

vi.mock("@/components/contacts/contact-form", () => ({
  ContactForm: () => <div>Contact Form</div>,
}));

vi.mock("@/components/deals/deal-stage-badge", () => ({
  DealStageBadge: ({ stageId }: { stageId: string }) => <span>{stageId}</span>,
}));

vi.mock("@/components/leads/lead-stage-badge", () => ({
  LeadStageBadge: ({ stageId }: { stageId: string }) => <span>{stageId}</span>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

function makeCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: "company-1",
    name: "Dallas Independent SD",
    category: "client",
    address: "9400 N Central Expy",
    city: "Dallas",
    state: "TX",
    zip: "75231",
    phone: "(214) 555-0100",
    website: "https://www.dallasisd.org",
    ownerUserId: "owner-1",
    ownerUserName: "Brett Rios",
    industry: "School District",
    region: "Dallas, TX",
    domain: "dallasisd.org",
    hubspotCompanyId: "hs_dallas_isd_2841",
    procoreId: "pc_dallas_isd_47",
    notes: "Public school district serving Dallas County.",
    companyVerificationStatus: "pending",
    companyVerificationRequestedAt: "2026-05-01T10:00:00.000Z",
    companyVerificationEmailSentAt: null,
    companyVerifiedAt: null,
    companyVerifiedBy: null,
    contactCount: 8,
    dealCount: 3,
    contactsCount: 8,
    propertiesCount: 14,
    activeDealsCount: 3,
    pipelineValue: "1240000",
    createdAt: "2026-04-10T10:00:00.000Z",
    updatedAt: "2026-04-11T10:00:00.000Z",
    ...overrides,
  };
}

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/companies/company-1"]}>
      <Routes>
        <Route path="/companies/:id" element={<CompanyDetailPage />} />
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
      <MemoryRouter initialEntries={["/companies/company-1"]}>
        <Routes>
          <Route path="/companies/:id" element={<CompanyDetailPage />} />
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("CompanyDetailPage", () => {
  let mounted: ReturnType<typeof mountPage> | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
    mocks.useCompanyDetailMock.mockReset();
    mocks.useCompanyContactsMock.mockReset();
    mocks.useCompanyDealsMock.mockReset();
    mocks.verifyCompanyMock.mockReset();
    mocks.useLeadsMock.mockReset();
    mocks.usePipelineStagesMock.mockReset();
    mocks.usePropertiesMock.mockReset();
    mocks.apiMock.mockReset();

    mocks.useCompanyDetailMock.mockReturnValue({
      company: makeCompany(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.useCompanyContactsMock.mockReturnValue({
      contacts: [
        { id: "contact-1", firstName: "Marcus", lastName: "Holloway", email: "mholloway@dallasisd.org", phone: null, jobTitle: "Director of Facilities", category: "client" },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.useCompanyDealsMock.mockReturnValue({
      deals: [
        { id: "deal-1", dealNumber: "TR-1", name: "Dallas ISD Roof Replacement", stageId: "stage-1", isActive: true, companyId: "company-1", propertyId: null, sourceLeadId: null, propertyAddress: null, propertyCity: null, propertyState: null, propertyZip: null, stageEnteredAt: "2026-05-01T10:00:00.000Z", lastActivityAt: null, createdAt: "2026-05-01T10:00:00.000Z", updatedAt: "2026-05-01T10:00:00.000Z" },
      ],
      loading: false,
      error: null,
    });
    mocks.useLeadsMock.mockReturnValue({ leads: [] });
    mocks.usePipelineStagesMock.mockReturnValue({ stages: [] });
    mocks.usePropertiesMock.mockReturnValue({
      properties: [
        { id: "property-1", name: "Building A", companyName: "Dallas Independent SD", dealCount: 1 },
      ],
    });
    mocks.apiMock.mockResolvedValue({ activities: [], files: [] });
    mocks.verifyCompanyMock.mockResolvedValue({ company: makeCompany({ companyVerificationStatus: "verified" }) });
  });

  it("renders company hero with name and industry", () => {
    const html = renderPage();

    expect(html).toContain("Dallas Independent SD");
    expect(html).toContain("School District");
    expect(html).toContain("dallasisd.org");
  });

  it("renders all expected tabs", () => {
    const html = renderPage();

    expect(html).toContain("Overview");
    expect(html).toContain("Contacts");
    expect(html).toContain("Portfolio");
    expect(html).toContain("Deals");
    expect(html).toContain("Files");
    expect(html).toContain("Emails");
    expect(html).toContain("Recordings");
  });

  it("renders right-rail with owner, industry, region, domain, system IDs", () => {
    const html = renderPage();

    expect(html).toContain("Owner");
    expect(html).toContain("Brett Rios");
    expect(html).toContain("Industry");
    expect(html).toContain("School District");
    expect(html).toContain("Region");
    expect(html).toContain("Dallas, TX");
    expect(html).toContain("Domain");
    expect(html).toContain("dallasisd.org");
    expect(html).toContain("System IDs");
    expect(html).toContain("hs_dallas_isd_2841");
    expect(html).toContain("pc_dallas_isd_47");
  });

  it("shows Unassigned when ownerUserName is null", () => {
    mocks.useCompanyDetailMock.mockReturnValueOnce({
      company: makeCompany({ ownerUserId: null, ownerUserName: null }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage();

    expect(html).toContain("Unassigned");
  });

  it("tab change updates active tab", () => {
    mounted = mountPage();

    const dealsTab = mounted.container.querySelector('button[aria-label="Deals"]');
    expect(dealsTab).not.toBeNull();

    act(() => {
      dealsTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mounted.container.textContent).toContain("Dallas ISD Roof Replacement");
    expect(mounted.container.textContent).not.toContain("Company Copilot");
  });

  it("verify action triggers verification handler", async () => {
    const refetch = vi.fn();
    mocks.useCompanyDetailMock.mockReturnValueOnce({
      company: makeCompany(),
      loading: false,
      error: null,
      refetch,
    });

    mounted = mountPage();
    const verifyButton = Array.from(mounted.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Verify")
    );
    expect(verifyButton).not.toBeNull();

    await act(async () => {
      verifyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.verifyCompanyMock).toHaveBeenCalledWith("company-1");
    expect(refetch).toHaveBeenCalled();
  });

  it("disables Verify Company while verification is in flight", async () => {
    const pending = deferred<{ company: ReturnType<typeof makeCompany> }>();
    mocks.verifyCompanyMock.mockReturnValueOnce(pending.promise);

    mounted = mountPage();
    const verifyButton = Array.from(mounted.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Verify Company")
    );
    expect(verifyButton).not.toBeNull();

    await act(async () => {
      verifyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const verifyingButton = Array.from(mounted.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Verifying...")
    );
    expect(verifyingButton).not.toBeNull();
    expect(verifyingButton).toHaveProperty("disabled", true);

    await act(async () => {
      verifyingButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.verifyCompanyMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ company: makeCompany({ companyVerificationStatus: "verified" }) });
      await pending.promise;
    });
  });

  it("omits HubSpot deep link when portal ID is unavailable", () => {
    const html = renderPage();

    expect(html).toContain("hs_dallas_isd_2841");
    expect(html).not.toContain("app.hubspot.com/contacts/0/company");
  });

  it("uses domain when website is an empty string", () => {
    mocks.useCompanyDetailMock.mockReturnValueOnce({
      company: makeCompany({ website: "", domain: "example.com" }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage();

    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("example.com");
  });

  it("shows verified status from companyVerificationStatus without requiring timestamp", () => {
    mocks.useCompanyDetailMock.mockReturnValueOnce({
      company: makeCompany({
        companyVerificationStatus: "verified",
        companyVerifiedAt: null,
      }),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const html = renderPage();

    expect(html).toContain("Verified");
    expect(html).not.toContain("Verification not set");
    expect(html).not.toContain("Not verified");
  });

  it("edit button navigates to edit page (link semantics)", () => {
    const html = renderPage();

    expect(html).toContain('href="/companies/company-1/edit"');
    expect(html).toContain("Edit");
  });
});
