/**
 * @vitest-environment jsdom
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadQuestionnaireEditor } from "./lead-questionnaire-editor";
import type { LeadQuestionnaireNode, LeadRecord } from "@/hooks/use-leads";
import { updateLead } from "@/hooks/use-leads";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fileHookMocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
}));

vi.mock("@/hooks/use-leads", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-leads")>("@/hooks/use-leads");
  return {
    ...actual,
    updateLead: vi.fn(),
    transitionLeadStage: vi.fn(),
  };
});

vi.mock("@/hooks/use-files", () => ({
  uploadFile: fileHookMocks.uploadFile,
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: () => ({
    stages: [
      {
        id: "stage-new",
        name: "New Lead",
        slug: "new_lead",
        isTerminal: false,
      },
      {
        id: "stage-qualified",
        name: "Qualified Lead",
        slug: "qualified_lead",
        isTerminal: false,
      },
    ],
  }),
  useProjectTypes: () => ({
    projectTypes: [{ id: "type-1", name: "Multifamily", slug: "multifamily" }],
    hierarchy: [{ id: "type-1", name: "Multifamily", children: [] }],
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
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

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, id }: { children: React.ReactNode; id?: string }) => <div id={id}>{children}</div>,
  SelectValue: ({ children, placeholder }: { children?: React.ReactNode; placeholder?: string }) => (
    <span>{children ?? placeholder}</span>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
}));

function node(overrides: Partial<LeadQuestionnaireNode>): LeadQuestionnaireNode {
  return {
    id: "node",
    projectTypeId: null,
    parentNodeId: null,
    parentOptionValue: null,
    nodeType: "question",
    key: "question",
    label: "Question",
    prompt: null,
    inputType: "text",
    options: [],
    isRequired: false,
    displayOrder: 0,
    sectionKey: "baseline",
    groupKey: "baseline",
    groupLabel: "Universal Baseline",
    groupOrder: 0,
    isActive: true,
    ...overrides,
  };
}

const nodes = [
  node({ id: "budget", key: "budget", label: "Budget", inputType: "currency", isRequired: true, displayOrder: 200 }),
  node({
    id: "building-type",
    key: "building_type",
    label: "Building Type",
    inputType: "select",
    sectionKey: "property",
    groupKey: "property",
    groupLabel: "Property/Building Info",
    displayOrder: 1000,
    options: [{ value: "garden_style", label: "Garden Style" }],
    isRequired: true,
  }),
  node({
    id: "parking-applies",
    key: "parking_lot_applies",
    label: "Does parking lot scope apply?",
    inputType: "boolean",
    sectionKey: "scope",
    groupKey: "parking_lot",
    groupLabel: "Parking Lot",
    groupOrder: 3,
    displayOrder: 0,
  }),
  node({
    id: "parking-surface",
    key: "parking_surface_type",
    label: "Concrete or Asphalt",
    inputType: "multiselect",
    options: [
      { value: "concrete", label: "Concrete" },
      { value: "asphalt", label: "Asphalt" },
    ],
    isRequired: true,
    sectionKey: "scope",
    groupKey: "parking_lot",
    groupLabel: "Parking Lot",
    groupOrder: 3,
    displayOrder: 1,
    parentNodeId: "parking-applies",
    parentOptionValue: "true",
  }),
];

function clientProvidedDocsNode(): LeadQuestionnaireNode {
  return node({
    id: "client-provided-docs",
    key: "client_provided_docs",
    label: "Client Provided Docs (Plans, Scope, Specs)",
    inputType: "file",
    displayOrder: 300,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function lead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    id: "lead-1",
    companyId: "company-1",
    propertyId: "property-1",
    primaryContactId: "contact-1",
    primaryContactRole: "property_manager",
    primaryContactRoleOtherLabel: null,
    name: "Lead One",
    stageId: "stage-new",
    assignedRepId: "rep-1",
    status: "open",
    source: "Referral",
    sourceCategory: "Referral",
    sourceDetail: null,
    existingCustomerStatus: "Existing",
    description: null,
    projectTypeId: "type-1",
    bidDueDate: null,
    projectType: { id: "type-1", name: "Multifamily", slug: "multifamily" },
    qualificationPayload: {},
    projectTypeQuestionPayload: { projectTypeId: "type-1", answers: {} },
    qualificationScope: null,
    qualificationBudgetAmount: null,
    qualificationCompanyFit: null,
    directorReviewDecision: null,
    directorReviewReason: null,
    decisionMakerName: null,
    decisionProcess: null,
    budgetStatus: null,
    incumbentVendor: null,
    unitCount: null,
    buildYear: null,
    forecastWindow: null,
    forecastCategory: null,
    forecastConfidencePercent: null,
    forecastRevenue: null,
    forecastGrossProfit: null,
    forecastBlockers: null,
    nextStep: null,
    nextStepDueAt: null,
    nextMilestoneAt: null,
    supportNeededType: null,
    supportNeededNotes: null,
    forecastUpdatedAt: null,
    forecastUpdatedBy: null,
    lastActivityAt: null,
    verificationStatus: "not_required",
    verificationRequiredReason: null,
    stageEnteredAt: "2026-01-01T00:00:00Z",
    convertedAt: null,
    isActive: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    companyName: "Acme",
    property: null,
    convertedDealId: null,
    convertedDealNumber: null,
    leadQuestionnaire: {
      projectTypeId: "type-1",
      nodes,
      allNodes: nodes,
      answers: {
        parking_lot_applies: true,
        parking_surface_type: ["concrete"],
      },
      legacyAnswers: [
        {
          questionId: "legacy-roof",
          key: "roof_age_years",
          label: "Roof Age Years",
          inputType: "number",
          options: [],
          value: 15,
          displayOrder: 1,
          projectTypeId: "legacy-type",
          sectionKey: null,
          groupKey: null,
          groupLabel: null,
          groupOrder: null,
        },
      ],
    },
    ...overrides,
  };
}

describe("LeadQuestionnaireEditor universal questionnaire", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.mocked(updateLead).mockResolvedValue({} as never);
    fileHookMocks.uploadFile.mockResolvedValue({ id: "file-1" });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
  });

  async function renderEditor(input: LeadRecord = lead(), onSaved: () => void | Promise<void> = () => undefined) {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <LeadQuestionnaireEditor lead={input} onCancel={() => undefined} onSaved={onSaved} />
      );
    });
  }

  async function submitForm() {
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  async function addClientProvidedDocs(files: File[]) {
    const input = container.querySelector<HTMLInputElement>("#client-provided-docs-upload");
    expect(input).toBeTruthy();
    Object.defineProperty(input!, "files", {
      configurable: true,
      value: files,
    });
    await act(async () => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("renders baseline and property sections as flat question groups", async () => {
    await renderEditor();

    expect(container.textContent).toContain("Budget");
    expect(container.textContent).toContain("Property/Building Info");
    expect(container.textContent).toContain("Building Type");
  });

  it("renders scope accordions and auto-expands an answered group", async () => {
    await renderEditor();

    expect(container.textContent).toContain("Parking Lot");
    expect(container.textContent).toContain("Applies");
    expect(container.textContent).toContain("Concrete or Asphalt");
    expect(container.textContent).toContain("Concrete");
  });

  it("renders archived legacy answers separately", async () => {
    await renderEditor();

    expect(container.textContent).toContain("Legacy / Archived Answers");
    expect(container.textContent).toContain("Roof Age Years");
    expect(container.textContent).toContain("15");
  });

  it("renders the qualified lead Timeline field only once when universal nodes include timeline", async () => {
    await renderEditor(
      lead({
        leadQuestionnaire: {
          projectTypeId: "type-1",
          nodes: [
            ...nodes,
            node({
              id: "timeline-node",
              key: "timeline",
              label: "Timeline",
              inputType: "textarea",
              isRequired: true,
              displayOrder: 500,
            }),
          ],
          allNodes: [
            ...nodes,
            node({
              id: "timeline-node",
              key: "timeline",
              label: "Timeline",
              inputType: "textarea",
              isRequired: true,
              displayOrder: 500,
            }),
          ],
          answers: {},
          legacyAnswers: [],
        },
      })
    );

    expect(Array.from(container.querySelectorAll("label")).filter((label) => label.textContent?.includes("Timeline")))
      .toHaveLength(1);
    expect(container.textContent).toContain("Timeline Target Date");
    expect(container.textContent).not.toContain("Timeline Notes");
  });

  it("submits the hidden universal timeline answer from the visible Timeline field", async () => {
    const timelineNode = node({
      id: "timeline-node",
      key: "timeline",
      label: "Timeline",
      inputType: "textarea",
      isRequired: true,
      displayOrder: 500,
    });
    await renderEditor(
      lead({
        qualificationPayload: { timeline_status: "Q3 2026" },
        leadQuestionnaire: {
          projectTypeId: "type-1",
          nodes: [...nodes, timelineNode],
          allNodes: [...nodes, timelineNode],
          answers: {
            parking_lot_applies: true,
            parking_surface_type: ["concrete"],
          },
          legacyAnswers: [],
        },
      })
    );

    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(updateLead).toHaveBeenCalledWith(
      "lead-1",
      expect.objectContaining({
        leadQuestionAnswers: expect.objectContaining({
          timeline: "Q3 2026",
        }),
      })
    );
  });

  it("keeps only failed client docs queued after a partial upload failure", async () => {
    const onSaved = vi.fn();
    const firstUpload = Promise.resolve({ id: "file-success" });
    const secondUpload = deferred<{ id: string }>();
    fileHookMocks.uploadFile
      .mockReturnValueOnce(firstUpload)
      .mockReturnValueOnce(secondUpload.promise);
    const leadWithClientDocs = lead({
      leadQuestionnaire: {
        projectTypeId: "type-1",
        nodes: [...nodes, clientProvidedDocsNode()],
        allNodes: [...nodes, clientProvidedDocsNode()],
        answers: {},
        legacyAnswers: [],
      },
    });

    await renderEditor(leadWithClientDocs, onSaved);
    await addClientProvidedDocs([
      new File(["plans"], "success.pdf", { type: "application/pdf" }),
      new File(["bad"], "failed.pdf", { type: "application/pdf" }),
    ]);

    await submitForm();
    await act(async () => {
      await firstUpload;
    });

    expect(container.textContent).not.toContain("success.pdf");
    expect(container.textContent).toContain("failed.pdf");

    await act(async () => {
      secondUpload.reject(new Error("Upload failed"));
      await secondUpload.promise.catch(() => undefined);
    });

    expect(onSaved).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Upload failed");
    expect(container.textContent).toContain("failed.pdf");

    fileHookMocks.uploadFile.mockClear();
    fileHookMocks.uploadFile.mockResolvedValue({ id: "file-retry" });
    await submitForm();

    expect(fileHookMocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(fileHookMocks.uploadFile.mock.calls[0][0].file.name).toBe("failed.pdf");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
