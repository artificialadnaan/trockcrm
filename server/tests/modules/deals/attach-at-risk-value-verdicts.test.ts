import { describe, expect, it } from "vitest";
import { attachAtRiskResult } from "../../../src/modules/deals/service.js";

/**
 * attachAtRiskResult also returns the canonical VALUE verdicts — effectiveOnHold / effectiveValue /
 * displayStageSlug — so non-web clients read one authoritative number instead of re-deriving the hold
 * rule (stored flag OR a close target >90 CT-days out, terminal-exempt on both the CRM and Bid Board
 * slugs, resolved against the America/Chicago calendar day).
 *
 * These pin the thing that was WRONG: those verdicts must be computed from the RESOLVED stage, the same
 * one at-risk uses, not from whatever `stageSlug` happens to be on the row.
 *
 * The board is why it matters. getDealsForPipeline selects card rows as `...getTableColumns(deals)` with
 * no pipeline_stage_config join, so they carry NO stageSlug; the authoritative slug arrives as
 * `fallbackStageSlug` and is stamped onto the card only AFTER this helper returns. Computing the verdicts
 * from the raw row therefore saw a null stage — which silently breaks the bucket == sum-of-cards
 * invariant that the surrounding code already documents for the client-side resolvers.
 */

const dayMs = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * dayMs).toISOString().slice(0, 10);

/** A board-shaped row: no stageSlug, exactly as getDealsForPipeline selects it. */
function boardRow(overrides: Record<string, unknown> = {}) {
  return {
    stageId: "stage-uuid",
    workflowRoute: "normal" as const,
    stageEnteredAt: new Date(Date.now() - 3 * dayMs).toISOString(),
    onHold: false,
    ddEstimate: "120000.00",
    bidEstimate: "90000.00",
    awardedAmount: null,
    bidBoardTotalSales: null,
    expectedCloseDate: null,
    ...overrides,
  };
}

describe("value verdicts use the resolved stage, not the raw row", () => {
  it("applies the estimating DD-over-bid order using fallbackStageSlug", () => {
    // With a null stage this falls to the default bid-first chain and returns 90,000 — disagreeing with
    // the stage-aware column total computed from the same rows.
    const attached = attachAtRiskResult(boardRow(), "rep", "estimating");
    expect(attached.effectiveValue).toBe(120000);
  });

  it("still prefers bid on a non-estimating stage", () => {
    const attached = attachAtRiskResult(boardRow(), "rep", "opportunity");
    expect(attached.effectiveValue).toBe(90000);
  });

  it("exempts a TERMINAL stage from the far-future auto-park", () => {
    // A won deal can be closed early with its forecast date left far out. Its value is realized, not a
    // stale forecast to zero — but with a null stage the exemption never fires and the card reads $0.
    const attached = attachAtRiskResult(
      boardRow({ expectedCloseDate: iso(200), awardedAmount: "250000.00" }),
      "rep",
      "closed_won",
    );
    expect(attached.effectiveOnHold).toBe(false);
    expect(attached.effectiveValue).toBe(250000);
  });

  it("does auto-park an OPEN deal whose close target is far out", () => {
    const attached = attachAtRiskResult(
      boardRow({ expectedCloseDate: iso(200), awardedAmount: "250000.00" }),
      "rep",
      "opportunity",
    );
    expect(attached.effectiveOnHold).toBe(true);
    expect(attached.effectiveValue).toBe(0);
  });

  it("zeroes a stored on-hold deal regardless of stage", () => {
    const attached = attachAtRiskResult(
      boardRow({ onHold: true, awardedAmount: "250000.00" }),
      "rep",
      "opportunity",
    );
    expect(attached.effectiveOnHold).toBe(true);
    expect(attached.effectiveValue).toBe(0);
  });

  it("prefers the row's own stageSlug over the fallback when it has one", () => {
    // The list path DOES join the stage, so the fallback must not override a real value.
    const attached = attachAtRiskResult(
      boardRow({ stageSlug: "estimating" }),
      "rep",
      "opportunity",
    );
    expect(attached.effectiveValue).toBe(120000);
  });

  it("reports a bid-board-aware display stage", () => {
    const attached = attachAtRiskResult(
      boardRow({ bidBoardStageSlug: "estimate_sent_to_client" }),
      "rep",
      "opportunity",
    );
    expect(attached.displayStageSlug).toBe("estimate_sent_to_client");
  });
});
