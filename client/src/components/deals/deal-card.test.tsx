// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AtRiskResult } from "@trock-crm/shared/types";
import { DealCard } from "./deal-card";
import type { Deal } from "@/hooks/use-deals";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
  }),
}));

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
    dealNumber: "TR-2026-0001",
    projectNumber: "DFW-1-12826-aa",
    name: "Palm Villas",
    stageId: "stage-1",
    pipelineDisposition: "deals",
    workflowRoute: "normal",
    assignedRepId: "rep-1",
    companyId: null,
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
    isHubspotSourced: false,
    createdAt: "2026-04-01T10:00:00.000Z",
    updatedAt: "2026-04-15T10:00:00.000Z",
    ...overrides,
  } as Deal;
}

function render(deal: Deal) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <DealCard deal={deal} />
    </MemoryRouter>
  );
}

describe("DealCard", () => {
  it("renders the role-relative at-risk badge when supplied", () => {
    const html = render(makeDeal({ atRisk: makeAtRiskResult() }));

    expect(html).toContain("At Risk");
    expect(html).toContain('data-at-risk-severity="at_risk"');
  });

  it("renders no at-risk badge when the result is absent", () => {
    const html = render(makeDeal());

    expect(html).not.toContain("At Risk");
  });
});
