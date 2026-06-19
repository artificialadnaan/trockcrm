// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { getOwnerInitialColor } from "@trock-crm/shared/types";
import { CompanyListPage } from "./company-list-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useCompaniesMock: vi.fn(),
  assignCompanyOwnerToMeMock: vi.fn(),
  reassignCompanyOwnerMock: vi.fn(),
  useAuthMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  useOwnerAssigneesMock: vi.fn(),
}));

vi.mock("@/hooks/use-companies", () => ({
  useCompanies: mocks.useCompaniesMock,
  assignCompanyOwnerToMe: mocks.assignCompanyOwnerToMeMock,
  reassignCompanyOwner: mocks.reassignCompanyOwnerMock,
}));

vi.mock("@/hooks/use-task-assignees", () => ({
  useTaskAssignees: mocks.useTaskAssigneesMock,
}));

vi.mock("@/hooks/use-owner-assignees", () => ({
  useOwnerAssignees: mocks.useOwnerAssigneesMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function renderPage() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <CompanyListPage />
    </MemoryRouter>
  );
}

async function renderPageDom() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <CompanyListPage />
      </MemoryRouter>
    );
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function renderDomAt(path: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <CompanyListPage />
      </MemoryRouter>
    );
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("CompanyListPage", () => {
  beforeEach(() => {
    mocks.useCompaniesMock.mockReset();
    mocks.assignCompanyOwnerToMeMock.mockReset();
    mocks.reassignCompanyOwnerMock.mockReset();
    mocks.useAuthMock.mockReset();
    mocks.useTaskAssigneesMock.mockReset();
    mocks.useOwnerAssigneesMock.mockReset();
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "rep-1",
        displayName: "Riley Rep",
        email: "rep@example.com",
        role: "rep",
        officeId: "office-1",
      },
      loading: false,
    });
    mocks.useTaskAssigneesMock.mockReturnValue({
      assignees: [
        { id: "rep-1", displayName: "Riley Rep" },
        { id: "director-1", displayName: "Dana Director" },
      ],
      loading: false,
      error: null,
    });
    mocks.useOwnerAssigneesMock.mockReturnValue({
      assignees: [
        { id: "rep-1", displayName: "Riley Rep" },
        { id: "director-1", displayName: "Dana Director" },
      ],
      loading: false,
      error: null,
    });
    mocks.assignCompanyOwnerToMeMock.mockResolvedValue({ company: { id: "company-2", ownerId: "rep-1" } });
    mocks.reassignCompanyOwnerMock.mockResolvedValue({ company: { id: "company-1", ownerId: "director-1" } });
    mocks.useCompaniesMock.mockReturnValue({
      companies: [
        {
          id: "company-1",
          name: "T Rock Owner Group",
          category: "client",
          address: "100 Main",
          city: "Dallas",
          state: "TX",
          zip: "75201",
          phone: null,
          website: "https://owner.example.com",
          ownerUserId: "user-1",
          ownerUserName: "Alicia Adams",
          industry: "property_owner",
          region: "DFW",
          domain: "owner.example.com",
          lastActivityAt: "2026-04-11T09:00:00.000Z",
          hubspotId: "hs-1",
          procoreId: "pc-1",
          notes: null,
          companyVerificationStatus: null,
          companyVerificationRequestedAt: null,
          companyVerificationEmailSentAt: null,
          companyVerifiedAt: null,
          companyVerifiedBy: null,
          contactCount: 4,
          dealCount: 2,
          contactsCount: 4,
          propertiesCount: 3,
          activeDealsCount: 2,
          pipelineValue: "750000",
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
      ],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("?card=pipeline wires the hasActivePipeline drill into the query and shows a clearable chip", async () => {
    mocks.useCompaniesMock.mockReturnValue({
      companies: [],
      pagination: { page: 1, limit: 50, total: 2, totalPages: 1, pipelineTotal: 80000, staleCount: 2 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    const { container, cleanup } = await renderDomAt("/companies?card=pipeline");
    try {
      const allCalls = mocks.useCompaniesMock.mock.calls;
      const lastCall = allCalls[allCalls.length - 1]?.[0];
      expect(lastCall?.hasActivePipeline).toBe(true);
      expect(lastCall?.stale).toBeUndefined();
      expect(container.textContent).toContain("Filtered: Active pipeline");
      expect(container.querySelector('button[aria-label="Clear card filter"]')).not.toBeNull();
      // Exactly the drilled card carries the active ring (bare "ring-brand-red" token).
      expect(container.querySelectorAll(".ring-brand-red").length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("?card=stale wires the stale drill (not pipeline) into the query", async () => {
    mocks.useCompaniesMock.mockReturnValue({
      companies: [],
      pagination: { page: 1, limit: 50, total: 2, totalPages: 1, pipelineTotal: 80000, staleCount: 2 },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    const { container, cleanup } = await renderDomAt("/companies?card=stale");
    try {
      const allCalls = mocks.useCompaniesMock.mock.calls;
      const lastCall = allCalls[allCalls.length - 1]?.[0];
      expect(lastCall?.stale).toBe(true);
      expect(lastCall?.hasActivePipeline).toBeUndefined();
      expect(container.textContent).toContain("Filtered: Untouched 30d+");
    } finally {
      await cleanup();
    }
  });

  it("renders A1 company columns and construction-specific industry labels", () => {
    const html = normalize(renderPage());
    const ownerColor = getOwnerInitialColor("user-1");

    expect(mocks.useCompaniesMock).toHaveBeenCalledWith({
      search: undefined,
      industry: undefined,
      ownerScope: undefined,
      page: 1,
      limit: 50,
    });
    expect(html).toContain("T Rock Owner Group");
    expect(html).not.toContain(">Industry</th>");
    expect(html).toContain("Alicia Adams");
    expect(html).toContain("AA");
    expect(html).toContain(`background-color:${ownerColor.backgroundColor}`);
    expect(html).toContain(`color:${ownerColor.textColor}`);
    expect(html).toContain("owner.example.com");
    expect(html).toContain("$750,000");
  });

  it("shows Unassigned when a company has no owner", () => {
    mocks.useCompaniesMock.mockReturnValue({
      companies: [
        {
          id: "company-2",
          name: "Unowned Account",
          category: "client",
          address: null,
          city: "Dallas",
          state: "TX",
          zip: null,
          phone: null,
          website: null,
          ownerUserId: null,
          ownerUserName: null,
          industry: null,
          region: null,
          domain: null,
          lastActivityAt: null,
          hubspotId: null,
          procoreId: null,
          notes: null,
          companyVerificationStatus: null,
          companyVerificationRequestedAt: null,
          companyVerificationEmailSentAt: null,
          companyVerifiedAt: null,
          companyVerifiedBy: null,
          contactCount: 0,
          dealCount: 0,
          contactsCount: 0,
          propertiesCount: 0,
          activeDealsCount: 0,
          pipelineValue: "0",
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
      ],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      loading: false,
      error: null,
    });

    expect(normalize(renderPage())).toContain("Unassigned");
  });

  it("shows assign to me for an unassigned company and refreshes after claiming it", async () => {
    const refetch = vi.fn();
    mocks.useCompaniesMock.mockReturnValue({
      companies: [
        {
          id: "company-2",
          name: "Unowned Account",
          category: "client",
          address: null,
          city: "Dallas",
          state: "TX",
          zip: null,
          phone: null,
          website: null,
          ownerUserId: null,
          ownerUserName: null,
          industry: null,
          region: null,
          domain: null,
          lastActivityAt: null,
          hubspotId: null,
          procoreId: null,
          notes: null,
          companyVerificationStatus: null,
          companyVerificationRequestedAt: null,
          companyVerificationEmailSentAt: null,
          companyVerifiedAt: null,
          companyVerifiedBy: null,
          contactCount: 0,
          dealCount: 0,
          contactsCount: 0,
          propertiesCount: 0,
          activeDealsCount: 0,
          pipelineValue: "0",
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
      ],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch,
    });

    const { container, cleanup } = await renderPageDom();
    try {
      const assignButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Assign to me"
      );
      expect(assignButton).toBeTruthy();

      await act(async () => {
        assignButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(mocks.assignCompanyOwnerToMeMock).toHaveBeenCalledWith("company-2");
      expect(refetch).toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("does not show assign to me on an already-owned company for a rep", () => {
    expect(normalize(renderPage())).not.toContain("Assign to me");
  });

  it("shows a reassign owner affordance for directors", () => {
    mocks.useAuthMock.mockReturnValue({
      user: {
        id: "director-1",
        displayName: "Dana Director",
        email: "director@example.com",
        role: "director",
        officeId: "office-1",
      },
      loading: false,
    });

    expect(normalize(renderPage())).toContain("Reassign owner");
  });

  it("filters companies between All and Mine ownership scopes", async () => {
    const { container, cleanup } = await renderPageDom();
    try {
      const ownershipFilter = container.querySelector('[aria-label="Ownership filter"]');
      const buttons = [...(ownershipFilter?.querySelectorAll("button") ?? [])];
      const mineButton = buttons.find((button) => button.textContent?.trim() === "Mine");
      const allButton = buttons.find((button) => button.textContent?.trim() === "All");

      expect(ownershipFilter).not.toBeNull();
      expect(mineButton).not.toBeUndefined();
      expect(allButton).not.toBeUndefined();
      expect(allButton?.getAttribute("aria-pressed")).toBe("true");

      await act(async () => {
        mineButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(mocks.useCompaniesMock).toHaveBeenLastCalledWith({
        search: undefined,
        industry: undefined,
        ownerScope: "mine",
        page: 1,
        limit: 50,
      });
    } finally {
      await cleanup();
    }
  });

  it("renders visible pagination buttons with a distinct disabled state", async () => {
    mocks.useCompaniesMock.mockReturnValue({
      companies: [
        {
          id: "company-1",
          name: "T Rock Owner Group",
          category: "client",
          address: "100 Main",
          city: "Dallas",
          state: "TX",
          zip: "75201",
          phone: null,
          website: "https://owner.example.com",
          ownerUserId: "user-1",
          ownerUserName: "Alicia Adams",
          industry: "property_owner",
          region: "DFW",
          domain: "owner.example.com",
          lastActivityAt: "2026-04-11T09:00:00.000Z",
          hubspotId: "hs-1",
          procoreId: "pc-1",
          notes: null,
          companyVerificationStatus: null,
          companyVerificationRequestedAt: null,
          companyVerificationEmailSentAt: null,
          companyVerifiedAt: null,
          companyVerifiedBy: null,
          contactCount: 4,
          dealCount: 2,
          contactsCount: 4,
          propertiesCount: 3,
          activeDealsCount: 2,
          pipelineValue: "750000",
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
      ],
      pagination: { page: 1, limit: 50, total: 51, totalPages: 2 },
      loading: false,
      error: null,
    });
    const { container, cleanup } = await renderPageDom();
    try {
      const previousButton = container.querySelector('[aria-label="Previous companies page"]');
      const nextButton = container.querySelector('[aria-label="Next companies page"]');

      expect(previousButton).not.toBeNull();
      expect(nextButton).not.toBeNull();
      expect(previousButton?.className).toContain("bg-primary");
      expect(previousButton?.className).toContain("text-primary-foreground");
      expect(previousButton?.className).not.toContain("bg-background");
      expect(previousButton?.className).toContain("disabled:border-muted-foreground/20");
      expect(previousButton?.className).toContain("disabled:bg-muted");
      expect(previousButton?.className).toContain("disabled:text-muted-foreground");
      expect(nextButton?.className).toContain("bg-primary");
      expect(nextButton?.className).toContain("text-primary-foreground");
      expect(nextButton?.className).not.toContain("bg-background");
      // Touch sizing: 44px (size-11) on phones, reverting to the compact size-8 at md.
      expect(previousButton?.className).toContain("size-11");
      expect(previousButton?.className).toContain("md:size-8");
    } finally {
      await cleanup();
    }
  });

  it("does not render pagination controls for a single page", async () => {
    const { container, cleanup } = await renderPageDom();
    try {
      expect(container.querySelector('[aria-label="Previous companies page"]')).toBeNull();
      expect(container.querySelector('[aria-label="Next companies page"]')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("keeps the next button visibly disabled on the last page", async () => {
    mocks.useCompaniesMock.mockReturnValue({
      companies: [
        {
          id: "company-1",
          name: "T Rock Owner Group",
          category: "client",
          address: "100 Main",
          city: "Dallas",
          state: "TX",
          zip: "75201",
          phone: null,
          website: "https://owner.example.com",
          ownerUserId: "user-1",
          ownerUserName: "Alicia Adams",
          industry: "property_owner",
          region: "DFW",
          domain: "owner.example.com",
          lastActivityAt: "2026-04-11T09:00:00.000Z",
          hubspotId: "hs-1",
          procoreId: "pc-1",
          notes: null,
          companyVerificationStatus: null,
          companyVerificationRequestedAt: null,
          companyVerificationEmailSentAt: null,
          companyVerifiedAt: null,
          companyVerifiedBy: null,
          contactCount: 4,
          dealCount: 2,
          contactsCount: 4,
          propertiesCount: 3,
          activeDealsCount: 2,
          pipelineValue: "750000",
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-11T10:00:00.000Z",
        },
      ],
      pagination: { page: 2, limit: 50, total: 51, totalPages: 2 },
      loading: false,
      error: null,
    });
    const { container, cleanup } = await renderPageDom();
    try {
      const nextButton = container.querySelector<HTMLButtonElement>('[aria-label="Next companies page"]');
      expect(nextButton?.disabled).toBe(true);
      expect(nextButton?.className).toContain("bg-primary");
      expect(nextButton?.className).toContain("text-primary-foreground");
      expect(nextButton?.className).not.toContain("bg-background");
      expect(nextButton?.className).toContain("disabled:border-muted-foreground/20");
      expect(nextButton?.className).toContain("disabled:bg-muted");
      expect(nextButton?.className).toContain("disabled:text-muted-foreground");
    } finally {
      await cleanup();
    }
  });

  it("stacks the table into a md:hidden company card list with touch-sized filters", async () => {
    const { container, cleanup } = await renderPageDom();
    try {
      // Desktop keeps the full 8-col table, gated behind hidden md:block.
      const tableWrap = container.querySelector("div.hidden.md\\:block");
      expect(tableWrap?.querySelector("table")).toBeTruthy();
      // A md:hidden card list carries the same companies + stats on phones.
      const cards = container.querySelector('[data-testid="company-cards"]');
      expect(cards).not.toBeNull();
      expect(cards?.className).toContain("md:hidden");
      expect(cards?.textContent).toContain("T Rock Owner Group");
      expect(cards?.textContent).toContain("$750,000");
      // Card name is a real link to the company (stretched-link pattern).
      expect(cards?.querySelector('a[href="/companies/company-1"]')).toBeTruthy();
      // Industry filter pills opt into the 44px touch size (reverts at md).
      const industryFilter = container.querySelector('[aria-label="Industry filter"]');
      expect(industryFilter?.querySelector("button")?.className).toContain("min-h-[44px]");
    } finally {
      await cleanup();
    }
  });

  describe("sortable headers (server-side sort, direct columns only)", () => {
    function headerButton(container: HTMLElement, label: string): HTMLButtonElement {
      const btn = Array.from(container.querySelectorAll("button")).find((b) =>
        (b.getAttribute("aria-label") ?? "").startsWith(`Sort by ${label}`)
      );
      if (!btn) throw new Error(`no sortable header "${label}"`);
      return btn as HTMLButtonElement;
    }

    it("clicking a direct-column header sends the mapped sortBy/sortDir to the API", async () => {
      const { container, cleanup } = await renderPageDom();
      try {
        await act(async () => {
          headerButton(container, "Company").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(mocks.useCompaniesMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ sortBy: "name", sortDir: "asc" })
        );

        await act(async () => {
          headerButton(container, "Last activity").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(mocks.useCompaniesMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ sortBy: "last_activity", sortDir: "desc" })
        );

        await act(async () => {
          headerButton(container, "Owner").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(mocks.useCompaniesMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ sortBy: "owner", sortDir: "asc" })
        );
      } finally {
        await cleanup();
      }
    });

    it("aggregate columns (Pipeline / Active deals) are not sortable headers", async () => {
      const { container, cleanup } = await renderPageDom();
      try {
        const labels = Array.from(container.querySelectorAll("button"))
          .map((b) => b.getAttribute("aria-label") ?? "")
          .filter((l) => l.startsWith("Sort by "));
        expect(labels.some((l) => l.includes("Pipeline"))).toBe(false);
        expect(labels.some((l) => l.includes("Active deals"))).toBe(false);
        expect(labels.some((l) => l.includes("Properties"))).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });
});
