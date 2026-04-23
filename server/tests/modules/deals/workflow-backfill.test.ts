import { describe, expect, it } from "vitest";
import { planDealWorkflowBackfill } from "../../../src/modules/deals/workflow-backfill.js";

describe("planDealWorkflowBackfill", () => {
  it("keeps already-mirrored downstream deals Bid Board-owned and outside CRM edit flows", () => {
    const history = [
      {
        fromStageId: "stage-opportunity",
        toStageId: "stage-estimating",
        changedAt: new Date("2026-04-10T09:00:00.000Z"),
      },
    ];

    const result = planDealWorkflowBackfill({
      id: "deal-1",
      sourceLeadId: "lead-1",
      bidBoardStageSlug: "bid_sent",
      bidBoardStageEnteredAt: new Date("2026-04-12T10:15:00.000Z"),
      isReadOnlyMirror: true,
      readOnlySyncedAt: new Date("2026-04-12T10:20:00.000Z"),
      stageHistory: history,
      awardedAmount: "98000",
    });

    expect(result.ownershipModel).toBe("bid_board");
    expect(result.isBidBoardOwned).toBe(true);
    expect(result.reopenInCrmEditableFlow).toBe(false);
    expect(result.mirroredStageSlug).toBe("bid_sent");
    expect(result.effectiveStageEnteredAt).toEqual(new Date("2026-04-12T10:15:00.000Z"));
    expect(result.pipelineTypeSnapshot).toBe("normal");
    expect(result.sourceLinkage).toEqual({
      sourceLeadId: "lead-1",
    });
    expect(result.preservedStageHistory).toBe(history);
    expect(result.safetyChecks).toContain("preserve_bid_board_read_only_state");
  });

  it("promotes estimating-boundary legacy deals into Bid Board ownership when the mirror slug already exists", () => {
    const result = planDealWorkflowBackfill({
      id: "deal-2",
      workflowRoute: "service",
      bidBoardStageSlug: "estimating",
      bidBoardMirrorSourceEnteredAt: new Date("2026-04-09T08:00:00.000Z"),
      bidEstimate: "22000",
    });

    expect(result.ownershipModel).toBe("bid_board");
    expect(result.isBidBoardOwned).toBe(true);
    expect(result.reopenInCrmEditableFlow).toBe(false);
    expect(result.mirroredStageSlug).toBe("estimating");
    expect(result.effectiveStageEnteredAt).toEqual(new Date("2026-04-09T08:00:00.000Z"));
    expect(result.pipelineTypeSnapshot).toBe("service");
  });

  it("classifies unsynced legacy deals by value while keeping CRM-owned opportunities editable", () => {
    const result = planDealWorkflowBackfill({
      id: "deal-3",
      stageSlug: "opportunity",
      ddEstimate: "12500",
      sourceLeadId: "lead-3",
    });

    expect(result.ownershipModel).toBe("crm");
    expect(result.isBidBoardOwned).toBe(false);
    expect(result.reopenInCrmEditableFlow).toBe(true);
    expect(result.mirroredStageSlug).toBe(null);
    expect(result.pipelineTypeSnapshot).toBe("service");
    expect(result.safetyChecks).toContain("preserve_source_lead_linkage");
  });

  it("treats downstream legacy stage slugs as Bid Board-owned even when mirror metadata is absent", () => {
    const result = planDealWorkflowBackfill({
      id: "deal-4",
      stageSlug: "in_production",
      stageEnteredAt: new Date("2026-04-14T11:00:00.000Z"),
      awardedAmount: "75000",
    });

    expect(result.ownershipModel).toBe("bid_board");
    expect(result.isBidBoardOwned).toBe(true);
    expect(result.reopenInCrmEditableFlow).toBe(false);
    expect(result.mirroredStageSlug).toBe("in_production");
    expect(result.effectiveStageEnteredAt).toEqual(new Date("2026-04-14T11:00:00.000Z"));
  });
});
