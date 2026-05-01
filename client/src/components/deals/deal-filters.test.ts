import { describe, expect, it } from "vitest";
import { getSelectableDealFilterStages } from "./deal-filters";

describe("getSelectableDealFilterStages", () => {
  it("excludes inactive historical stage aliases from deal filters", () => {
    const stages = [
      { id: "opportunity", name: "Opportunity", slug: "opportunity", isActivePipeline: true },
      { id: "estimating", name: "Estimating", slug: "estimating", isActivePipeline: true },
      {
        id: "estimate-in-progress",
        name: "Estimate in Progress",
        slug: "estimate_in_progress",
        isActivePipeline: false,
      },
      {
        id: "sent-to-production",
        name: "Sent to Production",
        slug: "sent_to_production",
        isActivePipeline: false,
      },
      { id: "won", name: "Won", slug: "won", isActivePipeline: true },
      { id: "lost", name: "Lost", slug: "lost", isActivePipeline: true },
    ];

    expect(getSelectableDealFilterStages(stages).map((stage) => stage.slug)).toEqual([
      "opportunity",
      "estimating",
      "won",
      "lost",
    ]);
  });
});
