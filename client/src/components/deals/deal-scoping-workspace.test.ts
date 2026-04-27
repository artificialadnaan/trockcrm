import { describe, expect, it } from "vitest";

import {
  buildLineageResolvedPatch,
  buildScopingAutosavePatch,
  buildWorkspaceSectionData,
  stripLineageOwnedWorkspaceFields,
} from "./deal-scoping-workspace";
import type {
  DealDetail,
  DealResolvedFields,
  DealScopingIntake,
} from "@/hooks/use-deals";

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
});
