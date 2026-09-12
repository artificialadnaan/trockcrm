// @vitest-environment node
import { describe, expect, it } from "vitest";
import { currentContractValue } from "./deal-utils";

// Current Contract Value = the deal's contract base + every change order. The BASE is the part that
// regressed: it used to read `awardedAmount` alone, so a deal whose value lives anywhere else in the
// awarded-first chain (a Bid-Board-owned deal carrying bid_board_total_sales, say) silently priced its
// contract at $0 and rendered its change orders AS the contract value. These lock the base to the same
// chain resolveBestEstimate uses for every other value surface, so the two can never disagree again.

describe("currentContractValue — the contract base", () => {
  it("uses awardedAmount when it is set (the ordinary Won deal — unchanged)", () => {
    const value = currentContractValue(
      { awardedAmount: "500000", bidBoardTotalSales: "480000", changeOrderTotal: "0" },
      "12500"
    );

    expect(value).toBe(512500);
  });

  it("falls back to bid_board_total_sales when awardedAmount is missing", () => {
    // The Onyx (DFW-1-15426-ab) exactly: Bid-Board-owned, Won, awarded never seeded, and a deductive
    // change order. Before the fix this returned -61828.57 — the CO alone, priced as the contract.
    const value = currentContractValue(
      {
        awardedAmount: null,
        bidBoardTotalSales: "439120.68",
        bidEstimate: "425102.86",
        ddEstimate: "400000.00",
        changeOrderTotal: "0.00",
        stageSlug: "won",
      },
      "-61828.57"
    );

    expect(value).toBeCloseTo(377292.11, 2);
  });

  it("falls back to the bid estimate when neither awarded nor bid-board value is set", () => {
    const value = currentContractValue(
      { awardedAmount: null, bidEstimate: "200000", changeOrderTotal: null, stageSlug: "won" },
      "5000"
    );

    expect(value).toBe(205000);
  });

  it("falls back to the DD estimate as the last candidate in the chain", () => {
    const value = currentContractValue(
      { awardedAmount: null, ddEstimate: "150000", changeOrderTotal: null, stageSlug: "won" },
      null
    );

    expect(value).toBe(150000);
  });

  it("treats a zero awardedAmount as unset, matching the chain's `> 0` gate", () => {
    const value = currentContractValue(
      { awardedAmount: "0", bidBoardTotalSales: "80000", changeOrderTotal: null, stageSlug: "won" },
      null
    );

    expect(value).toBe(80000);
  });

  it("still returns the change orders alone when the deal genuinely has no value anywhere", () => {
    const value = currentContractValue(
      { awardedAmount: null, changeOrderTotal: "1000" },
      "250"
    );

    expect(value).toBe(1250);
  });

  it("prices a change-order child from its own awardedAmount verbatim, never the fallback chain", () => {
    // A CO child carries its value ONLY in awardedAmount and a deductive one is NEGATIVE. Falling
    // through to an inherited bid/DD estimate would price a deduction as positive contract value.
    const value = currentContractValue(
      {
        awardedAmount: "-61828.57",
        bidEstimate: "425102.86",
        ddEstimate: "400000.00",
        changeOrderTotal: null,
        isChangeOrder: true,
      },
      null
    );

    expect(value).toBeCloseTo(-61828.57, 2);
  });

  it("adds the Procore CO rollup and the CRM CO total on top of a fallback base", () => {
    const value = currentContractValue(
      { awardedAmount: null, bidBoardTotalSales: "100000", changeOrderTotal: "7500", stageSlug: "won" },
      "2500"
    );

    expect(value).toBe(110000);
  });
});
