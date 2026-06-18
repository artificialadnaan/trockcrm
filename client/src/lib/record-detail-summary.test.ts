import { describe, expect, it } from "vitest";
import { buildDealDetailSummary, buildLeadDetailSummary } from "./record-detail-summary";

describe("buildDealDetailSummary", () => {
  it("derives stage age, best value, and freshness context", () => {
    expect(
      buildDealDetailSummary(
        {
          stageEnteredAt: "2026-04-18T12:00:00.000Z",
          updatedAt: "2026-04-21T12:00:00.000Z",
          ddEstimate: null,
          bidEstimate: "450000",
          awardedAmount: null,
          nextStep: "Call procurement",
          assignedRepId: "rep-1",
        },
        new Date("2026-04-22T12:00:00.000Z")
      )
    ).toEqual({
      ageDays: 4,
      freshnessDays: 1,
      bestValue: 450000,
      hasNextStep: true,
      hasOwner: true,
    });
  });

  it("uses awarded_amount before the current bid value (unified awarded-first 2026-06-18)", () => {
    expect(
      buildDealDetailSummary(
        {
          stageEnteredAt: "2026-04-18T12:00:00.000Z",
          updatedAt: "2026-04-21T12:00:00.000Z",
          ddEstimate: "3.00",
          bidEstimate: "16137.14",
          awardedAmount: "2.97",
          nextStep: null,
          assignedRepId: null,
        },
        new Date("2026-04-22T12:00:00.000Z")
      ).bestValue
    ).toBe(2.97);
  });

  it("keeps awarded value for won-stage summaries", () => {
    expect(
      buildDealDetailSummary(
        {
          stageEnteredAt: "2026-04-18T12:00:00.000Z",
          updatedAt: "2026-04-21T12:00:00.000Z",
          stageSlug: "won",
          bidEstimate: "875000",
          awardedAmount: "925000",
        },
        new Date("2026-04-22T12:00:00.000Z")
      ).bestValue
    ).toBe(925000);
  });
});

describe("buildLeadDetailSummary", () => {
  it("derives stage age, freshness, and conversion-state context", () => {
    expect(
      buildLeadDetailSummary(
        {
          stageEnteredAt: "2026-04-19T12:00:00.000Z",
          updatedAt: "2026-04-21T12:00:00.000Z",
          assignedRepId: "rep-1",
          convertedAt: null,
          convertedDealId: null,
          status: "open",
          nextStep: null,
        },
        new Date("2026-04-22T12:00:00.000Z")
      )
    ).toEqual({
      ageDays: 3,
      freshnessDays: 1,
      hasOwner: true,
      isConverted: false,
      hasNextStep: false,
    });
  });
});
