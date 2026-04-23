import { describe, expect, it } from "vitest";
import { buildDealBoardSummary, buildLeadBoardSummary } from "./pipeline-board-summary";
import type { DealBoardResponse } from "@/hooks/use-deals";
import type { LeadBoardResponse } from "@/hooks/use-leads";

const now = new Date("2026-04-22T12:00:00.000Z");

describe("buildDealBoardSummary", () => {
  it("derives managed value, active records, live stages, and average age", () => {
    const board: DealBoardResponse = {
      columns: [
        {
          stage: { id: "stage-est", name: "Estimating", slug: "estimating" },
          count: 2,
          totalValue: 125000,
          cards: [
            {
              id: "deal-1",
              dealNumber: "TR-1001",
              name: "North Tower",
              stageId: "stage-est",
              pipelineDisposition: "deals",
              workflowRoute: "normal",
              isBidBoardOwned: false,
              bidBoardStageSlug: null,
              readOnlySyncedAt: null,
              assignedRepId: "rep-1",
              companyId: null,
              propertyId: null,
              sourceLeadId: null,
              primaryContactId: null,
              ddEstimate: "50000",
              bidEstimate: "125000",
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
              lostReasonId: null,
              lostNotes: null,
              lostCompetitor: null,
              lostAt: null,
              expectedCloseDate: null,
              actualCloseDate: null,
              lastActivityAt: null,
              stageEnteredAt: "2026-04-18T12:00:00.000Z",
              isActive: true,
              hubspotDealId: null,
              createdAt: "2026-04-18T12:00:00.000Z",
              updatedAt: "2026-04-18T12:00:00.000Z",
            },
          ],
        },
        {
          stage: { id: "stage-bid", name: "Bid Sent", slug: "bid_sent" },
          count: 1,
          totalValue: 75000,
          cards: [
            {
              id: "deal-2",
              dealNumber: "TR-1002",
              name: "Victory Park",
              stageId: "stage-bid",
              pipelineDisposition: "deals",
              workflowRoute: "normal",
              isBidBoardOwned: false,
              bidBoardStageSlug: null,
              readOnlySyncedAt: null,
              assignedRepId: "rep-1",
              companyId: null,
              propertyId: null,
              sourceLeadId: null,
              primaryContactId: null,
              ddEstimate: null,
              bidEstimate: "75000",
              awardedAmount: null,
              changeOrderTotal: null,
              description: null,
              propertyAddress: null,
              propertyCity: "Austin",
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
              lostReasonId: null,
              lostNotes: null,
              lostCompetitor: null,
              lostAt: null,
              expectedCloseDate: null,
              actualCloseDate: null,
              lastActivityAt: null,
              stageEnteredAt: "2026-04-20T12:00:00.000Z",
              isActive: true,
              hubspotDealId: null,
              createdAt: "2026-04-20T12:00:00.000Z",
              updatedAt: "2026-04-20T12:00:00.000Z",
            },
          ],
        },
        {
          stage: { id: "stage-empty", name: "Close Out", slug: "close_out" },
          count: 0,
          totalValue: 0,
          cards: [],
        },
      ],
      terminalStages: [],
    };

    expect(buildDealBoardSummary(board, now)).toEqual({
      totalCount: 3,
      liveStageCount: 2,
      totalValue: 200000,
      averageAgeDays: 3,
    });
  });
});

describe("buildLeadBoardSummary", () => {
  it("derives active leads, live stages, average age, and qualified pressure", () => {
    const board: LeadBoardResponse = {
      columns: [
        {
          stage: { id: "stage-new", name: "New", slug: "lead_new" },
          count: 3,
          cards: [
            {
              id: "lead-1",
              name: "Fresh Prospect",
              stageId: "stage-new",
              stageEnteredAt: "2026-04-21T12:00:00.000Z",
              updatedAt: "2026-04-21T12:00:00.000Z",
            },
          ],
        },
        {
          stage: {
            id: "stage-value",
            name: "Pre-Qual Value Assigned",
            slug: "pre_qual_value_assigned",
          },
          count: 2,
          cards: [
            {
              id: "lead-2",
              name: "Qualified Lead",
              stageId: "stage-value",
              stageEnteredAt: "2026-04-18T12:00:00.000Z",
              updatedAt: "2026-04-18T12:00:00.000Z",
            },
          ],
        },
        {
          stage: {
            id: "stage-opportunity",
            name: "Qualified for Opportunity",
            slug: "qualified_for_opportunity",
          },
          count: 1,
          cards: [
            {
              id: "lead-3",
              name: "Opportunity Ready",
              stageId: "stage-opportunity",
              stageEnteredAt: "2026-04-19T12:00:00.000Z",
              updatedAt: "2026-04-19T12:00:00.000Z",
            },
          ],
        },
      ],
      defaultConversionDealStageId: null,
    };

    expect(buildLeadBoardSummary(board, now)).toEqual({
      totalCount: 6,
      liveStageCount: 3,
      averageAgeDays: 3,
      qualifiedPressureCount: 3,
      opportunityCount: 1,
    });
  });
});
