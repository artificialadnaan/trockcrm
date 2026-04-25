import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LeadForm } from "./lead-form";

const projectTypes = [{ id: "type-1", name: "Multifamily", slug: "multifamily" }];
const projectTypeHierarchy = [{ id: "type-1", name: "Multifamily", children: [] as Array<{ id: string; name: string }> }];
const properties = [
  {
    id: "property-1",
    companyId: "company-1",
    companyName: "Acme",
    name: "Palm Villas",
    address: "123 Main",
    city: "Dallas",
    state: "TX",
    zip: "75001",
    notes: null,
    isActive: true,
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
    leadCount: 0,
    dealCount: 0,
    convertedDealCount: 0,
    lastActivityAt: null,
  },
];
const contacts = [{ id: "contact-1", firstName: "Ada", lastName: "Lovelace" }];
const leadHookMocks = vi.hoisted(() => ({
  createLead: vi.fn(),
  updateLead: vi.fn(),
  useLeadQuestionnaireTemplate: vi.fn(() => ({
    questionnaire: null,
    loading: false,
  })),
}));

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
  formatPropertyLabel: () => "Palm Villas",
}));

vi.mock("@/hooks/use-companies", () => ({
  useCompanyContacts: () => ({
    contacts,
  }),
}));

vi.mock("@/hooks/use-leads", () => ({
  createLead: leadHookMocks.createLead,
  updateLead: leadHookMocks.updateLead,
  useLeadQuestionnaireTemplate: leadHookMocks.useLeadQuestionnaireTemplate,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
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

const SelectContext = React.createContext<{
  items?: Array<{ value: string | null; label?: React.ReactNode }>;
  value?: string;
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
  }: {
    children: React.ReactNode;
    items?: Array<{ value: string | null; label?: React.ReactNode }>;
    value?: string;
  }) => (
    <SelectContext.Provider value={{ items: items ?? collectSelectItems(children), value }}>
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
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
}));

vi.mock("@/components/companies/company-selector", () => ({
  CompanySelector: () => <div>Company Selector</div>,
}));

vi.mock("@/components/properties/property-selector", () => ({
  PropertySelector: () => (
    <div>
      <span>Property Selector</span>
      <span>Add New Property</span>
    </div>
  ),
}));

vi.mock("./lead-stage-badge", () => ({
  LeadStageBadge: () => <span>Stage Badge</span>,
}));

describe("LeadForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    leadHookMocks.useLeadQuestionnaireTemplate.mockReturnValue({
      questionnaire: null,
      loading: false,
    });
  });

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
    expect(html).toContain('<span data-select-label="true">Ada Lovelace</span>');
    expect(html).toContain('<span data-select-label="true">New Lead</span>');
    expect(html).toContain('<span data-select-label="true">Multifamily</span>');
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

  it("renders table-backed questionnaire nodes in create mode when the v2 template is available", () => {
    leadHookMocks.useLeadQuestionnaireTemplate.mockReturnValue({
      questionnaire: {
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
            stageId: "stage-new",
          }}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Bid Due Date");
    expect(html).not.toContain("Project Scope");
  });

  it("renders table-backed questionnaire answers in the summary rail when the v2 snapshot is present", () => {
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

    expect(html).toContain("Project Intake Questions");
    expect(html).toContain("Bid Due Date");
    expect(html).toContain("2026-05-01");
  });
});
