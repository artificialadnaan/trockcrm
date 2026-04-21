import { describe, expect, it } from "vitest";
import { buildAdminOperationsTiles } from "./admin-dashboard-summary";

describe("buildAdminOperationsTiles", () => {
  it("builds the ordered operations tiles with the expected labels and destinations", () => {
    const tiles = buildAdminOperationsTiles({
      aiActions: { pendingCount: 6, oldestAgeLabel: "12m" },
      interventions: { openCount: 4, oldestAgeLabel: "18m" },
      disconnects: { totalCount: 8, primaryClusterLabel: "handoff" },
      mergeQueue: { openCount: 3, oldestAgeLabel: "27m" },
      migration: { unresolvedCount: 2, oldestAgeLabel: "45m" },
      audit: { changeCount24h: 9, lastActorLabel: "Alex" },
      procore: { conflictCount: 1, healthLabel: "Needs review" },
    });

    expect(tiles.map((item) => item.title).slice(0, 3)).toEqual([
      "AI Actions",
      "Interventions",
      "Process Disconnects",
    ]);
    expect(tiles.map((item) => item.title)).toEqual([
      "AI Actions",
      "Interventions",
      "Process Disconnects",
      "Merge Queue",
      "Migration",
      "Audit Log",
      "Procore Sync",
    ]);
    expect(tiles.find((item) => item.key === "migration")).toEqual(
      expect.objectContaining({
        valueLabel: "2",
        secondaryLabel: "Oldest 45m",
        href: "/admin/migration",
      })
    );
  });
});
