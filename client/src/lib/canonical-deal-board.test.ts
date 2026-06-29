import { describe, expect, it } from "vitest";
import {
  buildCanonicalDealBoardColumns,
  buildCanonicalDealStageFamilies,
  buildCanonicalDealStageIdFamilies,
} from "./canonical-deal-board";

describe("buildCanonicalDealStageFamilies (canonical-slug-keyed membership the list scope is derived from, Codex #589)", () => {
  it("keys each family by the board's canonical slug and folds Won/Lost ALIASES into the terminal columns", () => {
    const families = buildCanonicalDealStageFamilies([
      { id: "won-canonical", slug: "won" },
      { id: "won-closed", slug: "closed_won" },
      { id: "won-prod", slug: "sent_to_production" },
      { id: "lost-service", slug: "service_lost" },
    ]);
    const won = families.find((family) => family.slug === "won");
    const lost = families.find((family) => family.slug === "lost");
    expect(won?.ids).toEqual(expect.arrayContaining(["won-canonical", "won-closed", "won-prod"]));
    expect(lost?.ids).toEqual(["lost-service"]); // an alias-only Lost column is still keyed "lost"
  });

  it("folds the service estimate-under-review alias into the canonical estimate_under_review column (the recurring under-show case, Codex #589 #1)", () => {
    const families = buildCanonicalDealStageFamilies([
      { id: "eur-standard", slug: "estimate_under_review" },
      { id: "eur-service", slug: "service_estimate_under_review" },
    ]);
    const eur = families.find((family) => family.slug === "estimate_under_review");
    // Selecting canonical "Estimate Under Review" must query BOTH ids so the list == the board column.
    expect(eur?.ids).toEqual(expect.arrayContaining(["eur-standard", "eur-service"]));
  });

  it("groups the route-dependent estimating stages ROUTE-SPECIFICALLY — normal estimating does NOT leak into service_estimating, and vice versa (Codex #589 over-grouping P2)", () => {
    const families = buildCanonicalDealStageFamilies([
      { id: "est-normal", slug: "estimating", workflowFamily: "standard_deal" },
      { id: "est-service", slug: "service_estimating", workflowFamily: "service_deal" },
    ]);
    const normal = families.find((family) => family.slug === "estimating");
    const service = families.find((family) => family.slug === "service_estimating");
    // Each stage maps to ITS OWN route's canonical column only — no cross-pollination (the both-routes
    // grouping put `estimating` in BOTH families → selecting either Estimating column OVER-showed the other).
    expect(normal?.ids).toEqual(["est-normal"]);
    expect(service?.ids).toEqual(["est-service"]);
    expect(normal?.ids).not.toContain("est-service");
    expect(service?.ids).not.toContain("est-normal");
  });
});

describe("buildCanonicalDealStageIdFamilies (explicit stage pick → board column's full membership, Codex #589 P1)", () => {
  it("groups CROSS-slug aliases that normalize to the same canonical column (contract_signed + service_contract_signed → contract)", () => {
    const families = buildCanonicalDealStageIdFamilies([
      { id: "contract-standard", slug: "contract_signed" },
      { id: "contract-service", slug: "service_contract_signed" },
    ]);
    const contractFamily = families.find((ids) => ids.includes("contract-standard"));
    expect(contractFamily).toEqual(expect.arrayContaining(["contract-standard", "contract-service"]));
    expect(contractFamily).toHaveLength(2);
  });

  it("groups all Won aliases into one family and all Lost aliases into another (terminal columns)", () => {
    const families = buildCanonicalDealStageIdFamilies([
      { id: "won-canonical", slug: "won" },
      { id: "won-closed", slug: "closed_won" },
      { id: "won-prod", slug: "sent_to_production" },
      { id: "lost-canonical", slug: "lost" },
      { id: "lost-closed", slug: "closed_lost" },
    ]);
    const wonFamily = families.find((ids) => ids.includes("won-canonical"));
    const lostFamily = families.find((ids) => ids.includes("lost-canonical"));
    expect(wonFamily).toEqual(expect.arrayContaining(["won-canonical", "won-closed", "won-prod"]));
    expect(lostFamily).toEqual(expect.arrayContaining(["lost-canonical", "lost-closed"]));
    expect(wonFamily).not.toContain("lost-canonical"); // Won and Lost are distinct columns
  });
});

