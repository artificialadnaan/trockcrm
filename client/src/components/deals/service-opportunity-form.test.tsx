/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceOpportunityForm } from "./service-opportunity-form";
import serviceOpportunityFormSource from "./service-opportunity-form.tsx?raw";

const mocks = vi.hoisted(() => ({
  createServiceOpportunity: vi.fn(),
  useAuth: vi.fn(),
  useAccessibleOffices: vi.fn(),
  useProjectTypes: vi.fn(),
  useRegions: vi.fn(),
  usePropertyDetail: vi.fn(),
  useTaskAssignees: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  createServiceOpportunity: mocks.createServiceOpportunity,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuth,
}));

vi.mock("@/hooks/use-accessible-offices", () => ({
  useAccessibleOffices: mocks.useAccessibleOffices,
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  useProjectTypes: mocks.useProjectTypes,
  useRegions: mocks.useRegions,
}));

vi.mock("@/hooks/use-properties", () => ({
  usePropertyDetail: mocks.usePropertyDetail,
}));

vi.mock("@/hooks/use-task-assignees", () => ({
  useTaskAssignees: mocks.useTaskAssignees,
}));

vi.mock("@/components/companies/company-selector", () => ({
  CompanySelector: ({ onChange }: { onChange: (companyId: string) => void }) => (
    <button type="button" onClick={() => onChange("company-1")}>
      Select company
    </button>
  ),
}));

vi.mock("@/components/properties/property-selector", () => ({
  PropertySelector: ({ onChange }: { onChange: (propertyId: string) => void }) => (
    <button type="button" onClick={() => onChange("property-1")}>
      Select property
    </button>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setupCommonMocks() {
  mocks.useAuth.mockReturnValue({
    user: {
      id: "rep-1",
      role: "rep",
      officeId: "office-dallas",
      activeOfficeId: "office-dallas",
    },
  });
  mocks.useAccessibleOffices.mockReturnValue({
    offices: [{ id: "office-dallas", name: "Dallas", slug: "dallas" }],
    loading: false,
    error: null,
  });
  mocks.useProjectTypes.mockReturnValue({
    hierarchy: [
      { id: "type-service", name: "Service", slug: "service", children: [] },
      { id: "type-roofing", name: "Roofing", slug: "roofing", children: [] },
    ],
  });
  mocks.useRegions.mockReturnValue({
    regions: [
      { id: "region-central", name: "Central", slug: "central" },
      { id: "region-east", name: "East Coast", slug: "east-coast" },
    ],
    loading: false,
    error: null,
  });
  mocks.usePropertyDetail.mockReturnValue({
    property: null,
    leads: [],
    deals: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.useTaskAssignees.mockReturnValue({
    assignees: [{ id: "rep-1", displayName: "Sales Rep" }],
    loading: false,
    error: null,
  });
  mocks.createServiceOpportunity.mockResolvedValue({
    deal: {
      id: "deal-service",
      name: "SMOKE TEST DELETE Service Opportunity",
      projectType: "service",
      workflowRoute: "service",
    },
  });
}

async function renderForm() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter>
        <ServiceOpportunityForm onSuccess={vi.fn()} />
      </MemoryRouter>
    );
  });

  return { container, root };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ServiceOpportunityForm", () => {
  let roots: Root[] = [];
  let containers: HTMLElement[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    setupCommonMocks();
  });

  afterEach(() => {
    for (const root of roots) {
      act(() => {
        root.unmount();
      });
    }
    for (const container of containers) {
      container.remove();
    }
    roots = [];
    containers = [];
  });

  it("treats office as a cosmetic prefix: fixed DFW/ATL options, create + pickers on the HOME office", () => {
    const source = serviceOpportunityFormSource.replace(/\s+/g, " ");
    // Office Select offers the fixed prefix options (both DFW and ATL) rather than only accessible offices.
    expect(source).toContain("buildOfficeCodePrefixOptions");
    // The opportunity is created on the rep's HOME (active) office, NOT the picked office — the prefix is
    // cosmetic. (Pre-fix this passed the picked office's id, scoping create/pickers to it.)
    expect(source).toContain("{ officeId: homeOfficeId }");
    expect(source).not.toContain("selectedOffice?.officeId");
    expect(source).not.toContain("selectedOffice.officeId");
  });

  it("locks Project Type to Service and links non-Service work to the Lead form", async () => {
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    expect(container.textContent).toContain("Service");
    expect(container.textContent).toContain(
      "Direct-create is only available for Service projects. For other project types, start a new Lead."
    );
    expect(container.querySelector('a[href="/leads/new"]')).toBeTruthy();
    expect(container.querySelector('[name="projectTypeId"]')).toBeNull();
  });

  it("submits only the minimum Service opportunity payload through the dedicated endpoint hook", async () => {
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    await act(async () => {
      setInputValue(container.querySelector("#name") as HTMLInputElement, "SMOKE TEST DELETE Service Opportunity");
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Select company")?.click();
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Select property")?.click();
    });
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.createServiceOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "SMOKE TEST DELETE Service Opportunity",
        companyId: "company-1",
        propertyId: "property-1",
        assignedRepId: "rep-1",
        projectTypeId: "type-service",
        projectType: "service",
        officeCode: "dfw",
      }),
      { officeId: "office-dallas" }
    );
  });
});
