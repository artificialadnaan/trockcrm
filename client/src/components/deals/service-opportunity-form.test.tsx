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
  // The record PropertySelector emits via onPropertySelected when the user picks a property (mutable so
  // each test can set the selected property's state).
  selectedProperty: { value: { id: "property-1", state: "" } as { id: string; state: string } },
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
  PropertySelector: ({
    onChange,
    onPropertySelected,
  }: {
    onChange: (propertyId: string) => void;
    onPropertySelected?: (property: { id: string; state: string }) => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        // Mirror the real selector: emit the full selected record FIRST, then the id.
        onPropertySelected?.(mocks.selectedProperty.value);
        onChange(mocks.selectedProperty.value.id);
      }}
    >
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
  // Default: a property with NO state (region won't auto-derive unless a test sets a state).
  mocks.selectedProperty.value = { id: "property-1", state: "" };
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

  async function selectAndSubmit(container: HTMLElement) {
    await act(async () => {
      setInputValue(container.querySelector("#name") as HTMLInputElement, "SMOKE TEST DELETE Service Opportunity");
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Select company")?.click();
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Select property")?.click();
    });
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  it("captures region synchronously from the selected property so an immediate Create still includes it", async () => {
    // PropertySelector emits the picked property's state via onPropertySelected at click time (no async
    // fetch). Picking property-1 in TX (Central) must populate region even when the user Creates instantly —
    // the regression Codex flagged: a pending by-id fetch left regionId null on fast create.
    mocks.selectedProperty.value = { id: "property-1", state: "TX" };
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);
    await selectAndSubmit(container);
    expect(mocks.createServiceOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: "property-1", regionId: "region-central" }),
      { officeId: "office-dallas" }
    );
  });

  it("sends no region when the selected property has no state (nothing to derive)", async () => {
    mocks.selectedProperty.value = { id: "property-1", state: "" };
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);
    await selectAndSubmit(container);
    expect(mocks.createServiceOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: "property-1", regionId: null }),
      { officeId: "office-dallas" }
    );
  });

  it("blocks Create while regions are still loading for a stated property (no region-less fast create)", async () => {
    // Cold/slow /pipeline/regions: regions empty + loading. The picked property HAS a mappable state, so
    // creating now would save region-less — the form must wait, not submit.
    mocks.useRegions.mockReturnValue({ regions: [], loading: true, error: null });
    mocks.selectedProperty.value = { id: "property-1", state: "TX" };
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);
    await selectAndSubmit(container);
    expect(mocks.createServiceOpportunity).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Loading regions");
  });
});
