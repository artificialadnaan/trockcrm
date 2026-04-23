import { describe, expect, it } from "vitest";
import { summarizeTerminalStageCounts } from "./pipeline-page";

describe("summarizeTerminalStageCounts", () => {
  it("aggregates both service and normal terminal outcomes", () => {
    const summary = summarizeTerminalStageCounts([
      {
        stage: { id: "won-normal", name: "Sent to Production", slug: "sent_to_production" },
        deals: [],
        count: 2,
      },
      {
        stage: {
          id: "won-service",
          name: "Service - Sent to Production",
          slug: "service_sent_to_production",
        },
        deals: [],
        count: 3,
      },
      {
        stage: { id: "lost-normal", name: "Production Lost", slug: "production_lost" },
        deals: [],
        count: 1,
      },
      {
        stage: { id: "lost-service", name: "Service - Lost", slug: "service_lost" },
        deals: [],
        count: 4,
      },
    ]);

    expect(summary).toEqual({ won: 5, lost: 5 });
  });
});
