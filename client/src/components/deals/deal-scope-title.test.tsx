// @vitest-environment jsdom
//
// The two SURFACES of deals.scope_title: the input on the deal form, and the read on the deal-detail
// Stage & Status card.
//
// The form half also pins the client side of the length cap. It is deliberately a duplicate of a check
// the API already makes (server tests/modules/deals/scope-title-api-cap.runtime.test.ts) — the API cap
// is what MAKES it a cap, and this one is what stops a user typing a paragraph and losing it on submit.
// Both must hold, and both read the same DEAL_SCOPE_TITLE_MAX_LENGTH so they cannot drift apart.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEAL_SCOPE_TITLE_MAX_LENGTH } from "@trock-crm/shared/types";
import type { Deal, DealDetail } from "@/hooks/use-deals";

const mocks = vi.hoisted(() => ({
  createDeal: vi.fn(),
  updateDeal: vi.fn(),
  useAuth: vi.fn(),
  useAccessibleOffices: vi.fn(),
  usePipelineStages: vi.fn(),
  useProjectTypes: vi.fn(),
  useRegions: vi.fn(),
  useTaskAssignees: vi.fn(),
  useSalesReps: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({
  createDeal: mocks.createDeal,
  updateDeal: mocks.updateDeal,
}));
vi.mock("@/lib/auth", () => ({ useAuth: mocks.useAuth }));
vi.mock("@/hooks/use-accessible-offices", () => ({ useAccessibleOffices: mocks.useAccessibleOffices }));
vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: mocks.usePipelineStages,
  useProjectTypes: mocks.useProjectTypes,
  useRegions: mocks.useRegions,
}));
vi.mock("@/hooks/use-task-assignees", () => ({ useTaskAssignees: mocks.useTaskAssignees }));
vi.mock("@/hooks/use-sales-reps", () => ({ useSalesReps: mocks.useSalesReps }));
vi.mock("@/components/companies/company-selector", () => ({
  CompanySelector: () => <div data-testid="company-selector" />,
}));
vi.mock("@/components/properties/property-selector", () => ({
  PropertySelector: () => <div data-testid="property-selector" />,
}));
// Overview-tab children that reach for data of their own; irrelevant to what is asserted here.
vi.mock("@/components/ai/deal-copilot-panel", () => ({ DealCopilotPanel: () => <div /> }));
vi.mock("./deal-description-history", () => ({ DealDescriptionHistory: () => <div /> }));

const { DealForm } = await import("./deal-form");
const { DealOverviewTab } = await import("./deal-overview-tab");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT_LIMIT = "A".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH);
const OVER_LIMIT = "A".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH + 1);

function setupFormMocks() {
  mocks.useAuth.mockReturnValue({
    user: { id: "rep-1", role: "rep", officeId: "office-dallas", activeOfficeId: "office-dallas" },
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
        displayOrder: 1,
      },
    ],
    loading: false,
  });
  mocks.useProjectTypes.mockReturnValue({ hierarchy: [], projectTypes: [] });
  mocks.useRegions.mockReturnValue({ regions: [] });
  mocks.useTaskAssignees.mockReturnValue({
    assignees: [{ id: "rep-1", displayName: "Sales Rep" }],
    loading: false,
  });
  mocks.useSalesReps.mockReturnValue({ salesReps: [] });
  mocks.useAccessibleOffices.mockReturnValue({
    offices: [{ id: "office-dallas", name: "Dallas", slug: "dallas" }],
    loading: false,
    error: null,
  });
  mocks.createDeal.mockResolvedValue({ deal: { id: "deal-1", name: "Created", sourceLeadId: null } });
  mocks.updateDeal.mockResolvedValue({ deal: { id: "deal-1", name: "Updated", sourceLeadId: null } });
}

let roots: Root[] = [];
let containers: HTMLElement[] = [];

async function renderForm(props: Parameters<typeof DealForm>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <DealForm {...props} />
      </MemoryRouter>
    );
  });
  roots.push(root);
  containers.push(container);
  return container;
}

