import { describe, expect, it } from "vitest";

import { isDealBidBoardHandoff, isDealScopeReadOnlyAfterRfp } from "./deal-scope-lock";

describe("isDealBidBoardHandoff", () => {
  it("detects a Bid Board handoff via any marker, including a legacy stage slug", () => {
    expect(isDealBidBoardHandoff({ isBidBoardOwned: true })).toBe(true);
    expect(isDealBidBoardHandoff({ bidBoardProjectNumber: "DFW-1-13126-af" })).toBe(true);
    expect(isDealBidBoardHandoff({ bidBoardStageSlug: "estimate_in_progress" })).toBe(true);
  });
  it("is false for a missing deal or a non-Bid-Board signal (e.g. RFP)", () => {
    expect(isDealBidBoardHandoff(null)).toBe(false);
    expect(isDealBidBoardHandoff({ rfpApprovalStatus: "pending" })).toBe(false);
  });
});

describe("isDealScopeReadOnlyAfterRfp", () => {
  it("is false for a new / missing deal", () => {
    expect(isDealScopeReadOnlyAfterRfp(null)).toBe(false);
    expect(isDealScopeReadOnlyAfterRfp(undefined)).toBe(false);
    expect(isDealScopeReadOnlyAfterRfp({})).toBe(false);
  });

  it("locks once an RFP has been submitted", () => {
    expect(isDealScopeReadOnlyAfterRfp({ rfpApprovalStatus: "pending" })).toBe(true);
    expect(isDealScopeReadOnlyAfterRfp({ rfpApprovalRequestedAt: "2026-01-01T00:00:00Z" })).toBe(true);
  });

  it("locks once the deal is handed to the Bid Board / becomes a read-only mirror", () => {
    expect(isDealScopeReadOnlyAfterRfp({ isBidBoardOwned: true })).toBe(true);
    expect(isDealScopeReadOnlyAfterRfp({ bidBoardProjectNumber: "DFW-1-13126-af" })).toBe(true);
    expect(isDealScopeReadOnlyAfterRfp({ bidBoardLinkedAt: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(isDealScopeReadOnlyAfterRfp({ isReadOnlyMirror: true })).toBe(true);
    expect(isDealScopeReadOnlyAfterRfp({ readOnlySyncedAt: "2026-01-01T00:00:00Z" })).toBe(true);
    // Legacy mirror row: the only handoff marker is a Bid Board stage slug (isBidBoardOwned column stale/false).
    expect(isDealScopeReadOnlyAfterRfp({ bidBoardStageSlug: "estimate_in_progress", isBidBoardOwned: false })).toBe(true);
    expect(isDealScopeReadOnlyAfterRfp({ bidBoardStageSlug: "estimating" })).toBe(true);
  });

  it("locks when the caller reports the deal is past the Opportunity stage", () => {
    expect(isDealScopeReadOnlyAfterRfp({}, { isPastOpportunityStage: true })).toBe(true);
  });

  it("stays editable for an active, pre-handoff deal", () => {
    expect(
      isDealScopeReadOnlyAfterRfp({ isBidBoardOwned: false, rfpApprovalStatus: null, bidBoardProjectNumber: null, bidBoardStageSlug: null })
    ).toBe(false);
  });
});
