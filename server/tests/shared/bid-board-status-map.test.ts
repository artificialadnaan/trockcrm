import { describe, expect, it } from "vitest";

import {
  BID_BOARD_STATUS_TO_CRM_STAGE,
  bidBoardStatusToCrmStage,
  normalizeBidBoardStatus,
} from "@trock-crm/shared/lib/bidBoardStatusMap";

describe("Bid Board status mapping", () => {
  it.each([
    ["Estimate in Progress", "estimating"],
    ["Service - Estimating", "estimating"],
    ["Estimate Under Review", "estimate_under_review"],
    ["Estimate Sent to Client", "estimate_sent_to_client"],
    ["Contract", "contract"],
    ["Won", "won"],
    ["Lost", "lost"],
  ] as const)("maps %s to %s", (status, stage) => {
    expect(bidBoardStatusToCrmStage(status)).toBe(stage);
  });

  it("normalizes whitespace, punctuation, and case before lookup", () => {
    expect(bidBoardStatusToCrmStage("  service   – estimating  ")).toBe("estimating");
    expect(bidBoardStatusToCrmStage("estimate_sent-to client")).toBe("estimate_sent_to_client");
    expect(normalizeBidBoardStatus(" Estimate   Under\tReview ")).toBe("estimate under review");
  });

  it("treats Templates and empty statuses as non-writeback statuses", () => {
    expect(bidBoardStatusToCrmStage("Templates")).toBeNull();
    expect(bidBoardStatusToCrmStage(" ")).toBeNull();
    expect(bidBoardStatusToCrmStage(null)).toBeNull();
  });

  it("does not contain legacy estimate_in_progress as a CRM target", () => {
    expect(Object.values(BID_BOARD_STATUS_TO_CRM_STAGE)).not.toContain("estimate_in_progress");
  });
});
