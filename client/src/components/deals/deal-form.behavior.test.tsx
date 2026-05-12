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
  PropertySelector: () => <div data-testid="property-selector" />,
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
        <DealForm initialValues={initialValues} />
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

  it("injects officeCode and projectType when the active office is resolved", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [{ id: "office-dallas", name: "Dallas", slug: "dallas" }],
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
      })
    );
  });

  it("does not block create when active-office metadata is still unresolved but the user has an activeOfficeId", async () => {
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

    expect(container.textContent).not.toContain("Cannot create deal: no active office. Contact admin.");
    expect(mocks.createDeal).toHaveBeenCalledWith(
      expect.objectContaining({
        creationContext: "direct",
        projectType: "Roofing",
      })
    );
  });

  it("does not block create when accessible-office loading fails but the user has an activeOfficeId", async () => {
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

    expect(container.textContent).not.toContain("Cannot create deal: no active office. Contact admin.");
    expect(mocks.createDeal).toHaveBeenCalledWith(
      expect.objectContaining({
        creationContext: "direct",
        projectType: "Roofing",
      })
    );
  });
});
