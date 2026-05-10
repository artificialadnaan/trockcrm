/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  DealScopingWorkspace,
  buildLineageResolvedPatch,
  buildScopingAutosavePatch,
  buildWorkspaceSectionData,
  canAutosaveScopingWorkspace,
  stripLineageOwnedWorkspaceFields,
} from "./deal-scoping-workspace";
import type {
  DealDetail,
  DealResolvedFields,
  DealScopingIntake,
} from "@/hooks/use-deals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getDealScopingIntake: vi.fn(),
  patchDealScopingIntake: vi.fn(),
  patchResolvedDealFields: vi.fn(),
  activateServiceHandoff: vi.fn(),
  linkExistingScopingAttachment: vi.fn(),
  uploadFile: vi.fn(),
  useFiles: vi.fn(),
  useProjectTypes: vi.fn(),
  usePipelineStages: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock("@/hooks/use-deals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-deals")>();
  return {
    ...actual,
    getDealScopingIntake: mocks.getDealScopingIntake,
    patchDealScopingIntake: mocks.patchDealScopingIntake,
    patchResolvedDealFields: mocks.patchResolvedDealFields,
    activateServiceHandoff: mocks.activateServiceHandoff,
    linkExistingScopingAttachment: mocks.linkExistingScopingAttachment,
  };
});

vi.mock("@/hooks/use-files", () => ({
  uploadFile: mocks.uploadFile,
  useFiles: mocks.useFiles,
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  useProjectTypes: mocks.useProjectTypes,
  usePipelineStages: mocks.usePipelineStages,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuth,
}));

vi.mock("@/components/properties/property-selector", () => ({
  PropertySelector: ({ value }: { value?: string | null }) => (
    React.createElement("div", { "data-testid": "property-selector" }, value ?? "none")
  ),
}));

function makeDeal(overrides: Partial<DealDetail> = {}): DealDetail {
  return {
    id: "deal-1",
    dealNumber: "D-1",
    name: "Deal Snapshot Name",
    stageId: "stage-1",
    pipelineDisposition: "opportunity",
    workflowRoute: "normal",
    assignedRepId: "rep-1",
    companyId: "company-1",
    propertyId: "property-1",
    sourceLeadId: "lead-1",
    primaryContactId: "contact-1",
    ddEstimate: null,
    bidEstimate: null,
    awardedAmount: null,
    changeOrderTotal: null,
    description: "Deal snapshot description",
    propertyAddress: "Old address",
    propertyCity: "Old city",
    propertyState: "GA",
    propertyZip: "30001",
    projectTypeId: "deal-type",
    regionId: null,
    source: null,
    winProbability: null,
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
    procoreProjectId: null,
    procoreBidId: null,
    sourceOfTruth: null,
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  } as DealDetail;
}

function makeResolved(overrides: Partial<DealResolvedFields> = {}): DealResolvedFields {
  return {
    projectTypeId: "lead-type",
    companyId: "company-1",
    sourceCategory: "Referral",
    sourceDetail: null,
    legacySource: null,
    propertyId: "property-1",
    propertyName: "Lead Property",
    propertyAddress: "123 Lead Way",
    propertyCity: "Atlanta",
    propertyState: "GA",
    propertyZip: "30301",
    primaryContactId: "contact-1",
    assignedRepId: "rep-1",
    workflowRoute: "normal",
    description: "Lead description",
    bidDueDate: "2026-06-01",
    ...overrides,
  };
}

function makeIntake(overrides: Partial<DealScopingIntake> = {}): DealScopingIntake {
  return {
    id: "intake-1",
    dealId: "deal-1",
    officeId: "office-1",
    workflowRouteSnapshot: "normal",
    status: "draft",
    projectTypeId: "stale-intake-type",
    sectionData: {},
    completionState: {},
    readinessErrors: { sections: {}, attachments: {} },
    firstReadyAt: null,
    activatedAt: null,
    lastAutosavedAt: "2026-04-27T00:00:00.000Z",
    createdBy: "user-1",
    lastEditedBy: "user-1",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}

async function renderWorkspace(deal: DealDetail) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(DealScopingWorkspace, { deal, onDealUpdated: vi.fn() }));
  });

  await act(async () => {
    await Promise.resolve();
  });

  return {
    container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useAuth.mockReturnValue({ user: { id: "user-1", role: "admin" } });
  mocks.useFiles.mockReturnValue({ files: [], refetch: vi.fn() });
  mocks.useProjectTypes.mockReturnValue({
    projectTypes: [{ id: "project-type-1", name: "Commercial", slug: "commercial" }],
  });
  mocks.usePipelineStages.mockReturnValue({
    stages: [
      {
        id: "stage-1",
        slug: "opportunity",
        workflowFamily: "standard_deal",
        displayOrder: 2,
      },
    ],
  });
});

