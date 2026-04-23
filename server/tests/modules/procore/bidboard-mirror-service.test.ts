import { describe, expect, it } from "vitest";

import {
  BID_BOARD_MIRROR_OVERRIDE_REASON,
  buildBidBoardMirrorUpdate,
} from "../../../src/modules/procore/bidboard-mirror-service.js";
import { buildReverseStageMap } from "../../../src/modules/procore/stage-mapping.js";

describe("bid board mirror service", () => {
  it("maps downstream SyncHub payloads into mirrored read-only deal fields and stage history", () => {
    const now = new Date("2026-04-22T15:00:00.000Z");

    const result = buildBidBoardMirrorUpdate({
      now,
      deal: {
        id: "deal-1",
        stageId: "stage-estimating",
        stageEnteredAt: new Date("2026-04-20T12:00:00.000Z"),
        workflowRoute: "normal",
        isBidBoardOwned: true,
        proposalStatus: "drafting",
        estimatingSubstage: "building_estimate",
        actualCloseDate: null,
        lostReasonId: null,
        lostNotes: null,
        lostCompetitor: null,
        lostAt: null,
      },
      currentStage: {
        id: "stage-estimating",
        slug: "estimating",
        displayOrder: 2,
      },
      targetStage: {
        id: "stage-bid-sent",
        slug: "bid_sent",
        name: "Bid Sent",
        displayOrder: 3,
        isTerminal: false,
        workflowFamily: "standard_deal",
      },
      payload: {
        stageSlug: "bid_sent",
        stageStatus: "under_review",
        proposalStatus: "under_review",
        stageEnteredAt: "2026-04-22T14:30:00.000Z",
        mirrorSourceEnteredAt: "2026-04-22T14:25:00.000Z",
      },
    });

    expect(result.bypassStageGate).toBe(true);
    expect(result.stageChanged).toBe(true);
    expect(result.updates).toMatchObject({
      stageId: "stage-bid-sent",
      isBidBoardOwned: true,
      bidBoardStageSlug: "bid_sent",
      bidBoardStageFamily: "contract_review",
      bidBoardStageStatus: "under_review",
      proposalStatus: "under_review",
      estimatingSubstage: null,
    });
    expect(result.updates.stageEnteredAt).toEqual(new Date("2026-04-22T14:30:00.000Z"));
    expect(result.updates.bidBoardMirrorSourceEnteredAt).toEqual(
      new Date("2026-04-22T14:25:00.000Z")
    );
    expect(result.history).toMatchObject({
      fromStageId: "stage-estimating",
      toStageId: "stage-bid-sent",
      isBackwardMove: false,
      overrideReason: BID_BOARD_MIRROR_OVERRIDE_REASON,
    });
  });

  it("mirrors terminal loss outcomes from bid board without requiring crm-authored gate flow", () => {
    const now = new Date("2026-04-22T18:00:00.000Z");

    const result = buildBidBoardMirrorUpdate({
      now,
      deal: {
        id: "deal-1",
        stageId: "stage-production",
        stageEnteredAt: new Date("2026-04-21T11:00:00.000Z"),
        workflowRoute: "normal",
        isBidBoardOwned: true,
        proposalStatus: "signed",
        estimatingSubstage: null,
        actualCloseDate: "2026-04-21",
        lostReasonId: null,
        lostNotes: null,
        lostCompetitor: null,
        lostAt: null,
      },
      currentStage: {
        id: "stage-production",
        slug: "in_production",
        displayOrder: 4,
      },
      targetStage: {
        id: "stage-closed-lost",
        slug: "closed_lost",
        name: "Closed Lost",
        displayOrder: 7,
        isTerminal: true,
        workflowFamily: "standard_deal",
      },
      payload: {
        stageSlug: "closed_lost",
        stageFamily: "terminal_loss",
        stageStatus: "lost_to_competitor",
        lossOutcome: "lost_to_competitor",
        lostReasonId: "reason-1",
        lostNotes: "Client stayed with incumbent vendor.",
        lostCompetitor: "Incumbent Roofing",
      },
    });

    expect(result.bypassStageGate).toBe(true);
    expect(result.updates).toMatchObject({
      stageId: "stage-closed-lost",
      bidBoardStageFamily: "terminal_loss",
      bidBoardLossOutcome: "lost_to_competitor",
      lostReasonId: "reason-1",
      lostNotes: "Client stayed with incumbent vendor.",
      lostCompetitor: "Incumbent Roofing",
    });
    expect(result.updates.actualCloseDate).toBeNull();
    expect(result.updates.lostAt).toEqual(now);
    expect(result.history?.overrideReason).toBe(BID_BOARD_MIRROR_OVERRIDE_REASON);
  });

  it("rejects cross-family stage updates so service and normal routes cannot cross", () => {
    expect(() =>
      buildBidBoardMirrorUpdate({
        now: new Date("2026-04-22T18:00:00.000Z"),
        deal: {
          id: "deal-1",
          stageId: "stage-service-estimating",
          stageEnteredAt: new Date("2026-04-21T11:00:00.000Z"),
          workflowRoute: "service",
          isBidBoardOwned: true,
          proposalStatus: null,
          estimatingSubstage: "site_visit",
          actualCloseDate: null,
          lostReasonId: null,
          lostNotes: null,
          lostCompetitor: null,
          lostAt: null,
        },
        targetStage: {
          id: "stage-standard-production",
          slug: "in_production",
          name: "In Production",
          displayOrder: 4,
          isTerminal: false,
          workflowFamily: "standard_deal",
        },
        payload: {
          stageSlug: "in_production",
        },
      })
    ).toThrow("Bid Board mirror stage family mismatch");
  });
});

describe("buildReverseStageMap", () => {
  it("keeps service and standard procore mappings isolated when a workflow family is supplied", async () => {
    const rows = [
      {
        id: "stage-standard-estimating",
        name: "Estimating",
        displayOrder: 2,
        workflowFamily: "standard_deal",
        procoreStageMapping: "Estimating",
      },
      {
        id: "stage-service-estimating",
        name: "Service Estimating",
        displayOrder: 2,
        workflowFamily: "service_deal",
        procoreStageMapping: "Estimating",
      },
    ];

    const tenantDb = {
      select() {
        return {
          from() {
            return {
              where() {
                return Promise.resolve(rows);
              },
            };
          },
        };
      },
    };

    const standardMap = await buildReverseStageMap(tenantDb as never, "standard_deal");
    const serviceMap = await buildReverseStageMap(tenantDb as never, "service_deal");

    expect(standardMap.get("estimating")).toMatchObject({
      stageId: "stage-standard-estimating",
      workflowFamily: "standard_deal",
      ambiguous: false,
    });
    expect(serviceMap.get("estimating")).toMatchObject({
      stageId: "stage-service-estimating",
      workflowFamily: "service_deal",
      ambiguous: false,
    });
  });

  it("requires callers to scope reverse mapping by workflow family", async () => {
    const tenantDb = {
      select() {
        return {
          from() {
            return {
              where() {
                return Promise.resolve([]);
              },
            };
          },
        };
      },
    };

    await expect(buildReverseStageMap(tenantDb as never, undefined as never)).rejects.toThrow(
      "workflowFamily is required"
    );
  });
});
