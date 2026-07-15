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
  it("renders a red billing-contact alert for a Won card requiring attention", () => {
    const html = renderDeal(makeDeal({ billingAttentionRequired: true }), "won");

    expect(html).toContain("Billing contact missing");
    expect(html).toContain("bg-red-600");
    expect(html).toContain("border-red-300");
    expect(html).toContain('aria-label="Open deal Palm Villas: billing contact missing"');
  });

  it("does not render billing attention from raw contact state alone", () => {
    const html = renderDeal(makeDeal({ billingContactId: null, billingAttentionRequired: false }), "won");

    expect(html).not.toContain("Billing contact missing");
    expect(html).not.toContain("bg-red-600");
    expect(html).toContain('aria-label="Open deal Palm Villas"');
  });

  it("renders the deal description under the name so cards are identifiable without drilling in", () => {
    const html = renderDeal(makeDeal({ name: "Milo at Mountain Park", description: "Reroof + gutters, 3 buildings" }));

    expect(html).toContain("Reroof + gutters, 3 buildings");
    expect(html).toContain('data-testid="decorated-kanban-card-description"');
    // The name still renders above it.
    expect(html).toContain("Milo at Mountain Park");
  });

  it("omits the description block entirely when the deal has no description", () => {
    const html = renderDeal(makeDeal({ description: null }));

    expect(html).not.toContain('data-testid="decorated-kanban-card-description"');
  });

  it("does not render a description block for a whitespace-only description", () => {
    const html = renderDeal(makeDeal({ description: "   " }));

    expect(html).not.toContain('data-testid="decorated-kanban-card-description"');
  });

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

  it("uses Bid Board stage age for Bid Board-owned deal SLA chips", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));

      const html = renderDeal(
        makeDeal({
          isBidBoardOwned: true,
          stageEnteredAt: "2026-05-10T00:00:00.000Z",
          bidBoardStageEnteredAt: "2026-05-01T00:00:00.000Z",
          atRisk: makeAtRiskResult({
            stageSlug: "estimate_under_review",
            canonicalStageSlug: "estimate_under_review",
            effectiveStageAgeDays: 9,
            thresholdDays: 3,
          }),
        }),
        "estimate_under_review"
      );

      expect(html).toContain("9d / 3d SLA");
      expect(html).not.toContain("0d / 3d SLA");
      expect(html).toContain("At Risk");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps non-Bid-Board-owned deal SLA chips on CRM stage age", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));

      const html = renderDeal(
        makeDeal({
          isBidBoardOwned: false,
          stageEnteredAt: "2026-05-10T00:00:00.000Z",
          bidBoardStageEnteredAt: "2026-05-01T00:00:00.000Z",
        }),
        "estimate_under_review"
      );

      expect(html).toContain("0d / 3d SLA");
      expect(html).not.toContain("9d / 3d SLA");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to CRM stage age when a Bid Board-owned deal has no Bid Board stage timestamp", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));

      const html = renderDeal(
        makeDeal({
          isBidBoardOwned: true,
          stageEnteredAt: "2026-05-10T00:00:00.000Z",
          bidBoardStageEnteredAt: null,
        }),
        "estimate_under_review"
      );

      expect(html).toContain("0d / 3d SLA");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves hold-aware Bid Board stage age for SLA chips", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-10T00:00:00.000Z"));

      const html = renderDeal(
        makeDeal({
          isBidBoardOwned: true,
          stageEnteredAt: "2026-05-10T00:00:00.000Z",
          bidBoardStageEnteredAt: "2026-05-01T00:00:00.000Z",
          onHold: true,
          onHoldStartedAt: "2026-05-06T00:00:00.000Z",
          onHoldAccumulatedSeconds: 0,
          onHoldAccumulatedSecondsAtStageEntry: 0,
        }),
        "estimating"
      );

      expect(html).toContain("5d / 14d SLA");
      expect(html).not.toContain("9d / 14d SLA");
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

  it("flags a change-order child deal with the Change Order badge", () => {
    const html = renderDeal(makeDeal({ isChangeOrder: true, stageId: "stage-won" }), "won");

    expect(html).toContain('data-change-order="true"');
  });

  it("does not flag a regular deal as a change order", () => {
    expect(renderDeal(makeDeal())).not.toContain('data-change-order="true"');
    expect(renderDeal(makeDeal({ isChangeOrder: false }))).not.toContain('data-change-order="true"');
  });

  it("flags an on-hold deal with the On Hold badge", () => {
    const html = renderDeal(makeDeal({ onHold: true }));

    expect(html).toContain('data-on-hold="true"');
    expect(html).toContain("On Hold");
  });

  it("does not flag a non-held deal as on hold", () => {
    expect(renderDeal(makeDeal())).not.toContain('data-on-hold="true"');
    expect(renderDeal(makeDeal({ onHold: false }))).not.toContain('data-on-hold="true"');
  });

  it("flags an OPEN deal whose close target is far past the 90-day horizon (auto-park passthrough)", () => {
    // the card computes the won-aware effective-hold and forwards it to the badge; a far-out OPEN deal
    // is held even without the stored flag (2099 is unambiguously past the horizon and never ages out)
    const html = renderDeal(makeDeal({ onHold: false, expectedCloseDate: "2099-12-31" }), "opportunity");
    expect(html).toContain('data-on-hold="true"');
    expect(html).toContain("On Hold");
  });

  it("does NOT flag a WON deal with a far-out close target (realized revenue is never auto-parked)", () => {
    // a deal won early can keep a stale far-future forecast date; it must NOT read as held (guards the P1)
    const html = renderDeal(makeDeal({ onHold: false, expectedCloseDate: "2099-12-31" }), "won");
    expect(html).not.toContain('data-on-hold="true"');
  });

  it("lets the authoritative column slug override stale row stageSlug for effective hold", () => {
    const html = renderDeal(
      makeDeal({ stageSlug: "opportunity", onHold: false, expectedCloseDate: "2099-12-31" }),
      "won"
    );

    expect(html).not.toContain('data-on-hold="true"');
  });
});
