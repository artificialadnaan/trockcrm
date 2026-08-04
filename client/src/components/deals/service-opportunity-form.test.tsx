/**
 * @vitest-environment jsdom
 */
import { act, useEffect } from "react";
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
  // When true the CompanySelector mock echoes the company it is ALREADY showing back through onChange on
  // mount — what the real picker effectively does when it resolves a controlled value (or on a remount).
  companySelectorEchoesOnMount: { value: false },
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
  CompanySelector: ({ value, onChange }: { value: string | null; onChange: (companyId: string) => void }) => {
    useEffect(() => {
      if (mocks.companySelectorEchoesOnMount.value && value) {
        onChange(value);
      }
    }, []);
    return (
      <div>
        {/* The controlled value, so a test can see whether a prefilled selection survived. */}
        <span data-testid="company-value">{value ?? ""}</span>
        <button type="button" onClick={() => onChange("company-1")}>
          Select company
        </button>
        <button type="button" onClick={() => onChange("company-2")}>
          Select other company
        </button>
      </div>
    );
  },
}));

vi.mock("@/components/properties/property-selector", () => ({
  PropertySelector: ({
    value,
    onChange,
    onPropertySelected,
  }: {
    value: string | null;
    onChange: (propertyId: string) => void;
    onPropertySelected?: (property: { id: string; state: string }) => void;
  }) => {
    // Mirror the real selector's value-resolution effect: a property set from OUTSIDE the dropdown (a
    // prefill, or a restore) is resolved and re-emitted, which is what feeds region auto-detect.
    useEffect(() => {
      if (value && value === mocks.selectedProperty.value.id) {
        onPropertySelected?.(mocks.selectedProperty.value);
      }
    }, [value]);
    return (
      <div>
        <span data-testid="property-value">{value ?? ""}</span>
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
      </div>
    );
  },
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
  mocks.companySelectorEchoesOnMount.value = false;
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

async function renderForm(initialValues?: { name?: string; companyId?: string; propertyId?: string }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter>
        <ServiceOpportunityForm onSuccess={vi.fn()} initialValues={initialValues} />
      </MemoryRouter>
    );
  });
  // Let every mount-time effect and resolved promise land before a test asserts — a prefill that only
  // survives the first paint is worthless.
  await act(async () => {
    await Promise.resolve();
  });

  return { container, root };
}

function selectorValue(container: HTMLElement, which: "company" | "property") {
  return container.querySelector(`[data-testid="${which}-value"]`)?.textContent ?? "";
}

function clickButton(container: HTMLElement, label: string) {
  Array.from(container.querySelectorAll("button")).find((button) => button.textContent === label)?.click();
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

  it("keeps a prefilled company + property through mount and submits exactly those ids", async () => {
    // The property page hands us the property ALREADY chosen. If anything on mount (the office-code effect,
    // the region effect, a picker resolving its value) could reset it, the rep would land on an empty
    // property picker and re-add an address that already exists — the duplicate this feature exists to stop.
    mocks.selectedProperty.value = { id: "property-9", state: "TX" };
    const { container, root } = await renderForm({
      name: "Cedar Springs opportunity",
      companyId: "company-7",
      propertyId: "property-9",
    });
    containers.push(container);
    roots.push(root);

    expect(selectorValue(container, "company")).toBe("company-7");
    expect(selectorValue(container, "property")).toBe("property-9");
    expect((container.querySelector("#name") as HTMLInputElement).value).toBe("Cedar Springs opportunity");

    // Submit WITHOUT touching either picker — the prefill alone must be enough.
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.createServiceOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Cedar Springs opportunity",
        companyId: "company-7",
        propertyId: "property-9",
        // The prefilled property resolves like a picked one, so region still auto-detects from its state.
        regionId: "region-central",
      }),
      { officeId: "office-dallas" }
    );
  });

  it("survives a company picker that re-emits the company it is already showing", async () => {
    // Value resolution / a remount can fire onChange with the UNCHANGED company. Treating that as a company
    // change would silently blank the prefilled property mid-mount, with nothing on screen to explain it.
    mocks.companySelectorEchoesOnMount.value = true;
    mocks.selectedProperty.value = { id: "property-9", state: "TX" };
    const { container, root } = await renderForm({ companyId: "company-7", propertyId: "property-9" });
    containers.push(container);
    roots.push(root);

    expect(selectorValue(container, "company")).toBe("company-7");
    expect(selectorValue(container, "property")).toBe("property-9");
    expect(container.textContent).not.toContain("Changing the company cleared the property");
  });

  it("clears the prefilled property on a DELIBERATE company change, and restores both in one click", async () => {
    // A property belongs to exactly one company (the server rejects a mismatched pair), so clearing is
    // correct here — but it must be recoverable, not a shove towards "Add New Property".
    mocks.selectedProperty.value = { id: "property-9", state: "TX" };
    const { container, root } = await renderForm({ companyId: "company-7", propertyId: "property-9" });
    containers.push(container);
    roots.push(root);

    await act(async () => {
      clickButton(container, "Select other company");
    });
    expect(selectorValue(container, "company")).toBe("company-2");
    expect(selectorValue(container, "property")).toBe("");
    expect(container.textContent).toContain("Changing the company cleared the property");

    await act(async () => {
      clickButton(container, "Restore property");
    });
    expect(selectorValue(container, "company")).toBe("company-7");
    expect(selectorValue(container, "property")).toBe("property-9");
    expect(container.textContent).not.toContain("Changing the company cleared the property");
  });

  it("tells the rep up front when the prefilled property has no owner company, and still requires one", async () => {
    // Property page link for a company-less property: propertyId only. The server requires
    // property.companyId === companyId, so NO company choice can save this pair — say so instead of
    // letting the rep fill the form and eat a 400, and never relax the both-ids requirement.
    mocks.selectedProperty.value = { id: "property-9", state: "TX" };
    const { container, root } = await renderForm({ name: "Cedar Springs opportunity", propertyId: "property-9" });
    containers.push(container);
    roots.push(root);

    expect(selectorValue(container, "property")).toBe("property-9");
    expect(selectorValue(container, "company")).toBe("");
    expect(container.textContent).toContain("This property has no owner company yet.");
    expect(container.querySelector('a[href="/properties/property-9/edit"]')).toBeTruthy();

    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.createServiceOpportunity).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Company and property are required");
  });

  it("is unchanged for the deals-list entry point that passes no prefill", async () => {
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    expect(selectorValue(container, "company")).toBe("");
    expect(selectorValue(container, "property")).toBe("");
    expect((container.querySelector("#name") as HTMLInputElement).value).toBe("");
    // No prefill means neither prefill notice can appear.
    expect(container.textContent).not.toContain("This property has no owner company yet.");
    expect(container.textContent).not.toContain("Changing the company cleared the property");
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