/** React overrides the native `value` setter on controlled inputs; this is the standard escape hatch. */
async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(container: HTMLElement) {
  const form = container.querySelector("form");
  if (!form) throw new Error("form not found");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function scopeTitleInput(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>("#scopeTitle");
  if (!input) throw new Error("scope title input not rendered");
  return input;
}

describe("DealForm — the scope-title input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFormMocks();
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    for (const container of containers) container.remove();
    roots = [];
    containers = [];
  });

  it("renders a labelled input carrying the accounting examples, ABOVE the long Description field", async () => {
    const container = await renderForm({ onSuccess: vi.fn() });

    const label = container.querySelector('label[for="scopeTitle"]');
    expect(label?.textContent).toContain("Scope Title");

    const input = scopeTitleInput(container);
    // The examples come from the request that asked for the field; they are what makes "short title"
    // concrete to a rep who would otherwise paste the description again.
    expect(input.placeholder).toContain("Unit Build Back");
    expect(input.placeholder).toContain("Plumbing Renovations");
    expect(input.placeholder).toContain("Balcony Repair");

    // Order is the design: the brief answer first, the notes field as overflow.
    const description = container.querySelector("#description");
    expect(description).not.toBeNull();
    expect(input.compareDocumentPosition(description!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sends a typed title (trimmed) on create", async () => {
    const container = await renderForm({
      onSuccess: vi.fn(),
      initialValues: { name: "SMOKE TEST DELETE scope title", companyId: "company-1", propertyId: "property-1" },
    });

    await typeInto(scopeTitleInput(container), "  Balcony Repair  ");
    await submit(container);

    expect(mocks.createDeal).toHaveBeenCalledWith(
      expect.objectContaining({ scopeTitle: "Balcony Repair" }),
      expect.anything()
    );
  });

  it("sends null when the field is left blank, rather than an empty string", async () => {
    const container = await renderForm({
      onSuccess: vi.fn(),
      initialValues: { name: "SMOKE TEST DELETE scope title", companyId: "company-1", propertyId: "property-1" },
    });

    await submit(container);

    expect(mocks.createDeal).toHaveBeenCalledWith(
      expect.objectContaining({ scopeTitle: null }),
      expect.anything()
    );
  });

  it(`blocks submit with an inline error at ${DEAL_SCOPE_TITLE_MAX_LENGTH + 1} characters`, async () => {
    const container = await renderForm({
      onSuccess: vi.fn(),
      initialValues: { name: "SMOKE TEST DELETE scope title", companyId: "company-1", propertyId: "property-1" },
    });

    await typeInto(scopeTitleInput(container), OVER_LIMIT);
    await submit(container);

    expect(mocks.createDeal).not.toHaveBeenCalled();
    expect(container.textContent).toContain(`Must be ${DEAL_SCOPE_TITLE_MAX_LENGTH} characters or fewer`);
  });

  it(`accepts exactly ${DEAL_SCOPE_TITLE_MAX_LENGTH} characters`, async () => {
    const container = await renderForm({
      onSuccess: vi.fn(),
      initialValues: { name: "SMOKE TEST DELETE scope title", companyId: "company-1", propertyId: "property-1" },
    });

    await typeInto(scopeTitleInput(container), AT_LIMIT);
    await submit(container);

    expect(mocks.createDeal).toHaveBeenCalledWith(
      expect.objectContaining({ scopeTitle: AT_LIMIT }),
      expect.anything()
    );
  });

  it("pre-fills the saved title when editing, and sends the edited value", async () => {
    const deal = {
      id: "deal-1",
      dealNumber: "DFW-0001",
      name: "Palm Villas",
      stageId: "stage-opportunity",
      assignedRepId: "rep-1",
      companyId: "company-1",
      propertyId: "property-1",
      sourceLeadId: "lead-1",
      scopeTitle: "Interior Repair",
      description: null,
    } as unknown as Deal;

    const container = await renderForm({ deal, onSuccess: vi.fn() });

    const input = scopeTitleInput(container);
    expect(input.value).toBe("Interior Repair");

    await typeInto(input, "Unit Build Back");
    await submit(container);

    expect(mocks.updateDeal).toHaveBeenCalledWith(
      "deal-1",
      expect.objectContaining({ scopeTitle: "Unit Build Back" })
    );
  });
});

function makeDetailDeal(overrides: Partial<DealDetail> = {}): DealDetail {
  return {
    id: "deal-1",
    dealNumber: "DFW-0001",
    name: "Palm Villas",
    stageId: "stage-opportunity",
    stageName: "Opportunity",
    assignedRepId: "rep-1",
    assignedRepName: "Sales Rep",
    companyId: null,
    propertyId: null,
    sourceLeadId: null,
    scopeTitle: null,
    description: null,
    winProbability: null,
    changeOrders: [],
    dealChangeOrders: [],
    dealChangeOrderTotal: null,
    atRisk: null,
    lostReasonId: null,
    lostNotes: null,
    lostCompetitor: null,
    lostAt: null,
    procoreProjectId: null,
    procoreLastSyncedAt: null,
    lastActivityAt: null,
    propertyState: null,
    propertyZip: null,
    projectTypeId: null,
    regionId: null,
    source: null,
    expectedCloseDate: null,
    actualCloseDate: null,
    propertyAddress: null,
    propertyCity: null,
    stageEnteredAt: "2026-04-10T10:00:00.000Z",
    createdAt: "2026-04-09T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    ...overrides,
  } as unknown as DealDetail;
}

function renderOverview(deal: DealDetail) {
  mocks.useAuth.mockReturnValue({ user: { id: "rep-1", role: "rep", officeId: "office-dallas" } });
  mocks.useTaskAssignees.mockReturnValue({ assignees: [], loading: false });
  mocks.useSalesReps.mockReturnValue({ salesReps: [] });
  mocks.useProjectTypes.mockReturnValue({ projectTypes: [], hierarchy: [] });
  mocks.useRegions.mockReturnValue({ regions: [] });
  return renderToStaticMarkup(
    <MemoryRouter>
      <DealOverviewTab deal={deal} />
    </MemoryRouter>
  );
}

describe("DealOverviewTab — the Stage & Status card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the scope title, before the free-text description", () => {
    const html = renderOverview(
      makeDetailDeal({ scopeTitle: "Balcony Repair", description: "Long notes about the balcony." })
    );

    expect(html).toContain("Balcony Repair");
    expect(html).toContain('data-testid="deal-overview-scope-title"');
    expect(html.indexOf("Balcony Repair")).toBeLessThan(html.indexOf("Long notes about the balcony."));
  });

  it("renders NOTHING for the title when it is unset — no blank gap, no placeholder that reads as a bug", () => {
    const html = renderOverview(makeDetailDeal({ scopeTitle: null }));

    expect(html).not.toContain('data-testid="deal-overview-scope-title"');
    // The card itself still renders — an unset optional field must not take the surrounding UI with it.
    expect(html).toContain("Stage &amp; Status");
  });

  it("renders the title even when there is no description at all", () => {
    // The two are independent fields; a deal can have a clean scope title and no notes, which is in fact
    // the outcome the field is trying to produce.
    const html = renderOverview(makeDetailDeal({ scopeTitle: "Plumbing Renovations", description: null }));

    expect(html).toContain("Plumbing Renovations");
    expect(html).toContain('data-testid="deal-overview-scope-title"');
  });
});
