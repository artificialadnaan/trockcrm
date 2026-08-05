/**
 * @vitest-environment jsdom
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEAL_SCOPE_TITLE_MAX_LENGTH } from "@trock-crm/shared/types";
import { ServiceOpportunityForm } from "./service-opportunity-form";
import serviceOpportunityFormSource from "./service-opportunity-form.tsx?raw";
import leadFormSource from "@/components/leads/lead-form.tsx?raw";

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
  // When true the PropertySelector mock does NOT auto-emit the record for a value it was handed — the test
  // fires it later via the "Resolve property" button, standing in for the async /properties/:id lookup.
  deferPropertyResolution: { value: false },
  useTaskAssignees: vi.fn(),
  navigate: vi.fn(),
}));

// Real Router (Link/MemoryRouter still render), but navigation is observable — the success redirect and
// Cancel are the two exits that don't go through an anchor.
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

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
  CompanySelector: ({
    value,
    onChange,
    officeId,
  }: {
    value: string | null;
    onChange: (companyId: string) => void;
    officeId?: string;
  }) => {
    useEffect(() => {
      if (mocks.companySelectorEchoesOnMount.value && value) {
        onChange(value);
      }
    }, []);
    return (
      <div>
        {/* The controlled value, so a test can see whether a prefilled selection survived. */}
        <span data-testid="company-value">{value ?? ""}</span>
        <span data-testid="company-office">{officeId ?? ""}</span>
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
    officeId,
  }: {
    value: string | null;
    onChange: (propertyId: string) => void;
    onPropertySelected?: (property: { id: string; state: string }) => void;
    officeId?: string;
  }) => {
    // Mirror the real selector's value-resolution effect: a property set from OUTSIDE the dropdown (a
    // prefill, or a restore) is resolved and re-emitted, which is what feeds region auto-detect. The real
    // one does that behind an async /properties/:id fetch — deferPropertyResolution models that latency.
    useEffect(() => {
      if (mocks.deferPropertyResolution.value) return;
      if (value && value === mocks.selectedProperty.value.id) {
        onPropertySelected?.(mocks.selectedProperty.value);
      }
    }, [value]);
    return (
      <div>
        <span data-testid="property-value">{value ?? ""}</span>
        <span data-testid="property-office">{officeId ?? ""}</span>
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
        <button type="button" onClick={() => onPropertySelected?.(mocks.selectedProperty.value)}>
          Resolve property
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
  mocks.deferPropertyResolution.value = false;
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

async function renderForm(
  initialValues?: { name?: string; companyId?: string; propertyId?: string },
  officeId?: string | null,
  options: { omitOnSuccess?: boolean; cancelTo?: string } = {}
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter>
        <ServiceOpportunityForm
          // Omitting onSuccess is what exercises the built-in success REDIRECT.
          onSuccess={options.omitOnSuccess ? undefined : vi.fn()}
          initialValues={initialValues}
          officeId={officeId}
          cancelTo={options.cancelTo}
        />
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
    // The opportunity is created on the effective DATA office, never the picked prefix — that is still
    // cosmetic. (Pre-fix this passed the picked office's id, scoping create/pickers to it.) The effective
    // office is the caller's when an entry point supplied one and the rep's home office otherwise, so a
    // prefilled property is resolved and created in the SAME office; the picked DFW/ATL code changes neither.
    expect(source).toContain("{ officeId: effectiveOfficeId }");
    expect(source).toContain("const effectiveOfficeId = officeId ?? homeOfficeId;");
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

  // deals.scope_title, migration 0218. The API for this route accepts and persists the field; a client
  // that cannot SEND it means every service opportunity created here is born with scope_title = NULL and
  // accounting has to add the title by editing the deal afterwards. Server-accepts / client-cannot-send is
  // silent — nothing errors — so it is pinned here.
  it("sends the scope title through the direct-create endpoint", async () => {
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    await act(async () => {
      setInputValue(container.querySelector("#scopeTitle") as HTMLInputElement, "  Plumbing Renovations  ");
    });
    await selectAndSubmit(container);

    expect(mocks.createServiceOpportunity).toHaveBeenCalledWith(
      // Trimmed, exactly as the API normalizes it, so the two never disagree about what was stored.
      expect.objectContaining({ scopeTitle: "Plumbing Renovations" }),
      expect.anything()
    );
  });

  it("sends null for a blank scope title rather than an empty string", async () => {
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    await selectAndSubmit(container);

    expect(mocks.createServiceOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({ scopeTitle: null }),
      expect.anything()
    );
  });

  it("renders the scope-title input with the accounting examples, above Description", async () => {
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    const input = container.querySelector("#scopeTitle") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(container.querySelector('label[for="scopeTitle"]')?.textContent).toContain("Scope Title");
    expect(input.placeholder).toContain("Unit Build Back");
    expect(input.placeholder).toContain("Plumbing Renovations");
    expect(input.placeholder).toContain("Balcony Repair");

    const description = container.querySelector("#description");
    expect(description).not.toBeNull();
    expect(input.compareDocumentPosition(description!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("blocks Create with an error when the scope title is over the cap, and never calls the endpoint", async () => {
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    await act(async () => {
      setInputValue(
        container.querySelector("#scopeTitle") as HTMLInputElement,
        "A".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH + 1)
      );
    });
    await selectAndSubmit(container);

    expect(mocks.createServiceOpportunity).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      `Scope title must be ${DEAL_SCOPE_TITLE_MAX_LENGTH} characters or fewer`
    );
  });

  it("accepts a scope title at exactly the cap", async () => {
    const atLimit = "A".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH);
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    await act(async () => {
      setInputValue(container.querySelector("#scopeTitle") as HTMLInputElement, atLimit);
    });
    await selectAndSubmit(container);

    expect(mocks.createServiceOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({ scopeTitle: atLimit }),
      expect.anything()
    );
  });

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

  it("blocks Create until a PREFILLED property's record actually arrives (no region-less fast create)", async () => {
    // Prefill hands us both required ids and the name instantly, so Create is clickable long before the
    // async /properties/:id lookup returns. Until it does, propertyState is "" and the existing region guard
    // sees nothing pending — a fast rep would save a TX property with regionId: null.
    mocks.deferPropertyResolution.value = true;
    mocks.selectedProperty.value = { id: "property-9", state: "TX" };
    const { container, root } = await renderForm({
      name: "Cedar Springs opportunity",
      companyId: "company-7",
      propertyId: "property-9",
    });
    containers.push(container);
    roots.push(root);

    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    // Without the guard this submit succeeds and saves regionId: null for a TX property.
    expect(mocks.createServiceOpportunity).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Loading the property");
    const submitButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Create Service Opportunity")
    ) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);

    // The lookup lands AFTER that submit attempt — now the region can be derived and Create may proceed.
    await act(async () => {
      clickButton(container, "Resolve property");
    });
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.createServiceOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: "property-9", regionId: "region-central" }),
      { officeId: "office-dallas" }
    );
  });

  it("re-arms that block after a restore, whose blanked state is un-resolved again", async () => {
    mocks.selectedProperty.value = { id: "property-9", state: "TX" };
    const { container, root } = await renderForm({
      name: "Cedar Springs opportunity",
      companyId: "company-7",
      propertyId: "property-9",
    });
    containers.push(container);
    roots.push(root);

    // Resolution is instant here, so pin the restore path specifically: defer, then bounce the property out
    // and back. The restored id is un-held until the selector re-emits, exactly like a fresh prefill.
    mocks.deferPropertyResolution.value = true;
    await act(async () => {
      clickButton(container, "Select other company");
    });
    await act(async () => {
      clickButton(container, "Restore property");
    });

    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.createServiceOpportunity).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Loading the property");
  });

  it("works in the office the entry point supplied, not the rep's home office", async () => {
    // The property page threads ?officeId. A prefilled property lives in THAT office's schema, so the
    // pickers and the create must target it — the form's own x-office-id overrides lib/api's URL fallback,
    // so passing the home office here would resolve nothing and create the deal in the wrong tenant.
    mocks.selectedProperty.value = { id: "property-9", state: "TX" };
    const { container, root } = await renderForm(
      { name: "Cedar Springs opportunity", companyId: "company-7", propertyId: "property-9" },
      "office-atlanta"
    );
    containers.push(container);
    roots.push(root);

    expect(container.querySelector('[data-testid="company-office"]')?.textContent).toBe("office-atlanta");
    expect(container.querySelector('[data-testid="property-office"]')?.textContent).toBe("office-atlanta");

    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.createServiceOpportunity).toHaveBeenCalledWith(expect.objectContaining({ propertyId: "property-9" }), {
      officeId: "office-atlanta",
    });
  });

  it("still uses the home office when no entry point supplied one", async () => {
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    expect(container.querySelector('[data-testid="company-office"]')?.textContent).toBe("office-dallas");
    await selectAndSubmit(container);
    expect(mocks.createServiceOpportunity).toHaveBeenCalledWith(expect.anything(), { officeId: "office-dallas" });
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
    expect(container.textContent).toContain("This property has no owner company.");
    expect(container.textContent).toContain("can't be changed from the app");
    // No recovery link: nothing in the app can set an existing property's company (the PATCH allowlist
    // excludes companyId and the edit page has no such field), so offering one would be a round trip to a
    // page that cannot help. Property edit in particular must NOT be advertised as the fix.
    expect(container.querySelector('a[href="/properties/property-9/edit"]')).toBeNull();

    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.createServiceOpportunity).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Company and property are required");
  });

  function leadEscapeHref(container: HTMLElement) {
    return (
      Array.from(container.querySelectorAll("a")).find((anchor) =>
        anchor.getAttribute("href")?.startsWith("/leads/new")
      ) ?? null
    )?.getAttribute("href");
  }

  it("hands the prefill to the non-Service Lead escape instead of dumping the rep on an empty form", async () => {
    // The escape is an EXIT from the flow. A bare /leads/new drops company, property and name, so the rep
    // retypes the address and creates a second property for the same building — the precise failure this
    // entry point exists to prevent.
    mocks.selectedProperty.value = { id: "property-9", state: "TX" };
    const { container, root } = await renderForm(
      { name: "Cedar Springs opportunity", companyId: "company-7", propertyId: "property-9" },
      "office-atlanta"
    );
    containers.push(container);
    roots.push(root);

    expect(leadEscapeHref(container)).toBe(
      "/leads/new?propertyId=property-9&companyId=company-7&name=Cedar+Springs+opportunity"
    );
    // No office, even though this form HAS one — see the next test for why.
    expect(leadEscapeHref(container)).not.toContain("officeId");

    // Built from LIVE state, so an edit made before taking the escape travels with it.
    await act(async () => {
      setInputValue(container.querySelector("#name") as HTMLInputElement, "Cedar Springs re-roof");
    });
    expect(leadEscapeHref(container)).toContain("name=Cedar+Springs+re-roof");
  });

  it("omits office from the Lead escape for as long as LeadForm pins create to the home office", async () => {
    // A cross-file assumption, pinned in both directions rather than left as a comment.
    // LeadForm create mode overrides lib/api's ?officeId fallback with the rep's HOME office, so an office
    // on that href is ignored by the pickers and the create while the header-less calls still follow it —
    // one form, two tenants. Sending no office keeps it coherent (and matches the property page's own New
    // lead link). If this assertion ever fails, LeadForm has learned to honour an office: revisit
    // leadEscapeHref and thread it through, because then dropping it becomes the bug.
    expect(leadFormSource).toContain("{ officeId: homeOfficeId }");
    expect(leadFormSource).toContain("officeId: isCreate ? homeOfficeId : null");
    expect(leadFormSource).not.toContain("effectiveOfficeId");
  });

  it("leaves the Lead escape bare when there is nothing to carry", async () => {
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    // No prefill, no office: no invented params.
    expect(leadEscapeHref(container)).toBe("/leads/new");
  });

  it("redirects to the new deal in the office it was created in", async () => {
    // DealDetailPage derives its tenant from ?officeId. Without it a cross-office deal that saved perfectly
    // loads from the viewer's default office and reads as not-found — so the rep creates it again.
    mocks.selectedProperty.value = { id: "property-9", state: "TX" };
    const { container, root } = await renderForm(
      { name: "Cedar Springs opportunity", companyId: "company-7", propertyId: "property-9" },
      "office-atlanta",
      { omitOnSuccess: true }
    );
    containers.push(container);
    roots.push(root);

    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.navigate).toHaveBeenCalledWith("/deals/deal-service?officeId=office-atlanta");
  });

  it("adds no office to the redirect when the entry point had none", async () => {
    const { container, root } = await renderForm(undefined, undefined, { omitOnSuccess: true });
    containers.push(container);
    roots.push(root);

    await selectAndSubmit(container);

    expect(mocks.navigate).toHaveBeenCalledWith("/deals/deal-service");
  });

  it("sends Cancel to the explicit target so it agrees with Back", async () => {
    const { container, root } = await renderForm(undefined, undefined, {
      cancelTo: "/properties/property-9?officeId=office-atlanta",
    });
    containers.push(container);
    roots.push(root);

    await act(async () => {
      clickButton(container, "Cancel");
    });

    expect(mocks.navigate).toHaveBeenCalledWith("/properties/property-9?officeId=office-atlanta");
  });

  it("falls back to history for Cancel when no target was supplied", async () => {
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    await act(async () => {
      clickButton(container, "Cancel");
    });

    expect(mocks.navigate).toHaveBeenCalledWith(-1);
  });

  it("is unchanged for the deals-list entry point that passes no prefill", async () => {
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    expect(selectorValue(container, "company")).toBe("");
    expect(selectorValue(container, "property")).toBe("");
    expect((container.querySelector("#name") as HTMLInputElement).value).toBe("");
    // No prefill means neither prefill notice can appear.
    expect(container.textContent).not.toContain("This property has no owner company.");
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