describe("DealScopingWorkspace lineage routing helpers", () => {
  it("keeps source-lead fields from being shadowed by stale scoping intake data", () => {
    const stripped = stripLineageOwnedWorkspaceFields(
      {
        projectOverview: {
          propertyName: "Stale property",
          bidDueDate: "2025-01-01",
          assignPercent: "40",
        },
        propertyDetails: {
          propertyAddress: "Stale address",
          propertyCity: "Stale city",
        },
        scopeSummary: { summary: "Stale summary" },
        opportunity: { siteVisitDecision: "required" },
      },
      true
    );

    expect(stripped).toEqual({
      projectOverview: { assignPercent: "40" },
      propertyDetails: {},
      scopeSummary: {},
      opportunity: { siteVisitDecision: "required" },
    });
  });

  it("builds converted deal workspace data from resolved lead values plus opportunity-owned intake values", () => {
    const sectionData = buildWorkspaceSectionData(
      makeDeal(),
      makeIntake({
        sectionData: {
          projectOverview: { propertyName: "Stale property", bidDueDate: "2025-01-01" },
          scopeSummary: { summary: "Stale summary" },
          opportunity: { preBidMeetingCompleted: "yes" },
        },
      }),
      makeResolved()
    );

    expect(sectionData).toMatchObject({
      projectOverview: { propertyName: "Lead Property", bidDueDate: "2026-06-01" },
      propertyDetails: { propertyAddress: "123 Lead Way" },
      scopeSummary: { summary: "Lead description" },
      opportunity: { preBidMeetingCompleted: "yes" },
    });
  });

  it("routes converted-deal lead-owned edits through the resolved-fields endpoint", () => {
    const patch = buildLineageResolvedPatch({
      hasSourceLead: true,
      projectTypeId: "new-type",
      resolvedFields: makeResolved(),
      sectionData: {
        projectOverview: { bidDueDate: "2026-07-15" },
        scopeSummary: { summary: "Updated lead description" },
      },
    });

    expect(patch).toEqual({
      projectTypeId: "new-type",
      bidDueDate: "2026-07-15",
      description: "Updated lead description",
    });
  });

  it("only sends opportunity-owned section data to scoping autosave for converted deals", () => {
    expect(
      buildScopingAutosavePatch({
        hasSourceLead: true,
        projectTypeId: "new-type",
        sectionData: {
          projectOverview: { bidDueDate: "2026-07-15" },
          scopeSummary: { summary: "Updated lead description" },
          opportunity: { siteVisitDecision: "not_required" },
        },
      })
    ).toEqual({
      sectionData: {
        opportunity: { siteVisitDecision: "not_required" },
      },
    });
  });

  it("waits for resolved lineage fields before autosaving converted deals", () => {
    expect(
      canAutosaveScopingWorkspace({
        hasSourceLead: true,
        resolvedFields: null,
      })
    ).toBe(false);

    expect(
      canAutosaveScopingWorkspace({
        hasSourceLead: true,
        resolvedFields: makeResolved(),
      })
    ).toBe(true);

    expect(
      canAutosaveScopingWorkspace({
        hasSourceLead: false,
        resolvedFields: null,
      })
    ).toBe(true);
  });
});

describe("DealScopingWorkspace load failures", () => {
  it("renders the editable scope form when the initial scoping intake request fails", async () => {
    mocks.getDealScopingIntake.mockRejectedValueOnce(
      new Error("projectType cannot be cleared after Opportunity")
    );

    const { container, cleanup } = await renderWorkspace(
      makeDeal({
        sourceLeadId: null,
        projectTypeId: null,
      })
    );

    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Scoping Workspace"));
      expect(container.textContent).toContain("projectType cannot be cleared after Opportunity");
      expect(container.textContent).toContain("Project Type");
      expect(container.textContent).toContain("Scope Summary");
    } finally {
      cleanup();
    }
  });
});