describe("buildCanonicalDealBoardColumns", () => {
  it("uses awarded_amount before the current bid value when deriving a missing backend aggregate (unified awarded-first 2026-06-18)", () => {
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: { id: "raw-stage", name: "Raw Stage", slug: "raw_stage", isTerminal: false },
          cards: [
            {
              id: "deal-dfw-shape",
              stageId: "stage-opportunity",
              workflowRoute: "normal",
              bidBoardTotalSales: "16137.14",
              bidEstimate: "16137.14",
              ddEstimate: "3.00",
              awardedAmount: "2.97",
            },
          ],
        },
      ] as any,
      [{ id: "stage-opportunity", name: "Opportunity", slug: "opportunity", isTerminal: false }] as any
    );

    expect(columns.find((column) => column.stage.slug === "opportunity")?.totalValue).toBe(2.97);
  });

  it("excludes on-hold deals when deriving a missing backend aggregate", () => {
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: { id: "raw-stage", name: "Raw Stage", slug: "raw_stage", isTerminal: false },
          cards: [
            {
              id: "deal-active",
              stageId: "stage-opportunity",
              workflowRoute: "normal",
              bidEstimate: "125000",
              ddEstimate: null,
              awardedAmount: null,
              onHold: false,
            },
            {
              id: "deal-on-hold",
              stageId: "stage-opportunity",
              workflowRoute: "normal",
              bidEstimate: "400000",
              ddEstimate: null,
              awardedAmount: null,
              onHold: true,
            },
          ],
        },
      ] as any,
      [{ id: "stage-opportunity", name: "Opportunity", slug: "opportunity", isTerminal: false }] as any
    );

    expect(columns.find((column) => column.stage.slug === "opportunity")?.totalValue).toBe(125000);
  });

  it("uses awarded amount for won fallback totals when backend aggregate is missing", () => {
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: { id: "raw-stage", name: "Raw Stage", slug: "raw_stage", isTerminal: false },
          cards: [
            {
              id: "deal-won-shape",
              stageId: "stage-won",
              workflowRoute: "normal",
              bidEstimate: "875000",
              ddEstimate: "800000",
              awardedAmount: "925000",
            },
          ],
        },
      ] as any,
      [{ id: "stage-won", name: "Won", slug: "won", isTerminal: true }] as any
    );

    expect(columns.find((column) => column.stage.slug === "won")?.totalValue).toBe(925000);
  });

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

  it("derives a raw column route from service cards when stage workflow metadata is missing", () => {
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: {
            id: "service-estimating",
            name: "Estimating",
            slug: "estimating",
          },
          count: 2,
          totalValue: 40_000,
          cards: [
            {
              id: "service-deal-1",
              dealNumber: "TR-100",
              name: "Service fallback route",
              stageId: "service-estimating",
              pipelineDisposition: "deals",
              workflowRoute: "service",
              assignedRepId: "rep-1",
              companyId: null,
              propertyId: null,
              sourceLeadId: null,
              primaryContactId: null,
              ddEstimate: "40000",
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
              isActive: true,
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
          id: "service-estimating",
          name: "Service Estimating",
          slug: "service_estimating",
          workflowFamily: "service_deal",
        },
      ]
    );

    expect(columns.find((column) => column.stage.slug === "service_estimating")).toMatchObject({
      count: 2,
      totalValue: 40_000,
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

  it("returns the canonical Won aggregate unchanged when only a single Won row is present", () => {
    // Sanity check: a single canonical Won row should pass through untouched.
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: {
            id: "stage-won-1",
            name: "Won",
            slug: "won",
            workflowFamily: "standard_deal",
            isActivePipeline: true,
            isTerminal: true,
          },
          count: 294,
          totalValue: 21690316.66,
          cards: [],
        },
      ] as never,
      [
        {
          id: "stage-won-1",
          name: "Won",
          slug: "won",
          workflowFamily: "standard_deal",
          isTerminal: true,
        },
      ]
    );

    expect(columns.find((column) => column.stage.slug === "won")).toMatchObject({
      count: 294,
      totalValue: 21690316.66,
    });
  });

  it("does not triple-count the canonical Won aggregate when the server emits multiple Won-family rows", () => {
    // Repro of the production /deals bug: getDealsForPipeline emits one row per
    // Won-family stage (won, closed_won, sent_to_production), each carrying the
    // SAME inArray(deals.stageId, wonStageIds) aggregate. The client previously
    // summed all three, yielding $65.07M / 882 deals instead of $21.69M / 294.
    const sharedCount = 294;
    const sharedTotal = 21690316.66;
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: {
            id: "stage-won-1",
            name: "Won",
            slug: "won",
            workflowFamily: "standard_deal",
            isActivePipeline: true,
            isTerminal: true,
          },
          count: sharedCount,
          totalValue: sharedTotal,
          cards: [],
        },
        {
          stage: {
            id: "stage-won-2",
            name: "Closed Won",
            slug: "closed_won",
            workflowFamily: "standard_deal",
            isActivePipeline: false,
            isTerminal: true,
          },
          count: sharedCount,
          totalValue: sharedTotal,
          cards: [],
        },
        {
          stage: {
            id: "stage-won-3",
            name: "Sent to Production",
            slug: "sent_to_production",
            workflowFamily: "standard_deal",
            isActivePipeline: false,
            isTerminal: false,
          },
          count: sharedCount,
          totalValue: sharedTotal,
          cards: [],
        },
      ] as never,
      [
        {
          id: "stage-won-1",
          name: "Won",
          slug: "won",
          workflowFamily: "standard_deal",
          isTerminal: true,
        },
      ]
    );

    const wonColumn = columns.find((column) => column.stage.slug === "won");
    expect(wonColumn?.count).toBe(sharedCount);
    expect(wonColumn?.totalValue).toBe(sharedTotal);
    // Guards against regression to the tripled values seen in production.
    expect(wonColumn?.count).not.toBe(sharedCount * 3);
    expect(wonColumn?.totalValue).not.toBe(sharedTotal * 3);
  });

  it("does not quadruple-count the canonical Lost aggregate when the server emits multiple Lost-family rows", () => {
    // Symmetric to the Won bug: Lost-family stages (lost, closed_lost,
    // production_lost, service_lost) each carry the SAME canonical aggregate.
    const sharedCount = 270;
    const sharedTotal = 81450000;
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: {
            id: "stage-lost-1",
            name: "Lost",
            slug: "lost",
            workflowFamily: "standard_deal",
            isActivePipeline: true,
            isTerminal: true,
          },
          count: sharedCount,
          totalValue: sharedTotal,
          cards: [],
        },
        {
          stage: {
            id: "stage-lost-2",
            name: "Closed Lost",
            slug: "closed_lost",
            workflowFamily: "standard_deal",
            isActivePipeline: false,
            isTerminal: true,
          },
          count: sharedCount,
          totalValue: sharedTotal,
          cards: [],
        },
        {
          stage: {
            id: "stage-lost-3",
            name: "Production Lost",
            slug: "production_lost",
            workflowFamily: "standard_deal",
            isActivePipeline: false,
            isTerminal: true,
          },
          count: sharedCount,
          totalValue: sharedTotal,
          cards: [],
        },
        {
          stage: {
            id: "stage-lost-4",
            name: "Service Lost",
            slug: "service_lost",
            workflowFamily: "service_deal",
            isActivePipeline: false,
            isTerminal: true,
          },
          count: sharedCount,
          totalValue: sharedTotal,
          cards: [],
        },
      ] as never,
      [
        {
          id: "stage-lost-1",
          name: "Lost",
          slug: "lost",
          workflowFamily: "standard_deal",
          isTerminal: true,
        },
      ]
    );

    const lostColumn = columns.find((column) => column.stage.slug === "lost");
    expect(lostColumn?.count).toBe(sharedCount);
    expect(lostColumn?.totalValue).toBe(sharedTotal);
    expect(lostColumn?.count).not.toBe(sharedCount * 4);
    expect(lostColumn?.totalValue).not.toBe(sharedTotal * 4);
  });

  it("still sums aliased non-terminal raw columns into a canonical pipeline stage", () => {
    // Non-terminal canonical slugs (e.g. estimating) DO NOT have the
    // duplicate-aggregate problem on the server — each raw stage's aggregate
    // counts distinct deals — so summing across aliases must still work. Here
    // estimating + estimate_in_progress both canonicalize to "estimating" and
    // their counts/values are independent and should sum.
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: {
            id: "stage-est-1",
            name: "Estimating",
            slug: "estimating",
            workflowFamily: "standard_deal",
            isActivePipeline: true,
          },
          count: 7,
          totalValue: 100_000,
          cards: [],
        },
        {
          stage: {
            id: "stage-est-2",
            name: "Estimate In Progress",
            slug: "estimate_in_progress",
            workflowFamily: "standard_deal",
            isActivePipeline: false,
          },
          count: 3,
          totalValue: 45_000,
          cards: [],
        },
      ] as never,
      [
        {
          id: "stage-est-1",
          name: "Estimating",
          slug: "estimating",
          workflowFamily: "standard_deal",
        },
      ]
    );

    expect(columns.find((column) => column.stage.slug === "estimating")).toMatchObject({
      count: 10,
      totalValue: 145_000,
    });
  });

  it("prefers the exact canonical Won row regardless of array order", () => {
    // The "won" row appears last in the array; the picker must still pick it
    // because its slug is exactly "won". Distinct values per row make it
    // unambiguous which row was selected.
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: {
            id: "stage-won-2",
            name: "Closed Won",
            slug: "closed_won",
            workflowFamily: "standard_deal",
            isActivePipeline: true,
            isTerminal: true,
          },
          count: 100,
          totalValue: 100_000,
          cards: [],
        },
        {
          stage: {
            id: "stage-won-3",
            name: "Sent to Production",
            slug: "sent_to_production",
            workflowFamily: "standard_deal",
            isActivePipeline: false,
            isTerminal: false,
          },
          count: 200,
          totalValue: 200_000,
          cards: [],
        },
        {
          stage: {
            id: "stage-won-1",
            name: "Won",
            slug: "won",
            workflowFamily: "standard_deal",
            isActivePipeline: false,
            isTerminal: true,
          },
          count: 294,
          totalValue: 21690316.66,
          cards: [],
        },
      ] as never,
      [
        {
          id: "stage-won-1",
          name: "Won",
          slug: "won",
          workflowFamily: "standard_deal",
          isTerminal: true,
        },
      ]
    );

    expect(columns.find((column) => column.stage.slug === "won")).toMatchObject({
      count: 294,
      totalValue: 21690316.66,
    });
  });

  it("falls back to the isActivePipeline Won row when no exact-slug row is present", () => {
    // Only legacy Won-family rows are emitted; the picker must pick the row
    // marked isActivePipeline === true (not the first row).
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: {
            id: "stage-won-2",
            name: "Closed Won",
            slug: "closed_won",
            workflowFamily: "standard_deal",
            isActivePipeline: false,
            isTerminal: true,
          },
          count: 100,
          totalValue: 100_000,
          cards: [],
        },
        {
          stage: {
            id: "stage-won-3",
            name: "Sent to Production",
            slug: "sent_to_production",
            workflowFamily: "standard_deal",
            isActivePipeline: true,
            isTerminal: false,
          },
          count: 294,
          totalValue: 21690316.66,
          cards: [],
        },
        {
          stage: {
            id: "stage-won-4",
            name: "Service Complete",
            slug: "service_complete",
            workflowFamily: "service_deal",
            isActivePipeline: false,
            isTerminal: true,
          },
          count: 50,
          totalValue: 5_000,
          cards: [],
        },
      ] as never,
      [
        {
          id: "stage-won-2",
          name: "Closed Won",
          slug: "closed_won",
          workflowFamily: "standard_deal",
          isTerminal: true,
        },
      ]
    );

    expect(columns.find((column) => column.stage.slug === "won")).toMatchObject({
      count: 294,
      totalValue: 21690316.66,
    });
  });

  it("falls back to the first Won-family row when no exact match and no isActivePipeline row exist", () => {
    // All three legacy rows lack isActivePipeline; the picker must return the
    // first row in the array.
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: {
            id: "stage-won-2",
            name: "Closed Won",
            slug: "closed_won",
            workflowFamily: "standard_deal",
            isActivePipeline: false,
            isTerminal: true,
          },
          count: 111,
          totalValue: 11_111,
          cards: [],
        },
        {
          stage: {
            id: "stage-won-3",
            name: "Sent to Production",
            slug: "sent_to_production",
            workflowFamily: "standard_deal",
            isActivePipeline: false,
            isTerminal: false,
          },
          count: 222,
          totalValue: 22_222,
          cards: [],
        },
        {
          stage: {
            id: "stage-won-4",
            name: "Service Complete",
            slug: "service_complete",
            workflowFamily: "service_deal",
            isActivePipeline: false,
            isTerminal: true,
          },
          count: 333,
          totalValue: 33_333,
          cards: [],
        },
      ] as never,
      [
        {
          id: "stage-won-2",
          name: "Closed Won",
          slug: "closed_won",
          workflowFamily: "standard_deal",
          isTerminal: true,
        },
      ]
    );

    expect(columns.find((column) => column.stage.slug === "won")).toMatchObject({
      count: 111,
      totalValue: 11_111,
    });
  });

  it("renders a deal exactly once when the server emits its card in multiple overlapping Won-family columns", () => {
    // Repro of the production React duplicate-key warnings on /deals:
    // getDealsForPipeline emits one raw column per Won-family stage (won,
    // sent_to_production, ...) and the SAME deal record rides along in more than
    // one of those columns' `cards`. Flattening across raw columns without
    // deduping by id makes the deal land in its canonical column twice, so the
    // board renders two <Card key={deal.id}> with an identical key. Each deal must
    // render exactly once, in its actual current column only.
    const wonDeal = {
      id: "deal-won-dup",
      stageId: "stage-won",
      workflowRoute: "normal",
      bidEstimate: "500000",
      ddEstimate: null,
      awardedAmount: "500000",
    };
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: { id: "stage-won", name: "Won", slug: "won", isTerminal: true },
          cards: [{ ...wonDeal }],
        },
        {
          stage: {
            id: "stage-stp",
            name: "Sent to Production",
            slug: "sent_to_production",
            isTerminal: false,
          },
          cards: [{ ...wonDeal }],
        },
      ] as any,
      [{ id: "stage-won", name: "Won", slug: "won", isTerminal: true }] as any
    );

    // Board-wide: the deal appears exactly once across every column's cards (no
    // duplicate React keys, and it lands in its single current column).
    const renders = columns
      .flatMap((column) => column.cards)
      .filter((deal) => deal.id === "deal-won-dup");
    expect(renders).toHaveLength(1);
    expect(columns.find((column) => column.stage.slug === "won")?.cards).toHaveLength(1);
  });

  it("never renders the same deal id twice within any canonical column", () => {
    // Generalized invariant guarding against duplicate React keys for any family
    // whose cards the server duplicates across overlapping raw columns (Lost too).
    const lostDeal = {
      id: "deal-lost-dup",
      stageId: "stage-lost",
      workflowRoute: "normal",
      bidEstimate: "250000",
      ddEstimate: null,
      awardedAmount: null,
    };
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: { id: "stage-lost", name: "Lost", slug: "lost", isTerminal: true },
          cards: [{ ...lostDeal }],
        },
        {
          stage: {
            id: "stage-closed-lost",
            name: "Closed Lost",
            slug: "closed_lost",
            isTerminal: true,
          },
          cards: [{ ...lostDeal }],
        },
        {
          stage: {
            id: "stage-production-lost",
            name: "Production Lost",
            slug: "production_lost",
            isTerminal: true,
          },
          cards: [{ ...lostDeal }],
        },
      ] as any,
      [{ id: "stage-lost", name: "Lost", slug: "lost", isTerminal: true }] as any
    );

    for (const column of columns) {
      const ids = column.cards.map((deal) => deal.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const renders = columns
      .flatMap((column) => column.cards)
      .filter((deal) => deal.id === "deal-lost-dup");
    expect(renders).toHaveLength(1);
  });

  it("pulls pending-RFP opportunity deals into a synthetic Pending RFP column placed immediately after the opportunity column", () => {
    // p1 is in the opportunity stage with a pending RFP status and is NOT bid-board-owned → should be
    // lifted out of "opportunity" and placed in the synthetic "pending_rfp" column.
    // o1 is a plain opportunity deal (no rfpApprovalStatus) → stays in "opportunity".
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: { id: "opp-stage", name: "Opportunity", slug: "opportunity", isTerminal: false },
          count: 2,
          totalValue: 200000,
          cards: [
            {
              id: "p1",
              stageId: "opp-stage",
              workflowRoute: "normal",
              isBidBoardOwned: false,
              bidBoardStageSlug: null,
              readOnlySyncedAt: null,
              rfpApprovalStatus: "pending",
              bidEstimate: "100000",
              ddEstimate: null,
              awardedAmount: null,
              onHold: false,
            },
            {
              id: "o1",
              stageId: "opp-stage",
              workflowRoute: "normal",
              isBidBoardOwned: false,
              bidBoardStageSlug: null,
              readOnlySyncedAt: null,
              rfpApprovalStatus: null,
              bidEstimate: "100000",
              ddEstimate: null,
              awardedAmount: null,
              onHold: false,
            },
          ],
        },
      ] as any,
      [{ id: "opp-stage", name: "Opportunity", slug: "opportunity", isTerminal: false }] as any
    );

    const oppIndex = columns.findIndex((col) => col.stage.slug === "opportunity");
    const prfpIndex = columns.findIndex((col) => col.stage.slug === "pending_rfp");

    // (a) pending_rfp column exists with the correct name and is immediately after opportunity
    expect(prfpIndex).not.toBe(-1);
    expect(columns[prfpIndex]!.stage.name).toBe("Pending RFP");
    expect(prfpIndex).toBe(oppIndex + 1);

    // (b) p1 is in the pending_rfp column
    expect(columns[prfpIndex]!.cards.map((d) => d.id)).toContain("p1");

    // (c) p1 is NOT in the opportunity column
    expect(columns[oppIndex]!.cards.map((d) => d.id)).not.toContain("p1");

    // (d) o1 IS in the opportunity column
    expect(columns[oppIndex]!.cards.map((d) => d.id)).toContain("o1");

    // (e) opportunity column's count and totalValue EXCLUDE the moved pending deal:
    // original backend aggregate was count=2 / totalValue=200000; one deal (p1, bid=$100k)
    // was moved out, so opportunity should be count=1 / totalValue=100000.
    const preSpitOppCount = 2;
    expect(columns[oppIndex]!.count).toBe(1);
    expect(columns[oppIndex]!.totalValue).toBe(100000);

    // (f) pending_rfp column's count/totalValue match the moved deal's contribution (p1: $100k)
    expect(columns[prfpIndex]!.count).toBe(1);
    expect(columns[prfpIndex]!.totalValue).toBe(100000);

    // (g) the two columns' counts sum to the pre-split opportunity count (no double-counting)
    expect(columns[oppIndex]!.count + columns[prfpIndex]!.count).toBe(preSpitOppCount);
  });

  it("keeps re-confirmed denials in Opportunity and excludes on-hold pending RFPs from the counts", () => {
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: { id: "opp-stage", name: "Opportunity", slug: "opportunity", isTerminal: false },
          count: 1, // backend active count already excludes the on-hold card
          totalValue: 0,
          cards: [
            // re-confirmed denial = resolved terminal → must STAY in opportunity, never pending_rfp
            { id: "rd", stageId: "opp-stage", workflowRoute: "normal", isBidBoardOwned: false, bidBoardStageSlug: null, readOnlySyncedAt: null, rfpApprovalStatus: "declined", rfpOverrideDecision: "denial_reconfirmed", bidEstimate: "50000", ddEstimate: null, awardedAmount: null, onHold: false },
            // on-hold pending RFP → shown in the pending_rfp column but NOT counted (reportable count excludes on-hold)
            { id: "hp", stageId: "opp-stage", workflowRoute: "normal", isBidBoardOwned: false, bidBoardStageSlug: null, readOnlySyncedAt: null, rfpApprovalStatus: "pending", rfpOverrideDecision: null, bidEstimate: "70000", ddEstimate: null, awardedAmount: null, onHold: true },
          ],
        },
      ] as any,
      [{ id: "opp-stage", name: "Opportunity", slug: "opportunity", isTerminal: false }] as any
    );
    const oppIndex = columns.findIndex((col) => col.stage.slug === "opportunity");
    const prfpIndex = columns.findIndex((col) => col.stage.slug === "pending_rfp");

    expect(columns[oppIndex]!.cards.map((d) => d.id)).toContain("rd");
    expect(prfpIndex === -1 ? [] : columns[prfpIndex]!.cards.map((d) => d.id)).not.toContain("rd");
    expect(columns[prfpIndex]!.cards.map((d) => d.id)).toContain("hp");
    expect(columns[prfpIndex]!.count).toBe(0);
    expect(columns[prfpIndex]!.totalValue).toBe(0);
    expect(columns[oppIndex]!.count).toBe(1);
  });

  it("keeps an in-flight override approval (rfpOverrideState='approving') in Opportunity, out of pending_rfp", () => {
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: { id: "opp-stage", name: "Opportunity", slug: "opportunity", isTerminal: false },
          count: 1, // backend active count includes the approving card (it is still in opportunity)
          totalValue: 80000,
          cards: [
            // override approval in flight: status stays "declined" + rfpOverrideState "approving" until the
            // SyncHub callback lands. The server queue/cancel route exclude it, so the board must keep it in
            // Opportunity and NOT surface it as an actionable pending_rfp card.
            { id: "ia", stageId: "opp-stage", workflowRoute: "normal", isBidBoardOwned: false, bidBoardStageSlug: null, readOnlySyncedAt: null, rfpApprovalStatus: "declined", rfpOverrideDecision: null, rfpOverrideState: "approving", bidEstimate: "80000", ddEstimate: null, awardedAmount: null, onHold: false },
          ],
        },
      ] as any,
      [{ id: "opp-stage", name: "Opportunity", slug: "opportunity", isTerminal: false }] as any
    );
    const oppIndex = columns.findIndex((col) => col.stage.slug === "opportunity");
    const prfpIndex = columns.findIndex((col) => col.stage.slug === "pending_rfp");

    // No pending RFP cards → no synthetic column is inserted, and opportunity is untouched.
    expect(prfpIndex).toBe(-1);
    expect(columns[oppIndex]!.cards.map((d) => d.id)).toContain("ia");
    expect(columns[oppIndex]!.count).toBe(1);
    expect(columns[oppIndex]!.totalValue).toBe(80000);
  });

  it("does not carry totalCount on canonical columns, so the visibleCount rollup uses the adjusted active count", () => {
    // buildCanonicalDealBoardColumns rebuilds columns and intentionally omits totalCount (the backend
    // aggregate is dropped), so the Active Pipeline visibleCount rollup falls back to `count`. The split
    // must therefore reconcile on the COUNT axis alone: opp.count + synthetic.count == pre-split active.
    const columns = buildCanonicalDealBoardColumns(
      [
        {
          stage: { id: "opp-stage", name: "Opportunity", slug: "opportunity", isTerminal: false },
          count: 2, // active (non-on-hold): p1 + o1
          totalCount: 4, // backend incl on-hold — must NOT survive onto the canonical column
          totalValue: 170000,
          cards: [
            { id: "p1", stageId: "opp-stage", workflowRoute: "normal", isBidBoardOwned: false, bidBoardStageSlug: null, readOnlySyncedAt: null, rfpApprovalStatus: "pending", rfpOverrideDecision: null, bidEstimate: "100000", ddEstimate: null, awardedAmount: null, onHold: false },
            { id: "p2", stageId: "opp-stage", workflowRoute: "normal", isBidBoardOwned: false, bidBoardStageSlug: null, readOnlySyncedAt: null, rfpApprovalStatus: "pending", rfpOverrideDecision: null, bidEstimate: "50000", ddEstimate: null, awardedAmount: null, onHold: true },
            { id: "o1", stageId: "opp-stage", workflowRoute: "normal", isBidBoardOwned: false, bidBoardStageSlug: null, readOnlySyncedAt: null, rfpApprovalStatus: null, bidEstimate: "70000", ddEstimate: null, awardedAmount: null, onHold: false },
          ],
        },
      ] as any,
      [{ id: "opp-stage", name: "Opportunity", slug: "opportunity", isTerminal: false }] as any
    );
    const oppIndex = columns.findIndex((col) => col.stage.slug === "opportunity");
    const prfpIndex = columns.findIndex((col) => col.stage.slug === "pending_rfp");

    // totalCount is dropped on BOTH columns → the rollup uses `totalCount ?? count` == count.
    expect(columns[oppIndex]!.totalCount).toBeUndefined();
    expect(columns[prfpIndex]!.totalCount).toBeUndefined();
    // Count axis reconciles: opp loses the active pending (2→1), synthetic gets it (1), sum == pre-split.
    expect(columns[oppIndex]!.count).toBe(1);
    expect(columns[prfpIndex]!.count).toBe(1);
    expect(columns[oppIndex]!.count + columns[prfpIndex]!.count).toBe(2);
  });
});
