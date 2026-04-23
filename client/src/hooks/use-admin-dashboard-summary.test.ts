import { describe, expect, it } from "vitest";
import { buildAdminOperationsTiles } from "@/lib/admin-dashboard-summary";

describe("buildAdminOperationsTiles", () => {
  it("maps the admin dashboard payload into the required first-iteration module tiles", () => {
    const tiles = buildAdminOperationsTiles({
      aiActions: { pendingCount: 4, oldestAgeLabel: "14m" },
      interventions: { openCount: 3, oldestAgeLabel: "22m" },
      disconnects: { totalCount: 2, primaryClusterLabel: "execution_stall" },
      mergeQueue: { openCount: 1, oldestAgeLabel: "9m" },
      migration: { unresolvedCount: 0, oldestAgeLabel: "0m" },
      audit: { changeCount24h: 12, lastActorLabel: "Alice" },
      procore: { conflictCount: 0, healthLabel: "Healthy" },
    });

    expect(tiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "ai-actions", href: "/admin/ai-actions", secondaryLabel: "Oldest 14m" }),
        expect.objectContaining({ key: "procore", href: "/admin/procore", secondaryLabel: "Healthy" }),
      ])
    );
  });
});
