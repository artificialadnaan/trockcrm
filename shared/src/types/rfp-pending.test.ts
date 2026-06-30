import { describe, expect, it } from "vitest";
import {
  PENDING_RFP_STATUSES,
  pendingRfpSubStateForStatus,
  isPendingRfpDeal,
} from "./rfp-pending.js";

describe("pendingRfpSubStateForStatus", () => {
  it.each([
    ["pending_outbox", "awaiting"],
    ["pending", "awaiting"],
    ["declined", "attention"],
    ["conflict", "attention"],
    ["send_failed", "attention"],
  ] as const)("maps %s -> %s", (status, expected) => {
    expect(pendingRfpSubStateForStatus(status)).toBe(expected);
  });

  it.each([null, undefined, "", "approved", "cancelled_source_ineligible"] as const)(
    "returns null for non-pending status %s",
    (status) => {
      expect(pendingRfpSubStateForStatus(status)).toBeNull();
    },
  );

  it("exposes the full pending set", () => {
    expect([...PENDING_RFP_STATUSES].sort()).toEqual(
      ["conflict", "declined", "pending", "pending_outbox", "send_failed"],
    );
  });
});

describe("isPendingRfpDeal", () => {
  const base = { stageSlug: "opportunity", isBidBoardOwned: false, rfpApprovalStatus: "pending" };
  it("is true for an opportunity deal with a pending status and not bid-board-owned", () => {
    expect(isPendingRfpDeal(base)).toBe(true);
    expect(isPendingRfpDeal({ ...base, rfpApprovalStatus: "declined" })).toBe(true);
  });
  it("is false off-opportunity, bid-board-owned, approved, or no status", () => {
    expect(isPendingRfpDeal({ ...base, stageSlug: "estimating" })).toBe(false);
    expect(isPendingRfpDeal({ ...base, isBidBoardOwned: true })).toBe(false);
    expect(isPendingRfpDeal({ ...base, rfpApprovalStatus: "approved" })).toBe(false);
    expect(isPendingRfpDeal({ ...base, rfpApprovalStatus: null })).toBe(false);
  });
  it("is false when isBidBoardOwned is undefined or null (omitted/unknown flag must not grant eligibility)", () => {
    // Uses strict === false check, so an absent/undefined flag is treated as ineligible.
    expect(isPendingRfpDeal({ stageSlug: "opportunity", isBidBoardOwned: undefined, rfpApprovalStatus: "pending" })).toBe(false);
    expect(isPendingRfpDeal({ stageSlug: "opportunity", isBidBoardOwned: null, rfpApprovalStatus: "pending" })).toBe(false);
  });
});
