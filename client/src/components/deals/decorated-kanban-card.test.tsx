// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { DecoratedKanbanCard } from "./decorated-kanban-card";
import type { Deal } from "@/hooks/use-deals";

vi.mock("react-router-dom", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

function makeDeal(overrides: Partial<Deal> = {}): Deal {
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

function render(stageSlug: string, slaDays: number) {
  return renderToStaticMarkup(
    <DecoratedKanbanCard deal={makeDeal()} stageSlug={stageSlug} slaDays={slaDays} onClick={() => {}} />
  );
}

describe("DecoratedKanbanCard", () => {
  it("shows SLA context for active stages", () => {
    const html = render("opportunity", 7);

    expect(html).toContain("SLA");
    expect(html).toContain("/ 7d SLA");
  });

  it("keeps time-in-stage but omits SLA context for terminal stages", () => {
    const html = render("won", 7);

    expect(html).toMatch(/\d+d/);
    expect(html).not.toContain("SLA");
    expect(html).not.toContain("/ 7d");
  });
});
