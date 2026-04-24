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

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: () => ({
    stages: [
      {
        id: "stage-new",
        name: "New Lead",
        slug: "new_lead",
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
  createLead: vi.fn(),
  updateLead: vi.fn(),
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
    <SelectContext.Provider value={{ items, value }}>
      <div data-select-value={value ?? "__undefined__"}>{children}</div>
    </SelectContext.Provider>
  ),
  SelectTrigger: ({ children, id }: { children: React.ReactNode; id?: string }) => <div id={id}>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => {
    const { items, value } = React.useContext(SelectContext);
    const label = items?.find((item) => item.value === (value ?? null))?.label ?? placeholder;
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
});
