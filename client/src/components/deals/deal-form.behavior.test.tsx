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
  companySelectorProps: null as null | {
    onChange: (companyId: string) => void;
  },
  propertySelectorProps: null as null | {
    onChange: (propertyId: string) => void;
    onPropertySelected?: (property: {
      id: string;
      address: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
    }) => void;
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
  CompanySelector: (props: NonNullable<typeof mocks.companySelectorProps>) => {
    mocks.companySelectorProps = props;
    return <div data-testid="company-selector" />;
  },
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

async function renderEditForm(deal: NonNullable<Parameters<typeof DealForm>[0]["deal"]>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter>
        <DealForm deal={deal} onSuccess={vi.fn()} />
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
    mocks.companySelectorProps = null;
    mocks.propertySelectorProps = null;
    setupCommonMocks();
    mocks.updateDeal.mockResolvedValue({
      deal: {
        id: "deal-1",
        name: "Legacy Cleanup Deal",
        sourceLeadId: null,
      },
    });
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

  it("auto-selects deal region from the selected property state", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [
        { id: "office-dallas", name: "Dallas", slug: "dallas" },
      ],
      loading: false,
      error: null,
    });
    mocks.useRegions.mockReturnValue({
      regions: [
        { id: "region-west", name: "West Coast", slug: "west_coast", states: [], displayOrder: 1, isActive: true },
        { id: "region-central", name: "Central", slug: "central", states: [], displayOrder: 2, isActive: true },
        { id: "region-east", name: "East Coast", slug: "east_coast", states: [], displayOrder: 3, isActive: true },
      ],
    });

    const { container, root } = await renderForm({
      name: "SMOKE TEST DELETE region auto-select",
      companyId: "company-1",
      projectTypeId: "type-roofing",
    });
    containers.push(container);
    roots.push(root);

    await act(async () => {
      mocks.propertySelectorProps?.onPropertySelected?.({
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
        propertyState: "GA",
        regionId: "region-east",
      }),
      { officeId: "office-dallas" }
    );
  }, 30000);

  // The office picker is a cosmetic prefix decoupled from accessible-offices, so create no longer needs the
  // selected office's tenant metadata. But when accessible-offices is still loading there is no resolved
  // default prefix, so create must block until the rep picks one (the picker offers DFW/ATL regardless).
  it("blocks create until an office prefix is selected while accessible-offices is still loading", async () => {
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

    expect(container.textContent).toContain("Cannot create deal: select an office (project-number prefix).");
    expect(mocks.createDeal).not.toHaveBeenCalled();
  }, 30000);

  it("blocks create until an office prefix is selected when accessible-offices fails to load", async () => {
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

    expect(container.textContent).toContain("Cannot create deal: select an office (project-number prefix).");
    expect(mocks.createDeal).not.toHaveBeenCalled();
  }, 30000);

  it("shows company and property selectors in edit mode when a relationship is missing", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [
        { id: "office-dallas", name: "Dallas", slug: "dallas" },
      ],
      loading: false,
      error: null,
    });

    const { container, root } = await renderEditForm({
      id: "deal-legacy",
      dealNumber: "DFW-1-00001-aa",
      name: "Legacy Cleanup Deal",
      stageId: "stage-opportunity",
      assignedRepId: "rep-1",
      companyId: null,
      propertyId: null,
      sourceLeadId: null,
      isBidBoardOwned: false,
      projectTypeId: "type-roofing",
      regionId: null,
      source: null,
      workflowRoute: "normal",
    } as any);
    containers.push(container);
    roots.push(root);

    expect(container.querySelector('[data-testid="company-selector"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="property-selector"]')).not.toBeNull();
  });

  it("keeps company and property selectors hidden for edit mode when both relationships already exist", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [
        { id: "office-dallas", name: "Dallas", slug: "dallas" },
      ],
      loading: false,
      error: null,
    });

    const { container, root } = await renderEditForm({
      id: "deal-complete",
      dealNumber: "DFW-1-00002-aa",
      name: "Complete Deal",
      stageId: "stage-opportunity",
      assignedRepId: "rep-1",
      companyId: "company-1",
      propertyId: "property-1",
      sourceLeadId: null,
      isBidBoardOwned: false,
      projectTypeId: "type-roofing",
      regionId: null,
      source: null,
      workflowRoute: "normal",
    } as any);
    containers.push(container);
    roots.push(root);

    expect(container.querySelector('[data-testid="company-selector"]')).toBeNull();
    expect(container.querySelector('[data-testid="property-selector"]')).toBeNull();
  });

  it("keeps company and property selectors hidden for post-RFP edit mode when relationships already exist", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [
        { id: "office-dallas", name: "Dallas", slug: "dallas" },
      ],
      loading: false,
      error: null,
    });

    const { container, root } = await renderEditForm({
      id: "deal-rfp",
      dealNumber: "DFW-1-00004-aa",
      name: "Submitted RFP Deal",
      stageId: "stage-opportunity",
      assignedRepId: "rep-1",
      companyId: "company-1",
      propertyId: "property-1",
      sourceLeadId: null,
      isBidBoardOwned: false,
      projectTypeId: "type-roofing",
      regionId: null,
      source: null,
      workflowRoute: "normal",
      rfpApprovalRequestedAt: "2026-05-12T12:00:00.000Z",
      rfpApprovalStatus: "pending_outbox",
    } as any);
    containers.push(container);
    roots.push(root);

    expect(container.querySelector('[data-testid="company-selector"]')).toBeNull();
    expect(container.querySelector('[data-testid="property-selector"]')).toBeNull();
  });

  it("submits repaired company and property ids during edit saves", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [
        { id: "office-dallas", name: "Dallas", slug: "dallas" },
      ],
      loading: false,
      error: null,
    });

    const { container, root } = await renderEditForm({
      id: "deal-repair",
      dealNumber: "DFW-1-00003-aa",
      name: "Relationship Repair Deal",
      stageId: "stage-opportunity",
      assignedRepId: "rep-1",
      companyId: null,
      propertyId: null,
      sourceLeadId: null,
      isBidBoardOwned: false,
      projectTypeId: "type-roofing",
      regionId: null,
      source: null,
      workflowRoute: "normal",
    } as any);
    containers.push(container);
    roots.push(root);

    await act(async () => {
      mocks.companySelectorProps?.onChange("company-9");
      mocks.propertySelectorProps?.onChange("property-9");
    });
    await submit(container);

    expect(mocks.updateDeal).toHaveBeenCalledWith(
      "deal-repair",
      expect.objectContaining({
        companyId: "company-9",
        propertyId: "property-9",
        migrationMode: true,
      })
    );
  });

  it("copies selected property address fields and locks manual address entry while a property is attached", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [
        { id: "office-dallas", name: "Dallas", slug: "dallas" },
      ],
      loading: false,
      error: null,
    });

    const { container, root } = await renderEditForm({
      id: "deal-rfp-address",
      dealNumber: "DFW-1-00005-aa",
      name: "Submitted RFP Address Deal",
      stageId: "stage-opportunity",
      assignedRepId: "rep-1",
      companyId: "company-1",
      propertyId: null,
      sourceLeadId: null,
      isBidBoardOwned: false,
      projectTypeId: "type-roofing",
      regionId: null,
      source: null,
      workflowRoute: "normal",
      propertyAddress: "Old deal address",
      propertyCity: "Dallas",
      propertyState: "TX",
      propertyZip: "75201",
      rfpApprovalRequestedAt: "2026-05-12T12:00:00.000Z",
      rfpApprovalStatus: "pending_outbox",
    } as any);
    containers.push(container);
    roots.push(root);

    const addressInput = container.querySelector<HTMLInputElement>("#propertyAddress");
    expect(addressInput?.readOnly).toBe(false);

    await act(async () => {
      mocks.propertySelectorProps?.onPropertySelected?.({
        id: "property-2",
        address: "5000 Triangle Pkwy",
        city: "Peachtree Corners",
        state: "GA",
        zip: "30092",
      });
      mocks.propertySelectorProps?.onChange("property-2");
    });

    expect(container.querySelector<HTMLInputElement>("#propertyAddress")?.value).toBe("5000 Triangle Pkwy");
    expect(container.querySelector<HTMLInputElement>("#propertyCity")?.value).toBe("Peachtree Corners");
    expect(container.querySelector<HTMLInputElement>("#propertyState")?.value).toBe("GA");
    expect(container.querySelector<HTMLInputElement>("#propertyZip")?.value).toBe("30092");
    expect(container.querySelector<HTMLInputElement>("#propertyAddress")?.readOnly).toBe(true);

    await submit(container);

    expect(mocks.updateDeal).toHaveBeenCalledWith(
      "deal-rfp-address",
      expect.objectContaining({
        propertyId: "property-2",
        propertyAddress: "5000 Triangle Pkwy",
        propertyCity: "Peachtree Corners",
        propertyState: "GA",
        propertyZip: "30092",
        migrationMode: true,
      })
    );
  });

  // Piece A: a rep must be able to save a single enrichment field on an existing deal (including a
  // Bid-Board-Owned deal) without being forced to first attach BOTH a company and a property. The
  // reachable single-field saves via this form are close-date-only and company-only (see the
  // property-only note below). The unset relationship ids must be OMITTED from the PATCH payload — not
  // sent as "" — because the server writes them straight into uuid columns (an empty string fails the
  // uuid cast → 500).
  it("saves an existing relationship-less deal (close-date-only enrichment) without requiring company or property", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [{ id: "office-dallas", name: "Dallas", slug: "dallas" }],
      loading: false,
      error: null,
    });

    const { container, root } = await renderEditForm({
      id: "deal-bbo",
      dealNumber: "DFW-1-09999-aa",
      name: "Bid Board Deal",
      stageId: "stage-opportunity",
      assignedRepId: "rep-1",
      companyId: null,
      propertyId: null,
      sourceLeadId: null,
      isBidBoardOwned: true,
      expectedCloseDate: "2026-09-01",
      projectTypeId: "type-roofing",
      regionId: null,
      source: null,
      workflowRoute: "normal",
    } as any);
    containers.push(container);
    roots.push(root);

    await submit(container);

    expect(container.textContent).not.toContain("Company and property are required");
    expect(mocks.updateDeal).toHaveBeenCalledTimes(1);
    const [dealId, payload] = mocks.updateDeal.mock.calls[0];
    expect(dealId).toBe("deal-bbo");
    expect(payload.expectedCloseDate).toBe("2026-09-01");
    expect(payload).not.toHaveProperty("companyId");
    expect(payload).not.toHaveProperty("propertyId");
  });

  it("keeps the DD Estimate input editable on a Bid Board-owned deal while Bid Estimate stays locked (2026-06-18)", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [{ id: "office-dallas", name: "Dallas", slug: "dallas" }],
      loading: false,
      error: null,
    });

    const { container, root } = await renderEditForm({
      id: "deal-bbo-dd",
      dealNumber: "DFW-1-09997-aa",
      name: "Bid Board DD Edit",
      stageId: "stage-opportunity",
      assignedRepId: "rep-1",
      companyId: null,
      propertyId: null,
      sourceLeadId: null,
      isBidBoardOwned: true,
      projectTypeId: "type-roofing",
      regionId: null,
      source: null,
      workflowRoute: "normal",
    } as any);
    containers.push(container);
    roots.push(root);

    const ddInput = container.querySelector<HTMLInputElement>("#ddEstimate");
    const bidInput = container.querySelector<HTMLInputElement>("#bidEstimate");
    expect(ddInput).not.toBeNull();
    // DD is editable even on a bid-board-owned deal; a manual edit is kept by dd_estimate_overridden (0164).
    expect(ddInput?.disabled).toBe(false);
    // Bid Estimate stays Procore-owned / locked.
    expect(bidInput?.disabled).toBe(true);
  });

  it("saves a company-only fill-in on an existing deal without requiring a property", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [{ id: "office-dallas", name: "Dallas", slug: "dallas" }],
      loading: false,
      error: null,
    });

    const { container, root } = await renderEditForm({
      id: "deal-company-only",
      dealNumber: "DFW-1-09998-aa",
      name: "Company Only Deal",
      stageId: "stage-opportunity",
      assignedRepId: "rep-1",
      companyId: null,
      propertyId: null,
      sourceLeadId: null,
      isBidBoardOwned: true,
      projectTypeId: "type-roofing",
      regionId: null,
      source: null,
      workflowRoute: "normal",
    } as any);
    containers.push(container);
    roots.push(root);

    await act(async () => {
      mocks.companySelectorProps?.onChange("company-7");
    });
    await submit(container);

    expect(container.textContent).not.toContain("Company and property are required");
    expect(mocks.updateDeal).toHaveBeenCalledTimes(1);
    const [, payload] = mocks.updateDeal.mock.calls[0];
    expect(payload.companyId).toBe("company-7");
    expect(payload).not.toHaveProperty("propertyId");
  });

  // Note on "property-only": there is no reachable UI flow for it. PropertySelector is company-scoped
  // (disabled without a companyId — it shows "Select company first"), so a property is always chosen
  // alongside its company. The reachable single-field saves are therefore close-date-only and
  // company-only; a property always arrives with its company (covered by the repair test above). The
  // server still tolerates a property-only partial PATCH — guarded in patch-route.test.ts.

  // The relaxation is scoped to editing an existing deal. Creating a brand-new deal must STILL require
  // both a company and a property (a new direct-create deal needs its relationships established).
  it("still requires company and property when creating a new deal", async () => {
    mocks.useAccessibleOffices.mockReturnValue({
      offices: [{ id: "office-dallas", name: "Dallas", slug: "dallas" }],
      loading: false,
      error: null,
    });

    const { container, root } = await renderForm({
      name: "New Deal Without Relationships",
      projectTypeId: "type-roofing",
    });
    containers.push(container);
    roots.push(root);

    await submit(container);

    expect(container.textContent).toContain("Company and property are required");
    expect(mocks.createDeal).not.toHaveBeenCalled();
  }, 30000);
});
