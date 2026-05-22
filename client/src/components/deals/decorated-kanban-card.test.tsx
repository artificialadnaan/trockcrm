// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { getOwnerInitialColor, getSlaPolicy, type AtRiskResult } from "@trock-crm/shared/types";
import { DecoratedKanbanCard } from "./decorated-kanban-card";
import type { Deal } from "@/hooks/use-deals";

vi.mock("react-router-dom", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
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
    projectNumber: null,
    name: "Palm Villas",
    stageId: "stage-1",
    pipelineDisposition: "deals",
    workflowRoute: "normal",
    assignedRepId: "rep-1",
    assignedRepName: "Brett Jones",
    companyId: "company-1",
    companyName: "Acme Construction",
    propertyId: null,
    sourceLeadId: null,
    primaryContactId: null,
    ddEstimate: null,
    bidEstimate: "180000",
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

function render(stageSlug: string) {
  return renderToStaticMarkup(
    <DecoratedKanbanCard deal={makeDeal()} stageSlug={stageSlug} onClick={() => {}} />
  );
}

function renderDeal(deal: Deal, stageSlug = "estimating") {
  return renderToStaticMarkup(
    <DecoratedKanbanCard deal={deal} stageSlug={stageSlug} onClick={() => {}} />
  );
}

describe("DecoratedKanbanCard", () => {
  it("shows SLA context for active stages", () => {
    const html = render("opportunity");

    expect(html).toContain("SLA");
    expect(html).toContain("/ 7d SLA");
  });

  it("uses the rep sla-policy threshold for the board-card SLA chip", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-11T10:00:00.000Z"));
      const policy = getSlaPolicy("estimating", "rep");

      const html = render("estimating");

      expect(policy?.thresholdDays).toBe(14);
      expect(html).toContain(`10d / ${policy?.thresholdDays}d SLA`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses hold-aware effective stage age for the board-card SLA chip elapsed days", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-11T10:00:00.000Z"));

      const html = renderDeal(
        makeDeal({
          stageEnteredAt: "2026-04-01T10:00:00.000Z",
          onHold: true,
          onHoldStartedAt: "2026-04-06T10:00:00.000Z",
          onHoldAccumulatedSeconds: 0,
          onHoldAccumulatedSecondsAtStageEntry: 0,
        } as Partial<Deal>),
        "estimating"
      );

      expect(html).toContain("5d / 14d SLA");
      expect(html).not.toContain("10d / 14d SLA");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps time-in-stage but omits SLA context for terminal stages", () => {
    const html = render("won");

    expect(html).toMatch(/\d+d/);
    expect(html).not.toContain("SLA");
    expect(html).not.toContain("/ 7d");
  });

  it("renders the shared at-risk result when the board card receives it", () => {
    const html = renderDeal(makeDeal({ atRisk: makeAtRiskResult() }));

    expect(html).toContain("At Risk");
    expect(html).toContain('data-at-risk-severity="at_risk"');
  });

  it("renders the owner initials badge with the shared owner color utility", () => {
    const expectedColor = getOwnerInitialColor("rep-1");
    const html = renderDeal(makeDeal({ assignedRepId: "rep-1", assignedRepName: "Brett Jones" }));

    expect(html).toContain("BJ");
    expect(html).toContain(`background-color:${expectedColor.backgroundColor}`);
    expect(html).toContain(`color:${expectedColor.textColor}`);
  });

  it("does not render an at-risk badge when the API has not supplied the result", () => {
    const html = renderDeal(makeDeal());

    expect(html).not.toContain("At Risk");
    expect(html).not.toContain("data-at-risk-severity");
  });
});
