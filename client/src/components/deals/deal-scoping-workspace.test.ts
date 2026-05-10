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
  DealScopingReadiness,
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
  PropertySelector: ({ value, disabled }: { value?: string | null; disabled?: boolean }) => (
    React.createElement("button", { type: "button", disabled, "data-testid": "property-selector" }, value ?? "none")
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

function makeReadiness() {
  return {
    status: "draft" as const,
    errors: { sections: {}, attachments: {} },
    completionState: {
      projectOverview: { isComplete: false, missingFields: [], missingAttachments: [] },
      opportunity: { isComplete: false, missingFields: [], missingAttachments: [] },
      propertyDetails: { isComplete: false, missingFields: [], missingAttachments: [] },
      scopeSummary: { isComplete: false, missingFields: [], missingAttachments: [] },
      attachments: { isComplete: false, missingFields: [], missingAttachments: [] },
    },
    requiredSections: [],
    requiredAttachmentKeys: [],
    attachmentRequirements: [],
  };
}

function makeScopingResponse(overrides: {
  intake?: Partial<DealScopingIntake>;
  resolved?: Partial<DealResolvedFields>;
  readiness?: Partial<DealScopingReadiness>;
} = {}) {
  return {
    intake: makeIntake(overrides.intake),
    resolved: makeResolved(overrides.resolved),
    readiness: { ...makeReadiness(), ...overrides.readiness },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function changeTextareaValue(element: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  valueSetter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
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

async function renderWorkspaceHarness(deal: DealDetail) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onDealUpdated = vi.fn();
  const render = async (nextDeal: DealDetail) => {
    await act(async () => {
      root.render(React.createElement(DealScopingWorkspace, { deal: nextDeal, onDealUpdated }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  await render(deal);

  return {
    container,
    onDealUpdated,
    render,
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
  it("disables the scope form and prevents saves when the initial scoping intake request fails", async () => {
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
      expect(container.textContent).toContain("Retry loading scope");
      expect(container.textContent).toContain("Unable to load - retry");
      expect(container.textContent).not.toContain("Saved");

      const summary = container.querySelector<HTMLTextAreaElement>("#scopeSummary");
      expect(summary).not.toBeNull();
      expect(summary?.disabled).toBe(true);

      await act(async () => {
        changeTextareaValue(summary!, "this must not autosave");
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      });

      expect(mocks.patchDealScopingIntake).not.toHaveBeenCalled();
      expect(mocks.patchResolvedDealFields).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("retries a failed initial load, enables editing after hydration, and autosaves later edits", async () => {
    mocks.getDealScopingIntake
      .mockRejectedValueOnce(new Error("temporary load failure"))
      .mockResolvedValueOnce(makeScopingResponse({
        intake: { projectTypeId: "project-type-1" },
        resolved: { projectTypeId: "project-type-1" },
      }));
    mocks.patchDealScopingIntake.mockResolvedValue(makeScopingResponse({
      intake: {
        projectTypeId: "project-type-1",
        sectionData: { scopeSummary: { summary: "retry saved value" } },
      },
      resolved: { projectTypeId: "project-type-1" },
    }));

    const { container, cleanup } = await renderWorkspace(
      makeDeal({
        sourceLeadId: null,
        projectTypeId: "project-type-1",
      })
    );

    try {
      await vi.waitFor(() => expect(container.textContent).toContain("temporary load failure"));
      const disabledSummary = container.querySelector<HTMLTextAreaElement>("#scopeSummary");
      expect(disabledSummary?.disabled).toBe(true);

      const retryButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Retry loading scope")
      );
      expect(retryButton).toBeDefined();

      await act(async () => {
        retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      await vi.waitFor(() => {
        const summary = container.querySelector<HTMLTextAreaElement>("#scopeSummary");
        expect(summary?.disabled).toBe(false);
      });

      const summary = container.querySelector<HTMLTextAreaElement>("#scopeSummary")!;
      await act(async () => {
        changeTextareaValue(summary, "retry saved value");
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      });

      await vi.waitFor(() => expect(mocks.patchDealScopingIntake).toHaveBeenCalled());
    } finally {
      cleanup();
    }
  });

  it("re-shows the error banner when a new autosave error occurs after dismissal", async () => {
    mocks.getDealScopingIntake.mockResolvedValueOnce(makeScopingResponse({
      intake: { projectTypeId: "project-type-1" },
      resolved: { projectTypeId: "project-type-1" },
    }));
    mocks.patchDealScopingIntake
      .mockRejectedValueOnce(new Error("first autosave failure"))
      .mockRejectedValueOnce(new Error("second autosave failure"));

    const { container, cleanup } = await renderWorkspace(
      makeDeal({
        sourceLeadId: null,
        projectTypeId: "project-type-1",
      })
    );

    try {
      await vi.waitFor(() => {
        const summary = container.querySelector<HTMLTextAreaElement>("#scopeSummary");
        expect(summary?.disabled).toBe(false);
      });

      const summary = container.querySelector<HTMLTextAreaElement>("#scopeSummary")!;
      await act(async () => {
        changeTextareaValue(summary, "first edit");
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      });

      await vi.waitFor(() => expect(container.textContent).toContain("first autosave failure"));
      const dismissButton = container.querySelector<HTMLButtonElement>(
        "button[aria-label='Dismiss scoping intake error']"
      );
      expect(dismissButton).not.toBeNull();

      await act(async () => {
        dismissButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(container.textContent).not.toContain("first autosave failure");

      await act(async () => {
        changeTextareaValue(summary, "second edit");
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      });

      await vi.waitFor(() => expect(container.textContent).toContain("second autosave failure"));
    } finally {
      cleanup();
    }
  });

  it("does not display a Saved status when the initial load fails", async () => {
    mocks.getDealScopingIntake.mockRejectedValueOnce(new Error("load failed"));

    const { container, cleanup } = await renderWorkspace(
      makeDeal({
        sourceLeadId: null,
        projectTypeId: null,
      })
    );

    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Unable to load - retry"));
      expect(container.textContent).not.toContain("Saved");
      expect(container.textContent).toContain("Project Type");
      expect(container.textContent).toContain("Scope Summary");
    } finally {
      cleanup();
    }
  });

  it("keeps a retry control available after dismissing the initial load error banner", async () => {
    mocks.getDealScopingIntake
      .mockRejectedValueOnce(new Error("temporary load failure"))
      .mockResolvedValueOnce(makeScopingResponse({
        intake: { projectTypeId: "project-type-1" },
        resolved: { projectTypeId: "project-type-1" },
      }));

    const { container, cleanup } = await renderWorkspace(
      makeDeal({
        sourceLeadId: null,
        projectTypeId: "project-type-1",
      })
    );

    try {
      await vi.waitFor(() => expect(container.textContent).toContain("temporary load failure"));
      const dismissButton = container.querySelector<HTMLButtonElement>(
        "button[aria-label='Dismiss scoping intake error']"
      );
      expect(dismissButton).not.toBeNull();

      await act(async () => {
        dismissButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(container.textContent).not.toContain("temporary load failure");
      const retryButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Retry loading scope")
      );
      expect(retryButton).toBeDefined();

      await act(async () => {
        retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      expect(mocks.getDealScopingIntake).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => {
        const summary = container.querySelector<HTMLTextAreaElement>("#scopeSummary");
        expect(summary?.disabled).toBe(false);
      });
    } finally {
      cleanup();
    }
  });

  it("ignores stale load failures after a newer request has hydrated successfully", async () => {
    const firstLoad = deferred<ReturnType<typeof makeScopingResponse>>();
    const secondLoad = deferred<ReturnType<typeof makeScopingResponse>>();
    mocks.getDealScopingIntake
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise);

    const { container, render, cleanup } = await renderWorkspaceHarness(
      makeDeal({ id: "deal-old", sourceLeadId: null, projectTypeId: "project-type-1" })
    );

    try {
      await act(async () => {
        await render(makeDeal({ id: "deal-new", sourceLeadId: null, projectTypeId: "project-type-1" }));
      });

      await vi.waitFor(() => expect(mocks.getDealScopingIntake).toHaveBeenCalledTimes(2));

      await act(async () => {
        secondLoad.resolve(makeScopingResponse({
          intake: {
            projectTypeId: "project-type-1",
            sectionData: { scopeSummary: { summary: "NEW" } },
          },
          resolved: { projectTypeId: "project-type-1", description: "NEW" },
        }));
        await Promise.resolve();
      });

      await vi.waitFor(() => {
        const summary = container.querySelector<HTMLTextAreaElement>("#scopeSummary");
        expect(summary?.value).toBe("NEW");
        expect(summary?.disabled).toBe(false);
      });

      await act(async () => {
        firstLoad.reject(new Error("stale failure"));
        await Promise.resolve();
      });

      expect(container.textContent).not.toContain("stale failure");
      expect(container.textContent).not.toContain("Unable to load - retry");
      const summary = container.querySelector<HTMLTextAreaElement>("#scopeSummary");
      expect(summary?.disabled).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("ignores stale load successes after a newer request has already rendered newer data", async () => {
    const firstLoad = deferred<ReturnType<typeof makeScopingResponse>>();
    const secondLoad = deferred<ReturnType<typeof makeScopingResponse>>();
    mocks.getDealScopingIntake
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise);

    const { container, render, cleanup } = await renderWorkspaceHarness(
      makeDeal({ id: "deal-old", sourceLeadId: null, projectTypeId: "project-type-1" })
    );

    try {
      await act(async () => {
        await render(makeDeal({ id: "deal-new", sourceLeadId: null, projectTypeId: "project-type-1" }));
      });

      await vi.waitFor(() => expect(mocks.getDealScopingIntake).toHaveBeenCalledTimes(2));

      await act(async () => {
        secondLoad.resolve(makeScopingResponse({
          intake: {
            projectTypeId: "project-type-1",
            sectionData: { scopeSummary: { summary: "NEW" } },
          },
          resolved: { projectTypeId: "project-type-1", description: "NEW" },
        }));
        await Promise.resolve();
      });

      await vi.waitFor(() => {
        const summary = container.querySelector<HTMLTextAreaElement>("#scopeSummary");
        expect(summary?.value).toBe("NEW");
      });

      await act(async () => {
        firstLoad.resolve(makeScopingResponse({
          intake: {
            projectTypeId: "project-type-1",
            sectionData: { scopeSummary: { summary: "OLD" } },
          },
          resolved: { projectTypeId: "project-type-1", description: "OLD" },
        }));
        await Promise.resolve();
      });

      const summary = container.querySelector<HTMLTextAreaElement>("#scopeSummary");
      expect(summary?.value).toBe("NEW");
      expect(container.textContent).not.toContain("OLD");
    } finally {
      cleanup();
    }
  });

  it("keeps the hydrated form editable and autosave-capable after a refresh load fails", async () => {
    mocks.getDealScopingIntake
      .mockResolvedValueOnce(makeScopingResponse({
        intake: { projectTypeId: "project-type-1" },
        resolved: { projectTypeId: "project-type-1", workflowRoute: "service" },
        readiness: { status: "ready" },
      }))
      .mockRejectedValueOnce(new Error("refresh load failed"));
    mocks.activateServiceHandoff.mockResolvedValue({});
    mocks.patchDealScopingIntake.mockResolvedValue(makeScopingResponse({
      intake: {
        projectTypeId: "project-type-1",
        sectionData: { scopeSummary: { summary: "still editable" } },
      },
      resolved: { projectTypeId: "project-type-1", workflowRoute: "service" },
      readiness: { status: "ready" },
    }));

    const { container, cleanup } = await renderWorkspace(
      makeDeal({
        sourceLeadId: null,
        projectTypeId: "project-type-1",
        workflowRoute: "service",
      })
    );

    try {
      await vi.waitFor(() => {
        const summary = container.querySelector<HTMLTextAreaElement>("#scopeSummary");
        expect(summary?.disabled).toBe(false);
      });

      const activateButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Activate Service Handoff")
      );
      expect(activateButton).toBeDefined();

      await act(async () => {
        activateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      await vi.waitFor(() => expect(container.textContent).toContain("refresh load failed"));
      expect(container.textContent).not.toContain("Unable to load - retry");

      const summary = container.querySelector<HTMLTextAreaElement>("#scopeSummary")!;
      expect(summary.disabled).toBe(false);

      await act(async () => {
        changeTextareaValue(summary, "still editable");
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      });

      await vi.waitFor(() => expect(mocks.patchDealScopingIntake).toHaveBeenCalled());
    } finally {
      cleanup();
    }
  });
});
