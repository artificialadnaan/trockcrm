/**
 * @vitest-environment jsdom
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LeadForm } from "./lead-form";
import type { LeadQuestionnaireNode } from "@/hooks/use-leads";
import type { PropertySurface } from "@/hooks/use-properties";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projectTypes = [{ id: "type-1", name: "Multifamily", slug: "multifamily" }];
const projectTypeHierarchy = [{ id: "type-1", name: "Multifamily", children: [] as Array<{ id: string; name: string }> }];
const completeProperty: PropertySurface = {
  id: "property-1",
  companyId: "company-1",
  companyName: "Acme",
  name: "Palm Villas",
  address: "123 Main",
  city: "Dallas",
  state: "TX",
  zip: "75001",
  buildYear: 2001,
  unitCount: 120,
  notes: null,
  isActive: true,
  createdAt: "2026-04-22T00:00:00.000Z",
  updatedAt: "2026-04-22T00:00:00.000Z",
  leadCount: 0,
  dealCount: 0,
  convertedDealCount: 0,
  lastActivityAt: null,
};
let properties = [
  {
    ...completeProperty,
  },
];
const contacts = [{ id: "contact-1", firstName: "Ada", lastName: "Lovelace" }];
let propertyDetail: PropertySurface | null = null;
const companyContactsRefetch = vi.fn();
const leadHookMocks = vi.hoisted(() => ({
  createLead: vi.fn(),
  updateLead: vi.fn(),
  useLeadQuestionnaireTemplate: vi.fn(() => ({
    questionnaire: null,
    loading: false,
  })),
}));
const propertyHookMocks = vi.hoisted(() => ({
  updateProperty: vi.fn(),
}));
const contactHookMocks = vi.hoisted(() => ({
  createContact: vi.fn(),
}));
const authMocks = vi.hoisted(() => ({
  user: {
    id: "rep-1",
    email: "rep@example.com",
    displayName: "Rep One",
    role: "rep" as "admin" | "director" | "rep",
    officeId: "office-1",
    activeOfficeId: "office-dallas",
  },
}));
const officeMocks = vi.hoisted(() => ({
  useAccessibleOffices: vi.fn(),
}));
const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => routerMocks.navigate,
  };
});

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: () => ({
    stages: [
      {
        id: "stage-new",
        name: "New Lead",
        slug: "new_lead",
        workflowFamily: "lead",
        isActivePipeline: true,
        isTerminal: false,
      },
    ],
  }),
  useProjectTypes: () => ({
    projectTypes,
    hierarchy: projectTypeHierarchy,
  }),
}));

vi.mock("@/hooks/use-properties", () => ({
  useProperties: () => ({
    properties,
  }),
  usePropertyDetail: () => ({
    property: propertyDetail,
    loading: false,
    error: null,
  }),
  formatPropertyLabel: () => "Palm Villas",
  updateProperty: propertyHookMocks.updateProperty,
}));

vi.mock("@/hooks/use-companies", () => ({
  useCompanyContacts: () => ({
    contacts,
    refetch: companyContactsRefetch,
  }),
}));

vi.mock("@/hooks/use-contacts", () => ({
  createContact: contactHookMocks.createContact,
}));

vi.mock("@/hooks/use-leads", () => ({
  createLead: leadHookMocks.createLead,
  updateLead: leadHookMocks.updateLead,
  useLeadQuestionnaireTemplate: leadHookMocks.useLeadQuestionnaireTemplate,
}));

vi.mock("@/hooks/use-task-assignees", () => ({
  useTaskAssignees: () => ({
    assignees: [
      { id: "rep-1", displayName: "Rep One" },
      { id: "rep-2", displayName: "Rep Two" },
    ],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: authMocks.user,
    loading: false,
    login: vi.fn(),
    localLogin: vi.fn(),
    changePassword: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-accessible-offices", () => ({
  useAccessibleOffices: officeMocks.useAccessibleOffices,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    type,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button type={type} disabled={disabled} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    open ? <div data-dialog-open="true">{children}</div> : null
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const SelectContext = React.createContext<{
  items?: Array<{ value: string | null; label?: React.ReactNode }>;
  value?: string;
  onValueChange?: (value: string) => void;
}>({});

function collectSelectItems(
  children: React.ReactNode,
  acc: Array<{ value: string | null; label?: React.ReactNode }> = []
): Array<{ value: string | null; label?: React.ReactNode }> {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      return;
    }

    const childProps = child.props as { value?: string | null; children?: React.ReactNode };
    if (Object.prototype.hasOwnProperty.call(childProps, "value")) {
      acc.push({
        value: childProps.value ?? null,
        label: childProps.children,
      });
    }

    if (childProps.children) {
      collectSelectItems(childProps.children, acc);
    }
  });

  return acc;
}

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    items,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    items?: Array<{ value: string | null; label?: React.ReactNode }>;
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <SelectContext.Provider value={{ items: items ?? collectSelectItems(children), value, onValueChange }}>
      <div data-select-value={value ?? "__undefined__"}>{children}</div>
    </SelectContext.Provider>
  ),
  SelectTrigger: ({ children, id }: { children: React.ReactNode; id?: string }) => <div id={id}>{children}</div>,
  SelectValue: ({ children, placeholder }: { children?: React.ReactNode; placeholder?: string }) => {
    const { items, value } = React.useContext(SelectContext);
    const label =
      children ?? items?.find((item) => item.value === (value ?? null))?.label ?? placeholder;
    return <span data-select-label="true">{label}</span>;
  },
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => {
    const { onValueChange } = React.useContext(SelectContext);
    return (
      <button type="button" data-value={value} onClick={() => onValueChange?.(value)}>
        {children}
      </button>
    );
  },
}));

vi.mock("@/components/companies/company-selector", () => ({
  CompanySelector: ({ onChange }: { onChange: (companyId: string) => void }) => (
    <div>
      <span>Company Selector</span>
      <button type="button" onClick={() => onChange("company-1")}>Select Acme</button>
    </div>
  ),
}));

vi.mock("@/components/properties/property-selector", () => ({
  PropertySelector: ({ onChange }: { onChange: (propertyId: string) => void }) => (
    <div>
      <span>Property Selector</span>
      <span>Add New Property</span>
      <button type="button" onClick={() => onChange("property-1")}>Select Palm Villas</button>
    </div>
  ),
}));

vi.mock("./lead-stage-badge", () => ({
  LeadStageBadge: () => <span>Stage Badge</span>,
}));

function makeQuestionNode(overrides: Partial<LeadQuestionnaireNode> & Pick<LeadQuestionnaireNode, "id" | "key" | "label">): LeadQuestionnaireNode {
  return {
    projectTypeId: null,
    parentNodeId: null,
    parentOptionValue: null,
    nodeType: "question",
    prompt: null,
    inputType: "text",
    options: [],
    isRequired: false,
    displayOrder: 100,
    sectionKey: "baseline",
    groupKey: "baseline",
    groupLabel: "Universal Baseline",
    groupOrder: 0,
    isActive: true,
    ...overrides,
  };
}

function universalCreateQuestionnaireNodes(): LeadQuestionnaireNode[] {
  const scopeGroups = [
    ["roofing", "Roofing"],
    ["exterior_paint", "Exterior Paint"],
    ["parking_lot", "Parking Lot"],
    ["balconies", "Balconies"],
    ["water_intrusion", "Water Intrusion"],
    ["windows_doors", "Windows and Doors"],
    ["unit_upgrades", "Unit Upgrades"],
    ["corridors", "Corridors"],
    ["exterior_amenities", "Exterior Amenities"],
    ["interior_amenities", "Interior Amenities"],
  ] as const;

  const nodes: LeadQuestionnaireNode[] = [
    makeQuestionNode({
      id: "baseline-budget",
      key: "budget",
      label: "Budget",
      inputType: "currency",
      isRequired: false,
      displayOrder: 200,
    }),
    makeQuestionNode({
      id: "property-building-type",
      key: "building_type",
      label: "Building Type",
      inputType: "select",
      options: [{ value: "garden_style", label: "Garden Style" }],
      isRequired: false,
      displayOrder: 1000,
      sectionKey: "property",
      groupKey: "property",
      groupLabel: "Property/Building Info",
      groupOrder: 0,
    }),
  ];

  for (const [index, [groupKey, groupLabel]] of scopeGroups.entries()) {
    nodes.push(
      makeQuestionNode({
        id: `${groupKey}-applies`,
        key: `${groupKey}_applies`,
        label: `Does ${groupLabel.toLowerCase()} scope apply?`,
        inputType: "boolean",
        displayOrder: 0,
        sectionKey: "scope",
        groupKey,
        groupLabel,
        groupOrder: index + 1,
      })
    );
  }

  nodes.push(
    makeQuestionNode({
      id: "roof-type",
      key: "roof_type",
      label: "Roof Type",
      inputType: "text",
      isRequired: false,
      displayOrder: 1,
      sectionKey: "scope",
      groupKey: "roofing",
      groupLabel: "Roofing",
      groupOrder: 1,
      parentNodeId: "roofing-applies",
      parentOptionValue: "true",
    }),
    makeQuestionNode({
      id: "roofing-insurance-claim",
      key: "roofing_insurance_claim",
      label: "Insurance Claim",
      inputType: "boolean",
      isRequired: false,
      displayOrder: 4,
      sectionKey: "scope",
      groupKey: "roofing",
      groupLabel: "Roofing",
      groupOrder: 1,
      parentNodeId: "roofing-applies",
      parentOptionValue: "true",
    }),
    makeQuestionNode({
      id: "roofing-xactimate",
      key: "roofing_xactimate",
      label: "Xactimate",
      inputType: "boolean",
      isRequired: false,
      displayOrder: 5,
      sectionKey: "scope",
      groupKey: "roofing",
      groupLabel: "Roofing",
      groupOrder: 1,
      parentNodeId: "roofing-insurance-claim",
      parentOptionValue: "true",
    }),
    makeQuestionNode({
      id: "parking-surface-type",
      key: "parking_surface_type",
      label: "Concrete or Asphalt",
      inputType: "multiselect",
      options: [
        { value: "concrete", label: "Concrete" },
        { value: "asphalt", label: "Asphalt" },
      ],
      isRequired: true,
      displayOrder: 1,
      sectionKey: "scope",
      groupKey: "parking_lot",
      groupLabel: "Parking Lot",
      groupOrder: 3,
      parentNodeId: "parking_lot-applies",
      parentOptionValue: "true",
    })
  );

  return nodes;
}

function mockUniversalCreateQuestionnaire(nodes = universalCreateQuestionnaireNodes()) {
  leadHookMocks.useLeadQuestionnaireTemplate.mockReturnValue({
    questionnaire: {
      projectTypeId: "type-1",
      nodes,
      allNodes: nodes,
      answers: {},
    } as any,
    loading: false,
  });
}

describe("LeadForm", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    routerMocks.navigate.mockClear();
    properties = [{ ...completeProperty }];
    propertyDetail = null;
    authMocks.user.role = "rep";
    authMocks.user.id = "rep-1";
    authMocks.user.displayName = "Rep One";
    authMocks.user.officeId = "office-dallas";
    authMocks.user.activeOfficeId = "office-dallas";
    officeMocks.useAccessibleOffices.mockReturnValue({
      offices: [
        { id: "office-dallas", name: "Dallas", slug: "dallas" },
        { id: "office-atlanta", name: "Atlanta", slug: "atlanta" },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    leadHookMocks.createLead.mockResolvedValue({ lead: { id: "lead-created" } });
    propertyHookMocks.updateProperty.mockResolvedValue({ property: { ...completeProperty } });
    contactHookMocks.createContact.mockResolvedValue({
      contact: { id: "contact-created", firstName: "Grace", lastName: "Hopper" },
    });
    companyContactsRefetch.mockResolvedValue(undefined);
    leadHookMocks.useLeadQuestionnaireTemplate.mockReturnValue({
      questionnaire: null,
      loading: false,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
  });

  function renderCreateForm(initialValues: Record<string, unknown> = {}) {
    act(() => {
      root = createRoot(container);
      root.render(
        <MemoryRouter>
          <LeadForm
            mode="create"
            initialValues={{
              companyId: "company-1",
              propertyId: "property-1",
              primaryContactId: "contact-1",
              primaryContactRole: "property_manager",
              name: "Lead One",
              source: "Referral",
              description: "",
              projectTypeId: "type-1",
              bidDueDate: "2026-06-01",
              budgetStatus: "budgeted_q1",
              ...initialValues,
            }}
          />
        </MemoryRouter>
      );
    });
  }

  async function setInputValue(input: HTMLInputElement, value: string) {
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function submitForm() {
    const form = container.querySelector("form");
    expect(form).toBeTruthy();
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  async function clickButton(button: HTMLButtonElement) {
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function findButton(label: string) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === label
    );
  }

  async function chooseQuestionSelectValue(questionKey: string, value: string) {
    const question = container.querySelector(`[data-question-key="${questionKey}"]`);
    expect(question).toBeTruthy();
    const option = question?.querySelector<HTMLButtonElement>(`button[data-value="${value}"]`);
    expect(option).toBeTruthy();
    await clickButton(option!);
  }

  it("renders source as an editable field in edit mode so New Lead gate requirements can be satisfied", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="edit"
          lead={{
            id: "lead-1",
            name: "Lead One",
            convertedDealId: null,
            convertedDealNumber: null,
            companyId: "company-1",
            companyName: "Acme",
            stageId: "stage-new",
            propertyId: "property-1",
            propertyName: "Property",
            propertyAddress: "123 Main",
            propertyCity: "Dallas",
            propertyState: "TX",
            propertyZip: "75001",
            source: "",
            description: "",
            projectTypeId: null,
            projectType: null,
            qualificationPayload: {},
            projectTypeQuestionPayload: { projectTypeId: null, answers: {} },
            stageEnteredAt: "2026-04-22T00:00:00.000Z",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Lead Qualification");
    expect(html).toContain("Source");
    expect(html).toContain("Project Type");
    expect(html).toContain("Sales Validation Fields");
  });

  it("keeps project type selects controlled when no project type has been chosen yet", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="edit"
          lead={{
            id: "lead-1",
            name: "Lead One",
            convertedDealId: null,
            convertedDealNumber: null,
            companyId: "company-1",
            companyName: "Acme",
            stageId: "stage-new",
            propertyId: "property-1",
            propertyName: "Property",
            propertyAddress: "123 Main",
            propertyCity: "Dallas",
            propertyState: "TX",
            propertyZip: "75001",
            source: "",
            description: "",
            projectTypeId: null,
            projectType: null,
            qualificationPayload: {},
            projectTypeQuestionPayload: { projectTypeId: null, answers: {} },
            stageEnteredAt: "2026-04-22T00:00:00.000Z",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain('data-select-value="__none__"');
    expect(html).not.toContain('data-select-value="__undefined__"');
  });

  it("uses the shared property selector and keeps the remaining create-mode labels human-readable", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="create"
          initialValues={{
            companyId: "company-1",
            propertyId: "property-1",
            primaryContactId: "contact-1",
            name: "Lead One",
            source: "Referral",
            description: "",
            projectTypeId: "type-1",
            stageId: "stage-new",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Property Selector");
    expect(html).toContain("Add New Property");
    expect(html).toContain("Sales Rep");
    expect(html).toContain('<span data-select-label="true">Rep One</span>');
    expect(html).toContain('<span data-select-label="true">Ada Lovelace</span>');
    expect(html).not.toContain("Initial Stage");
    expect(html).toContain('<span data-select-label="true">Multifamily</span>');
  });

  it("renders editable sales rep assignment on the lead summary card", () => {
    authMocks.user.role = "admin";
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          lead={{
            id: "lead-1",
            name: "Lead One",
            convertedDealId: null,
            convertedDealNumber: null,
            companyId: "company-1",
            companyName: "Acme",
            stageId: "stage-new",
            propertyId: "property-1",
            propertyName: "Palm Villas",
            propertyAddress: "123 Main",
            propertyCity: "Dallas",
            propertyState: "TX",
            propertyZip: "75001",
            source: "Referral",
            description: "",
            projectTypeId: "type-1",
            projectType: null,
            assignedRepId: "rep-2",
            assignedRepName: "Rep Two",
            qualificationPayload: {},
            projectTypeQuestionPayload: { projectTypeId: "type-1", answers: {} },
            stageEnteredAt: "2026-04-22T00:00:00.000Z",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Sales Rep");
    expect(html).toContain("Rep Two");
    expect(html).toContain("Save Assignment");
  });

  it("renders the selected project type label in edit mode instead of the raw id", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="edit"
          lead={{
            id: "lead-1",
            name: "Lead One",
            convertedDealId: null,
            convertedDealNumber: null,
            companyId: "company-1",
            companyName: "Acme",
            stageId: "stage-new",
            propertyId: "property-1",
            propertyName: "Palm Villas",
            propertyAddress: "123 Main",
            propertyCity: "Dallas",
            propertyState: "TX",
            propertyZip: "75001",
            source: "Referral",
            description: "",
            projectTypeId: "type-1",
            projectType: null,
            qualificationPayload: {},
            projectTypeQuestionPayload: { projectTypeId: "type-1", answers: {} },
            stageEnteredAt: "2026-04-22T00:00:00.000Z",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Multifamily");
    expect(html).not.toContain('data-select-value="__undefined__"');
  });

  it("hydrates persisted first-class create-gate values in edit mode", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="edit"
          lead={{
            id: "lead-1",
            name: "Lead One",
            convertedDealId: null,
            convertedDealNumber: null,
            companyId: "company-1",
            companyName: "Acme",
            stageId: "stage-new",
            propertyId: "property-1",
            propertyName: "Palm Villas",
            propertyAddress: "123 Main",
            propertyCity: "Dallas",
            propertyState: "TX",
            propertyZip: "75001",
            primaryContactId: "contact-1",
            primaryContactRole: "other",
            primaryContactRoleOtherLabel: "Owner representative",
            budgetStatus: "budgeted_q2",
            bidDueDate: "2026-06-01",
            source: "Referral",
            description: "",
            projectTypeId: "type-1",
            projectType: null,
            qualificationPayload: {},
            projectTypeQuestionPayload: { projectTypeId: "type-1", answers: {} },
            stageEnteredAt: "2026-04-22T00:00:00.000Z",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("POC Role");
    expect(html).toContain("Other");
    expect(html).toContain("Other POC Role");
    expect(html).toContain("Owner representative");
    expect(html).toContain("Budget Status");
    expect(html).toContain("Budgeted Q2");
    expect(html).toContain("Bid Due Date");
    expect(html).toContain('value="2026-06-01"');
  });

  it("renders first-class bid due date in create mode when the v2 template is unavailable", () => {
    leadHookMocks.useLeadQuestionnaireTemplate.mockReturnValue({
      questionnaire: null,
      loading: false,
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="create"
          initialValues={{
            companyId: "company-1",
            propertyId: "property-1",
            primaryContactId: "contact-1",
            name: "Lead One",
            source: "Referral",
            description: "",
            projectTypeId: "type-1",
            stageId: "stage-new",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Bid Due Date");
    expect(html).not.toContain("Lead questionnaire template is misconfigured");
  });

  it("renders the new create gate fields and keeps submit disabled when required fields are missing", () => {
    leadHookMocks.useLeadQuestionnaireTemplate.mockReturnValue({
      questionnaire: {
        projectTypeId: "type-1",
        nodes: [
          {
            id: "node-2",
            projectTypeId: null,
            parentNodeId: null,
            parentOptionValue: null,
            nodeType: "question",
            key: "number_of_bidders",
            label: "Number of Bidders",
            prompt: null,
            inputType: "number",
            options: [],
            isRequired: false,
            displayOrder: 20,
            isActive: true,
          },
        ],
        allNodes: [],
        answers: {},
      } as any,
      loading: false,
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="create"
          initialValues={{
            companyId: "company-1",
            propertyId: "property-1",
            primaryContactId: "",
            name: "Lead One",
            source: "Referral",
            description: "",
            projectTypeId: "type-1",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Lead Creation Requirements");
    expect(html).toContain("POC Role");
    expect(html).toContain("Budget Status");
    expect(html).toContain("Bid Due Date");
    expect(html).toContain("Number of Bidders");
    expect(html).toContain("<button type=\"submit\" disabled=\"\">Create Lead</button>");
  });

  it("does not surface a create-mode questionnaire misconfiguration when the v2 template is empty", () => {
    leadHookMocks.useLeadQuestionnaireTemplate.mockReturnValue({
      questionnaire: {
        projectTypeId: "type-1",
        nodes: [],
        allNodes: [],
        answers: {},
      } as any,
      loading: false,
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="create"
          initialValues={{
            companyId: "company-1",
            propertyId: "property-1",
            primaryContactId: "contact-1",
            name: "Lead One",
            source: "Referral",
            description: "",
            projectTypeId: "type-1",
          }}
        />
      </MemoryRouter>
    );

    expect(html).not.toContain("Lead questionnaire template is misconfigured");
    expect(html).toContain("Bid Due Date");
    expect(html).toContain("Bid Due Date is required.");
    expect(html).toContain("<button type=\"submit\" disabled=\"\">Create Lead</button>");
  });

  it("does not disable create solely because the questionnaire template is empty", () => {
    leadHookMocks.useLeadQuestionnaireTemplate.mockReturnValue({
      questionnaire: {
        projectTypeId: "type-1",
        nodes: [],
        allNodes: [],
        answers: {},
      } as any,
      loading: false,
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="create"
          initialValues={{
            companyId: "company-1",
            propertyId: "property-1",
            primaryContactId: "contact-1",
            primaryContactRole: "property_manager",
            name: "Lead One",
            source: "Referral",
            description: "",
            bidDueDate: "2026-06-01",
            budgetStatus: "budgeted_q1",
            projectTypeId: "type-1",
          }}
        />
      </MemoryRouter>
    );

    expect(html).not.toContain("Lead questionnaire template is misconfigured");
    expect(html.indexOf("Office")).toBeLessThan(html.indexOf("Project Type"));
    expect(html).toContain('id="bidDueDate" type="date" value="2026-06-01"');
    expect(html).toContain("<button type=\"submit\">Create Lead</button>");
  });

  it("sends the selected ATL office code and tenant header when creating a lead", async () => {
    renderCreateForm();

    await clickButton(findButton("ATL (Atlanta)")!);
    await clickButton(findButton("Select Acme")!);
    await clickButton(findButton("Select Palm Villas")!);
    await clickButton(findButton("Ada Lovelace")!);
    await submitForm();

    expect(leadHookMocks.createLead).toHaveBeenCalledWith(
      expect.objectContaining({
        officeCode: "atl",
      }),
      { officeId: "office-atlanta" }
    );
  });

  it("keeps the property requirement satisfied when a property id is selected", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="create"
          initialValues={{
            companyId: "company-1",
            propertyId: "property-1",
            primaryContactId: "contact-1",
            primaryContactRole: "property_manager",
            name: "Lead One",
            source: "Referral",
            description: "",
            bidDueDate: "2026-06-01",
            budgetStatus: "budgeted_q1",
            projectTypeId: "type-1",
          }}
        />
      </MemoryRouter>
    );

    expect(html).not.toContain("Select or create a property.");
  });

  it("keeps submit enabled when the selected property is resolved outside the stale parent list", () => {
    properties = [];
    propertyDetail = { ...completeProperty };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="create"
          initialValues={{
            companyId: "company-1",
            propertyId: "property-1",
            primaryContactId: "contact-1",
            primaryContactRole: "property_manager",
            name: "Lead One",
            source: "Referral",
            description: "",
            bidDueDate: "2026-06-01",
            budgetStatus: "budgeted_q1",
            projectTypeId: "type-1",
          }}
        />
      </MemoryRouter>
    );

    expect(html).not.toContain("Select or create a property.");
    expect(html).toContain("<button type=\"submit\">Create Lead</button>");
  });

  it("keeps submit disabled when no property is selected", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="create"
          initialValues={{
            companyId: "company-1",
            propertyId: "",
            primaryContactId: "contact-1",
            primaryContactRole: "property_manager",
            name: "Lead One",
            source: "Referral",
            description: "",
            bidDueDate: "2026-06-01",
            budgetStatus: "budgeted_q1",
            projectTypeId: "type-1",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Select or create a property.");
    expect(html).toContain("<button type=\"submit\" disabled=\"\">Create Lead</button>");
  });

  it("sets the form property id from the property selector", async () => {
    renderCreateForm({ propertyId: "" });

    await clickButton(findButton("Select Palm Villas")!);

    expect(container.textContent).not.toContain("Select or create a property.");
  });

  it("renders universal questionnaire baseline, property, and scope sections in create mode", () => {
    mockUniversalCreateQuestionnaire();

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="create"
          initialValues={{
            companyId: "company-1",
            propertyId: "property-1",
            primaryContactId: "contact-1",
            primaryContactRole: "property_manager",
            name: "Lead One",
            source: "Referral",
            description: "",
            bidDueDate: "2026-06-01",
            budgetStatus: "budgeted_q1",
            projectTypeId: "type-1",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Budget");
    expect(html).toContain("Property/Building Info");
    expect(html).toContain("Building Type");
    expect(html).toContain("Scope");
    expect(html.indexOf("Budget")).toBeLessThan(html.indexOf("Property/Building Info"));
    expect(html.indexOf("Property/Building Info")).toBeLessThan(html.indexOf("Scope"));
  });

  it("renders scope groups as ten accordions with children hidden until applies is yes", async () => {
    mockUniversalCreateQuestionnaire();

    renderCreateForm();

    const scopeGroups = container.querySelectorAll("[data-scope-group]");
    expect(scopeGroups).toHaveLength(10);
    expect(container.textContent).toContain("Roofing");
    expect(container.textContent).not.toContain("Roof Type");

    const roofingHeader = container.querySelector<HTMLButtonElement>('[data-scope-group="roofing"] button');
    expect(roofingHeader).toBeTruthy();
    await clickButton(roofingHeader!);
    expect(container.textContent).toContain("Does roofing scope apply?");
    expect(container.textContent).not.toContain("Roof Type");

    await chooseQuestionSelectValue("roofing_applies", "true");
    expect(container.textContent).toContain("Roof Type");
    expect(container.textContent).toContain("Insurance Claim");
  });

  it("reveals nested cascade questions inside scope accordions", async () => {
    mockUniversalCreateQuestionnaire();

    renderCreateForm();
    await clickButton(container.querySelector<HTMLButtonElement>('[data-scope-group="roofing"] button')!);
    await chooseQuestionSelectValue("roofing_applies", "true");

    expect(container.textContent).not.toContain("Xactimate");
    await chooseQuestionSelectValue("roofing_insurance_claim", "true");
    expect(container.textContent).toContain("Xactimate");
  });

  it("saves universal multi-select answers from scope accordions", async () => {
    mockUniversalCreateQuestionnaire();

    renderCreateForm();
    await clickButton(container.querySelector<HTMLButtonElement>('[data-scope-group="parking_lot"] button')!);
    await chooseQuestionSelectValue("parking_lot_applies", "true");

    const concreteOption = container.querySelector<HTMLInputElement>(
      '[data-question-key="parking_surface_type"] input[value="concrete"]'
    );
    expect(concreteOption).toBeTruthy();
    await act(async () => {
      concreteOption!.click();
    });
    await submitForm();

    expect(leadHookMocks.createLead).toHaveBeenCalledTimes(1);
    expect(leadHookMocks.createLead.mock.calls[0][0].leadQuestionAnswers.parking_surface_type).toEqual([
      "concrete",
    ]);
  });

  it("renders a Year Built repair input when the selected property is missing buildYear", () => {
    properties = [{ ...completeProperty, buildYear: null }];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="create"
          initialValues={{
            companyId: "company-1",
            propertyId: "property-1",
            primaryContactId: "contact-1",
            primaryContactRole: "property_manager",
            name: "Lead One",
            source: "Referral",
            description: "",
            bidDueDate: "2026-06-01",
            budgetStatus: "budgeted_q1",
            projectTypeId: "type-1",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("This property is missing required information");
    expect(html).toContain("Year Built");
    expect(html).not.toContain("Number of Units");
    expect(html).toContain("Year built must be between");
  });

  it("renders a Number of Units repair input when the selected property is missing unitCount", () => {
    properties = [{ ...completeProperty, unitCount: null }];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="create"
          initialValues={{
            companyId: "company-1",
            propertyId: "property-1",
            primaryContactId: "contact-1",
            primaryContactRole: "property_manager",
            name: "Lead One",
            source: "Referral",
            description: "",
            bidDueDate: "2026-06-01",
            budgetStatus: "budgeted_q1",
            projectTypeId: "type-1",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("This property is missing required information");
    expect(html).toContain("Number of Units");
    expect(html).not.toContain("Year Built");
    expect(html).toContain("Number of units must be a positive integer.");
  });

  it("renders both property repair inputs when buildYear and unitCount are missing", () => {
    properties = [{ ...completeProperty, buildYear: null, unitCount: null }];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="create"
          initialValues={{
            companyId: "company-1",
            propertyId: "property-1",
            primaryContactId: "contact-1",
            primaryContactRole: "property_manager",
            name: "Lead One",
            source: "Referral",
            description: "",
            bidDueDate: "2026-06-01",
            budgetStatus: "budgeted_q1",
            projectTypeId: "type-1",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Year Built");
    expect(html).toContain("Number of Units");
  });

  it("does not render property repair inputs when buildYear and unitCount are populated", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          mode="create"
          initialValues={{
            companyId: "company-1",
            propertyId: "property-1",
            primaryContactId: "contact-1",
            primaryContactRole: "property_manager",
            name: "Lead One",
            source: "Referral",
            description: "",
            bidDueDate: "2026-06-01",
            budgetStatus: "budgeted_q1",
            projectTypeId: "type-1",
          }}
        />
      </MemoryRouter>
    );

    expect(html).not.toContain("This property is missing required information");
    expect(html).not.toContain("property-repair-build-year");
    expect(html).not.toContain("property-repair-unit-count");
  });

  it("updates repaired property values before creating the lead", async () => {
    const calls: string[] = [];
    properties = [{ ...completeProperty, buildYear: null, unitCount: null }];
    propertyHookMocks.updateProperty.mockImplementation(async () => {
      calls.push("updateProperty");
      return { property: { ...completeProperty } };
    });
    leadHookMocks.createLead.mockImplementation(async () => {
      calls.push("createLead");
      return { lead: { id: "lead-created" } };
    });

    renderCreateForm();
    await setInputValue(container.querySelector<HTMLInputElement>("#property-repair-build-year")!, "2010");
    await setInputValue(container.querySelector<HTMLInputElement>("#property-repair-unit-count")!, "42");
    await submitForm();

    expect(propertyHookMocks.updateProperty).toHaveBeenCalledWith(
      "property-1",
      {
        buildYear: 2010,
        unitCount: 42,
      },
      { officeId: "office-dallas" }
    );
    expect(leadHookMocks.createLead).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["updateProperty", "createLead"]);
  });

  it("skips lead creation and shows an error if property repair fails", async () => {
    properties = [{ ...completeProperty, buildYear: null }];
    propertyHookMocks.updateProperty.mockRejectedValue(new Error("Property update failed"));

    renderCreateForm();
    await setInputValue(container.querySelector<HTMLInputElement>("#property-repair-build-year")!, "2010");
    await submitForm();

    expect(propertyHookMocks.updateProperty).toHaveBeenCalledWith(
      "property-1",
      { buildYear: 2010 },
      { officeId: "office-dallas" }
    );
    expect(leadHookMocks.createLead).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Failed to update property: Property update failed");
  });

  it("shows inline error when inline contact phone is too short", async () => {
    renderCreateForm();

    await clickButton(findButton("+ Add new contact")!);
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactFirstName")!, "Grace");
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactLastName")!, "Hopper");
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactPhone")!, "5551234");
    await clickButton(findButton("Save Contact")!);

    expect(container.textContent).toContain("Phone must be 10-15 digits.");
    expect(contactHookMocks.createContact).not.toHaveBeenCalled();
  });

  it("shows inline error when inline contact phone is too long", async () => {
    renderCreateForm();

    await clickButton(findButton("+ Add new contact")!);
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactFirstName")!, "Grace");
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactLastName")!, "Hopper");
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactPhone")!, "555-123-4567 ext 999999");
    await clickButton(findButton("Save Contact")!);

    expect(container.textContent).toContain("Phone must be 10-15 digits.");
    expect(contactHookMocks.createContact).not.toHaveBeenCalled();
  });

  it("shows readable duplicate email errors from inline contact creation", async () => {
    contactHookMocks.createContact.mockRejectedValue(new Error("A contact with this email already exists. Please use a different email or select the existing contact."));
    renderCreateForm();

    await clickButton(findButton("+ Add new contact")!);
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactFirstName")!, "Grace");
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactLastName")!, "Hopper");
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactEmail")!, "grace@example.com");
    await clickButton(findButton("Save Contact")!);

    expect(container.textContent).toContain("A contact with this email already exists. Please use a different email or select the existing contact.");
  });

  it("shows readable validation errors from inline contact creation", async () => {
    contactHookMocks.createContact.mockRejectedValue(new Error("Please enter a valid email address."));
    renderCreateForm();

    await clickButton(findButton("+ Add new contact")!);
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactFirstName")!, "Grace");
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactLastName")!, "Hopper");
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactEmail")!, "grace@example.com");
    await clickButton(findButton("Save Contact")!);

    expect(container.textContent).toContain("Please enter a valid email address.");
  });

  it("selects the newly created inline contact after successful create", async () => {
    renderCreateForm({ primaryContactId: "" });

    await clickButton(findButton("+ Add new contact")!);
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactFirstName")!, "Grace");
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactLastName")!, "Hopper");
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactEmail")!, "grace@example.com");
    await setInputValue(container.querySelector<HTMLInputElement>("#newContactPhone")!, "(214) 555-1212");
    await clickButton(findButton("Save Contact")!);

    expect(contactHookMocks.createContact).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "grace@example.com",
        phone: "(214) 555-1212",
        skipDedupCheck: true,
      }),
      { officeId: "office-dallas" }
    );
    expect(companyContactsRefetch).toHaveBeenCalled();
    expect(container.querySelector("[data-dialog-open]")).toBeNull();
    expect(container.innerHTML).toContain('data-select-value="contact-created"');
  }, 15000);

  it("keeps table-backed questionnaire answers out of the summary rail when the v2 snapshot is present", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LeadForm
          lead={{
            id: "lead-1",
            name: "Lead One",
            convertedDealId: null,
            convertedDealNumber: null,
            companyId: "company-1",
            companyName: "Acme",
            stageId: "stage-new",
            propertyId: "property-1",
            propertyName: "Palm Villas",
            propertyAddress: "123 Main",
            propertyCity: "Dallas",
            propertyState: "TX",
            propertyZip: "75001",
            source: "Referral",
            description: "",
            projectTypeId: "type-1",
            projectType: null,
            qualificationPayload: {},
            projectTypeQuestionPayload: { projectTypeId: "type-1", answers: {} },
            leadQuestionnaire: {
              projectTypeId: "type-1",
              nodes: [
                {
                  id: "node-1",
                  projectTypeId: null,
                  parentNodeId: null,
                  parentOptionValue: null,
                  nodeType: "question",
                  key: "bid_due_date",
                  label: "Bid Due Date",
                  prompt: null,
                  inputType: "date",
                  options: [],
                  isRequired: true,
                  displayOrder: 10,
                  isActive: true,
                },
              ],
              allNodes: [],
              answers: {
                bid_due_date: "2026-05-01",
              },
            } as any,
            stageEnteredAt: "2026-04-22T00:00:00.000Z",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Lead Summary");
    expect(html).not.toContain("Project Questions");
    expect(html).not.toContain("Bid Due Date");
    expect(html).not.toContain("2026-05-01");
  });
});
