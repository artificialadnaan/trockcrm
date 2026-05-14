/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DealForm } from "./deal-form";

const mocks = vi.hoisted(() => ({
  createDeal: vi.fn(),
  updateDeal: vi.fn(),
  useAuth: vi.fn(),
  useAccessibleOffices: vi.fn(),
  usePipelineStages: vi.fn(),
  useProjectTypes: vi.fn(),
  useRegions: vi.fn(),
  useTaskAssignees: vi.fn(),
  propertySelectorProps: null as null | {
    onChange: (propertyId: string) => void;
    onPropertyRepaired?: (property: {
      id: string;
      address: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
    }) => void;
  },
}));

vi.mock("@/hooks/use-deals", () => ({
  createDeal: mocks.createDeal,
  updateDeal: mocks.updateDeal,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuth,
}));

vi.mock("@/hooks/use-accessible-offices", () => ({
  useAccessibleOffices: mocks.useAccessibleOffices,
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: mocks.usePipelineStages,
  useProjectTypes: mocks.useProjectTypes,
  useRegions: mocks.useRegions,
}));

vi.mock("@/hooks/use-task-assignees", () => ({
  useTaskAssignees: mocks.useTaskAssignees,
}));

vi.mock("@/components/companies/company-selector", () => ({
  CompanySelector: () => <div data-testid="company-selector" />,
}));

vi.mock("@/components/properties/property-selector", () => ({
  PropertySelector: (props: NonNullable<typeof mocks.propertySelectorProps>) => {
    mocks.propertySelectorProps = props;
    return <div data-testid="property-selector" />;
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
  mocks.usePipelineStages.mockReturnValue({
    stages: [
      {
        id: "stage-opportunity",
        name: "Opportunity",
        slug: "opportunity",
        isActivePipeline: true,
        isTerminal: false,
        workflowFamily: "standard_deal",
      },
    ],
  });
  mocks.useProjectTypes.mockReturnValue({
    hierarchy: [
      {
        id: "type-roofing",
        name: "Roofing",
        children: [],
      },
    ],
  });
  mocks.useRegions.mockReturnValue({ regions: [] });
  mocks.useTaskAssignees.mockReturnValue({
    assignees: [{ id: "rep-1", displayName: "Sales Rep" }],
    loading: false,
  });
  mocks.createDeal.mockResolvedValue({
    deal: {
      id: "deal-1",
      name: "SMOKE TEST DELETE direct-create officecode",
      sourceLeadId: null,
    },
  });
}

async function renderForm(initialValues?: Parameters<typeof DealForm>[0]["initialValues"]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter>
        <DealForm initialValues={initialValues} onSuccess={vi.fn()} />
      </MemoryRouter>
    );
  });

  return { container, root };
}

async function submit(container: HTMLElement) {
  const form = container.querySelector("form");
  if (!form) throw new Error("form not found");

  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("DealForm direct-create context", () => {
  let roots: Root[] = [];
  let containers: HTMLElement[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.propertySelectorProps = null;
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

  it("injects officeCode, projectType, and selected tenant header when the active office is resolved", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [
        { id: "office-dallas", name: "Dallas", slug: "dallas" },
        { id: "office-atlanta", name: "Atlanta", slug: "atlanta" },
      ],
      loading: false,
      error: null,
    });

    const { container, root } = await renderForm({
      name: "SMOKE TEST DELETE direct-create officecode",
      companyId: "company-1",
      propertyId: "property-1",
      projectTypeId: "type-roofing",
    });
    containers.push(container);
    roots.push(root);

    await submit(container);

    expect(mocks.createDeal).toHaveBeenCalledWith(
      expect.objectContaining({
        officeCode: "dfw",
        projectType: "Roofing",
        creationContext: "direct",
      }),
      { officeId: "office-dallas" }
    );
  }, 30000);

  it("copies repaired property address fields into the direct-create deal payload", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [
        { id: "office-dallas", name: "Dallas", slug: "dallas" },
        { id: "office-atlanta", name: "Atlanta", slug: "atlanta" },
      ],
      loading: false,
      error: null,
    });

    const { container, root } = await renderForm({
      name: "SMOKE TEST DELETE direct-create repaired property",
      companyId: "company-1",
      projectTypeId: "type-roofing",
    });
    containers.push(container);
    roots.push(root);

    await act(async () => {
      mocks.propertySelectorProps?.onPropertyRepaired?.({
        id: "property-1",
        address: "5000 Triangle Pkwy",
        city: "Peachtree Corners",
        state: "GA",
        zip: "30092",
      });
      mocks.propertySelectorProps?.onChange("property-1");
    });
    await submit(container);

    expect(mocks.createDeal).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId: "property-1",
        propertyAddress: "5000 Triangle Pkwy",
        propertyCity: "Peachtree Corners",
        propertyState: "GA",
        propertyZip: "30092",
      }),
      { officeId: "office-dallas" }
    );
  }, 30000);

  it("blocks frontend create while selected-office tenant metadata is unresolved", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [],
      loading: true,
      error: null,
    });

    const { container, root } = await renderForm({
      name: "SMOKE TEST DELETE direct-create officecode",
      companyId: "company-1",
      propertyId: "property-1",
      projectTypeId: "type-roofing",
    });
    containers.push(container);
    roots.push(root);

    await submit(container);

    expect(container.textContent).toContain("Cannot create deal: selected office is unavailable. Contact admin.");
    expect(mocks.createDeal).not.toHaveBeenCalled();
  }, 30000);

  it("blocks frontend create when accessible-office loading fails", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [],
      loading: false,
      error: "Failed to load accessible offices",
    });

    const { container, root } = await renderForm({
      name: "SMOKE TEST DELETE direct-create officecode",
      companyId: "company-1",
      propertyId: "property-1",
      projectTypeId: "type-roofing",
    });
    containers.push(container);
    roots.push(root);

    await submit(container);

    expect(container.textContent).toContain("Cannot create deal: selected office is unavailable. Contact admin.");
    expect(mocks.createDeal).not.toHaveBeenCalled();
  }, 30000);
});
