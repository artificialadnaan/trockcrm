import { describe, expect, it } from "vitest";
import {
  commissionAckKey,
  evaluateReturnToOpportunityEligibility,
  type ReturnToOpportunityDealState,
} from "./return-to-opportunity.js";

function deal(overrides: Partial<ReturnToOpportunityDealState> = {}): ReturnToOpportunityDealState {
  return {
    stageSlug: "estimating",
    workflowRoute: "normal",
    isActive: true,
    isChangeOrder: false,
    activeChangeOrderCount: 0,
    commissionRowCount: 0,
    commissionTotal: "0",
    effectiveContractSignedDate: null,
    ...overrides,
  };
}

describe("evaluateReturnToOpportunityEligibility — permission tiers", () => {
  it("lets a director move an ordinary pre-Won deal back", () => {
    const result = evaluateReturnToOpportunityEligibility(deal(), "director");
    expect(result.allowed).toBe(true);
    expect(result.voidsCommission).toBe(false);
    expect(result.requiredRole).toBe("director");
  });

  it("lets an admin move an ordinary pre-Won deal back", () => {
    expect(evaluateReturnToOpportunityEligibility(deal(), "admin").allowed).toBe(true);
  });

  it("refuses a rep even on an ordinary deal — this IS a backward move, which reps cannot do", () => {
    const result = evaluateReturnToOpportunityEligibility(deal(), "rep");
    expect(result.allowed).toBe(false);
    expect(result.blockCode).toBe("ROLE_NOT_ALLOWED");
  });

  it("refuses a DIRECTOR on a Won deal — the commission-voiding variant is admin-only", () => {
    const result = evaluateReturnToOpportunityEligibility(
      deal({ stageSlug: "won", commissionRowCount: 2, commissionTotal: "12340.50" }),
      "director"
    );
    expect(result.allowed).toBe(false);
    expect(result.blockCode).toBe("COMMISSION_ROLE_NOT_ALLOWED");
    expect(result.requiredRole).toBe("admin");
    // The amount is still reported so the UI can explain WHY it is refusing.
    expect(result.commissionTotal).toBe("12340.50");
  });

  it("lets an admin move a Won deal back and reports the void", () => {
    const result = evaluateReturnToOpportunityEligibility(
      deal({ stageSlug: "won", commissionRowCount: 2, commissionTotal: "12340.50" }),
      "admin"
    );
    expect(result.allowed).toBe(true);
    expect(result.voidsCommission).toBe(true);
    expect(result.isWonFamily).toBe(true);
    expect(result.commissionRowCount).toBe(2);
  });
});

describe("evaluateReturnToOpportunityEligibility — voidsCommission is broader than 'is Won'", () => {
  it("treats a NON-Won deal carrying commission rows as the destructive variant", () => {
    // A signed deal that the Bid Board moved backward keeps its dsc rows at a pre-Won stage. Keying the
    // gate on the stage alone would let this through the ordinary director tier and silently delete them.
    const result = evaluateReturnToOpportunityEligibility(
      deal({ stageSlug: "contract", commissionRowCount: 1, commissionTotal: "500" }),
      "director"
    );
    expect(result.isWonFamily).toBe(false);
    expect(result.voidsCommission).toBe(true);
    expect(result.blockCode).toBe("COMMISSION_ROLE_NOT_ALLOWED");
  });

  it("treats a NON-Won deal carrying only a contract-signed date as the destructive variant", () => {
    const result = evaluateReturnToOpportunityEligibility(
      deal({ stageSlug: "contract", effectiveContractSignedDate: "2026-03-01" }),
      "director"
    );
    expect(result.voidsCommission).toBe(true);
    expect(result.blockCode).toBe("COMMISSION_ROLE_NOT_ALLOWED");
    expect(evaluateReturnToOpportunityEligibility(
      deal({ stageSlug: "contract", effectiveContractSignedDate: "2026-03-01" }),
      "admin"
    ).allowed).toBe(true);
  });
});

describe("evaluateReturnToOpportunityEligibility — state blocks", () => {
  it("blocks a deal already at Opportunity", () => {
    const result = evaluateReturnToOpportunityEligibility(deal({ stageSlug: "opportunity" }), "admin");
    expect(result.blockCode).toBe("ALREADY_OPPORTUNITY");
  });

  it("blocks the legacy Due Diligence alias, which canonicalizes to Opportunity", () => {
    expect(evaluateReturnToOpportunityEligibility(deal({ stageSlug: "dd" }), "admin").blockCode).toBe(
      "ALREADY_OPPORTUNITY"
    );
  });

  it("blocks a change order itself", () => {
    const result = evaluateReturnToOpportunityEligibility(
      deal({ stageSlug: "won", isChangeOrder: true }),
      "admin"
    );
    expect(result.blockCode).toBe("CHANGE_ORDER");
  });

  it("blocks a parent that still has ACTIVE change-order children", () => {
    const result = evaluateReturnToOpportunityEligibility(
      deal({ stageSlug: "won", activeChangeOrderCount: 2, commissionRowCount: 1, commissionTotal: "10" }),
      "admin"
    );
    expect(result.blockCode).toBe("HAS_CHANGE_ORDERS");
    expect(result.blockReason).toContain("2 change orders");
  });

  it("blocks an archived deal", () => {
    expect(
      evaluateReturnToOpportunityEligibility(deal({ isActive: false }), "admin").blockCode
    ).toBe("DEAL_INACTIVE");
  });
});

describe("evaluateReturnToOpportunityEligibility — service route", () => {
  it("recognises the service Won stage as the destructive variant", () => {
    const result = evaluateReturnToOpportunityEligibility(
      deal({ stageSlug: "service_sent_to_production", workflowRoute: "service" }),
      "admin"
    );
    expect(result.isWonFamily).toBe(true);
    expect(result.voidsCommission).toBe(true);
    expect(result.allowed).toBe(true);
  });

  it("allows an ordinary service-estimating move for a director", () => {
    const result = evaluateReturnToOpportunityEligibility(
      deal({ stageSlug: "service_estimating", workflowRoute: "service" }),
      "director"
    );
    expect(result.allowed).toBe(true);
    expect(result.voidsCommission).toBe(false);
  });
});

describe("commissionAckKey", () => {
  it("collapses every money formatting the dialog could produce to one comparable key", () => {
    expect(commissionAckKey("1200")).toBe("1200.00");
    expect(commissionAckKey("1200.00")).toBe("1200.00");
    expect(commissionAckKey("$1,200.00")).toBe("1200.00");
    expect(commissionAckKey(1200)).toBe("1200.00");
  });

  it("treats absent / unparseable values as zero rather than throwing", () => {
    expect(commissionAckKey(null)).toBe("0");
    expect(commissionAckKey(undefined)).toBe("0");
    expect(commissionAckKey("")).toBe("0");
    expect(commissionAckKey("not money")).toBe("0");
  });

  it("does NOT collapse genuinely different amounts (the stale-dialog guard must still bite)", () => {
    expect(commissionAckKey("1200.00")).not.toBe(commissionAckKey("1200.01"));
  });
});
