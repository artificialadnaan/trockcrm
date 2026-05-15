import { describe, expect, it } from "vitest";
import { buildCanonicalDealBoardColumns } from "./canonical-deal-board";

describe("buildCanonicalDealBoardColumns", () => {
  it("projects legacy and mirrored deal stages into the final canonical dashboard columns", () => {
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: {
            id: "legacy-estimating",
            name: "Estimating",
            slug: "estimating",
            color: null,
            displayOrder: 1,
            isActivePipeline: true,
            isTerminal: false,
          },
          count: 1,
          totalValue: 245000,
          cards: [
            {
              id: "deal-1",
              dealNumber: "TR-001",
              name: "Legacy estimating deal",
              stageId: "legacy-estimating",
              pipelineDisposition: "deals",
              workflowRoute: "normal",
              assignedRepId: "rep-1",
              companyId: null,
              propertyId: null,
              sourceLeadId: null,
              primaryContactId: null,
              ddEstimate: null,
              bidEstimate: "245000",
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
              actualCloseDate: null, contractSignedDate: null,
              lastActivityAt: null,
              stageEnteredAt: "2026-04-23T00:00:00.000Z",
              isActive: true,
              hubspotDealId: null,
              isHubspotSourced: false,
              createdAt: "2026-04-23T00:00:00.000Z",
              updatedAt: "2026-04-23T00:00:00.000Z",
            },
          ],
        },
      ],
      [
        {
          id: "legacy-estimating",
          name: "Estimating",
          slug: "estimating",
          workflowFamily: "standard_deal",
        },
        {
          id: "opportunity-stage",
          name: "Opportunity",
          slug: "opportunity",
          workflowFamily: "standard_deal",
        },
        {
          id: "estimate-in-progress-stage",
          name: "Estimate in Progress",
          slug: "estimate_in_progress",
          workflowFamily: "standard_deal",
          isActivePipeline: false,
        },
        {
          id: "service-estimating-stage",
          name: "Service Estimating",
          slug: "service_estimating",
          workflowFamily: "service_deal",
          isActivePipeline: true,
        },
        {
          id: "estimate-under-review-stage",
          name: "Estimate Under Review",
          slug: "estimate_under_review",
          workflowFamily: "standard_deal",
        },
        {
          id: "estimate-sent-stage",
          name: "Estimate Sent to Client",
          slug: "estimate_sent_to_client",
          workflowFamily: "standard_deal",
        },
        {
          id: "sent-to-production-stage",
          name: "Sent to Production",
          slug: "sent_to_production",
          workflowFamily: "standard_deal",
          isTerminal: false,
          isActivePipeline: false,
        },
        {
          id: "production-lost-stage",
          name: "Production Lost",
          slug: "production_lost",
          workflowFamily: "standard_deal",
          isTerminal: true,
        },
      ]
    );

    expect(columns.map((column) => column.stage.slug)).toEqual([
      "opportunity",
      "estimating",
      "service_estimating",
      "estimate_under_review",
      "estimate_sent_to_client",
      "contract",
      "won",
      "lost",
    ]);

    expect(columns.find((column) => column.stage.slug === "estimating")?.cards.map((deal) => deal.id)).toEqual([
      "deal-1",
    ]);
    expect(columns.find((column) => column.stage.slug === "estimate_in_progress")).toBeUndefined();
    expect(columns.find((column) => column.stage.slug === "sent_to_production")).toBeUndefined();
  });

  it("keeps aggregate counts and totals scoped to the raw column workflow route", () => {
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: {
            id: "normal-estimating",
            name: "Estimating",
            slug: "estimating",
            workflowFamily: "standard_deal",
          },
          count: 10,
          totalValue: 50_000,
          cards: [],
        },
        {
          stage: {
            id: "service-estimating",
            name: "Estimating",
            slug: "estimating",
            workflowFamily: "service_deal",
          },
          count: 5,
          totalValue: 20_000,
          cards: [],
        },
      ] as never,
      [
        {
          id: "normal-estimating",
          name: "Estimating",
          slug: "estimating",
          workflowFamily: "standard_deal",
        },
        {
          id: "service-estimating",
          name: "Service Estimating",
          slug: "service_estimating",
          workflowFamily: "service_deal",
        },
      ]
    );

    expect(columns.find((column) => column.stage.slug === "estimating")).toMatchObject({
      count: 10,
      totalValue: 50_000,
    });
    expect(columns.find((column) => column.stage.slug === "service_estimating")).toMatchObject({
      count: 5,
      totalValue: 20_000,
    });
  });

  it("maps deal_canceled cards into the canonical lost column", () => {
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: {
            id: "deal-canceled-stage",
            name: "Deal Canceled",
            slug: "deal_canceled",
            workflowFamily: "standard_deal",
            isTerminal: true,
          },
          count: 1,
          totalValue: 12_500,
          cards: [
            {
              id: "deal-canceled-1",
              dealNumber: "TR-099",
              name: "Canceled deal",
              stageId: "deal-canceled-stage",
              pipelineDisposition: "deals",
              workflowRoute: "normal",
              assignedRepId: "rep-1",
              companyId: null,
              propertyId: null,
              sourceLeadId: null,
              primaryContactId: null,
              ddEstimate: "12500",
              bidEstimate: null,
              awardedAmount: null,
              changeOrderTotal: null,
              description: null,
              propertyAddress: null,
              propertyCity: null,
              propertyState: null,
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
              actualCloseDate: null, contractSignedDate: null,
              lastActivityAt: null,
              stageEnteredAt: "2026-04-23T00:00:00.000Z",
              isActive: false,
              hubspotDealId: null,
              isHubspotSourced: false,
              createdAt: "2026-04-23T00:00:00.000Z",
              updatedAt: "2026-04-23T00:00:00.000Z",
            },
          ],
        },
      ] as never,
      [
        {
          id: "deal-canceled-stage",
          name: "Deal Canceled",
          slug: "deal_canceled",
          workflowFamily: "standard_deal",
          isTerminal: true,
        },
        {
          id: "lost-stage",
          name: "Lost",
          slug: "lost",
          workflowFamily: "standard_deal",
          isTerminal: true,
        },
      ]
    );

    expect(columns.find((column) => column.stage.slug === "lost")?.cards.map((deal) => deal.id)).toEqual([
      "deal-canceled-1",
    ]);
  });
});
