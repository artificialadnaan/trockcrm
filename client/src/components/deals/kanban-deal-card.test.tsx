// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { AtRiskResult } from "@trock-crm/shared/types";
import { KanbanDealCard, getDealDisplayNumber } from "./kanban-deal-card";
import type { Deal } from "@/hooks/use-deals";

function makeAtRiskResult(overrides: Partial<AtRiskResult> = {}): AtRiskResult {
  return {
    isAtRisk: true,
    status: "at_risk",
    severity: "at_risk",
    reason: "threshold_reached",
    stageSlug: "estimating",
    canonicalStageSlug: "estimating",
    viewerRole: "rep",
    audience: "rep",
    policy: {
      audience: "rep",
      stageSlug: "estimating",
      dayCounting: "calendar_days",
      thresholdDays: 7,
      recurs: true,
      recurrenceDays: 7,
    },
    effectiveStageAgeSeconds: 864_000,
    effectiveStageAgeDays: 10,
    thresholdSeconds: 604_800,
    thresholdDays: 7,
    secondsUntilThreshold: 0,
    secondsPastThreshold: 259_200,
    ...overrides,
  };
}

function makeDeal(overrides: Partial<Deal> & { atRisk?: AtRiskResult | null } = {}): Deal {
  return {
    id: "deal-1",
    dealNumber: "HS-321687989951",
    projectNumber: null,
    name: "Palm Villas",
    stageId: "stage-1",
    pipelineDisposition: "deals",
    workflowRoute: "normal",
    assignedRepId: "rep-1",
    assignedRepName: "Brett",
    companyId: null,
    companyName: null,
    propertyId: null,
    sourceLeadId: null,
    primaryContactId: null,
    ddEstimate: "180000",
    bidEstimate: null,
    awardedAmount: null,
    changeOrderTotal: null,
    description: null,
    propertyAddress: null,
    propertyCity: "Dallas",
    propertyState: "TX",
    propertyZip: null,
    projectTypeId: null,
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
    procoreLastSyncedAt: null,
    isBidBoardOwned: false,
    bidBoardStageSlug: null,
    readOnlySyncedAt: null,
    lostReasonId: null,
    lostNotes: null,
    lostCompetitor: null,
    lostAt: null,
    expectedCloseDate: null,
    actualCloseDate: null,
    contractSignedDate: null,
    lastActivityAt: null,
    stageEnteredAt: "2026-04-01T10:00:00.000Z",
    isActive: true,
    hubspotDealId: null,
    createdAt: "2026-04-01T10:00:00.000Z",
    updatedAt: "2026-04-15T10:00:00.000Z",
    ...overrides,
  } as Deal;
}

function render(deal: Deal) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <KanbanDealCard deal={deal} />
    </MemoryRouter>
  );
}

describe("KanbanDealCard", () => {
  it("shows the project number prominently when set", () => {
    const html = render(makeDeal({ projectNumber: "DFW-1-12826-aa" }));
    expect(html).toContain("DFW-1-12826-aa");
    expect(html).toContain("text-brand-red");
    expect(html).toContain("Palm Villas");
  });

  it("renders 'Pending' with muted styling when project number is null and deal number is HubSpot-imported", () => {
    const html = render(makeDeal({ projectNumber: null, dealNumber: "HS-321687989951" }));
    expect(html).not.toContain("HS-321687989951");
    expect(html).toContain("Pending");
    expect(html).toContain("text-gray-400");
  });

  it("never surfaces the HubSpot ID even when project number is whitespace-only", () => {
    const html = render(makeDeal({ projectNumber: "   ", dealNumber: "HS-321687989951" }));
    expect(html).not.toContain("HS-321687989951");
    expect(html).toContain("Pending");
    expect(html).toContain("text-gray-400");
  });

  it("renders city and days-in-stage meta", () => {
    const html = render(makeDeal({ propertyCity: "Dallas" }));
    expect(html).toContain("Dallas");
    expect(html).toMatch(/\d+d in stage/);
  });

  it("uses Bid Board stage age for Bid Board-owned days-in-stage meta", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));

      const html = render(
        makeDeal({
          isBidBoardOwned: true,
          stageEnteredAt: "2026-05-10T00:00:00.000Z",
          bidBoardStageEnteredAt: "2026-05-01T00:00:00.000Z",
          atRisk: makeAtRiskResult({ effectiveStageAgeDays: 9 }),
        })
      );

      expect(html).toContain("9d in stage");
      expect(html).not.toContain("0d in stage");
      expect(html).toContain("At Risk");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders deal name and currency value", () => {
    const html = render(makeDeal({ name: "Palm Villas", awardedAmount: "250000" }));
    expect(html).toContain("Palm Villas");
    expect(html).toMatch(/\$25\d/);
  });

  it("renders the shared at-risk badge when the pipeline card receives it", () => {
    const html = render(makeDeal({ atRisk: makeAtRiskResult() }));

    expect(html).toContain("At Risk");
    expect(html).toContain('data-at-risk-severity="at_risk"');
  });

  it("does not render an at-risk badge for a not-at-risk result", () => {
    const html = render(makeDeal({
      atRisk: makeAtRiskResult({
        isAtRisk: false,
        status: "not_at_risk",
        severity: "none",
        reason: "within_sla",
      }),
    }));

    expect(html).not.toContain("At Risk");
  });
});

describe("getDealDisplayNumber", () => {
  it("returns project number with isFallback false when set", () => {
    expect(getDealDisplayNumber({ projectNumber: "DFW-1-12826-aa", dealNumber: "HS-321" })).toEqual({
      label: "DFW-1-12826-aa",
      isFallback: false,
      isPending: false,
    });
  });

  it("renders 'Pending' when project number is missing and deal number is HubSpot-imported", () => {
    expect(getDealDisplayNumber({ projectNumber: null, dealNumber: "HS-321" })).toEqual({
      label: "Pending",
      isFallback: true,
      isPending: true,
    });
  });

  it("trims whitespace-only project numbers and hides HS- deal numbers", () => {
    expect(getDealDisplayNumber({ projectNumber: "   ", dealNumber: "HS-321" })).toEqual({
      label: "Pending",
      isFallback: true,
      isPending: true,
    });
  });

  it("renders native deal numbers (non-HS) when project number is missing", () => {
    expect(getDealDisplayNumber({ projectNumber: null, dealNumber: "BB-42" })).toEqual({
      label: "BB-42",
      isFallback: true,
      isPending: false,
    });
  });
});
