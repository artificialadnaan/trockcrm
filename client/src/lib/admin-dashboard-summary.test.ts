import { describe, expect, it } from "vitest";
import { buildAdminDashboardSummary } from "./admin-dashboard-summary";

describe("buildAdminDashboardSummary", () => {
  it("builds source-based admin KPI cards and ordered workspace items", () => {
    const summary = buildAdminDashboardSummary({
      aiActionCount: 6,
      openInterventionCount: 4,
      mergeQueueCount: 3,
      disconnectCount: 8,
      migrationExceptionCount: 2,
      procoreIssueCount: 1,
      unhealthySources: ["procore", "migration"],
      auditChangeCount24h: 9,
      pipelineValue: 240000,
      activeDealCount: 7,
    });

    expect(summary.kpis[0]).toEqual(
      expect.objectContaining({
        label: "Needs attention",
        value: "15",
      })
    );
    expect(summary.kpis[1]).toEqual(
      expect.objectContaining({
        label: "System health",
        value: "2",
      })
    );
    expect(summary.workspaceItems.map((item) => item.label).slice(0, 3)).toEqual([
      "AI Actions",
      "Interventions",
      "Merge Queue",
    ]);
    expect(summary.workspaceItems.map((item) => item.label)).toEqual([
      "AI Actions",
      "Interventions",
      "Merge Queue",
      "Migration",
      "Process Disconnects",
      "Audit Log",
      "Procore Sync",
    ]);
  });

  it("marks unavailable operational signals instead of rendering fake zero states", () => {
    const summary = buildAdminDashboardSummary({
      aiActionCount: 0,
      openInterventionCount: 0,
      mergeQueueCount: 0,
      disconnectCount: 0,
      migrationExceptionCount: 0,
      procoreIssueCount: null,
      unhealthySources: [],
      unavailableSources: ["audit", "procore"],
      auditChangeCount24h: null,
      pipelineValue: 0,
      activeDealCount: 0,
    });

    expect(summary.kpis[1]).toEqual(
      expect.objectContaining({
        label: "System health",
        value: "2",
        detail: "audit unavailable • procore unavailable",
      })
    );
    expect(summary.kpis[2]).toEqual(
      expect.objectContaining({
        label: "Workspace changes",
        value: "—",
        detail: "Audit signal unavailable",
      })
    );
    expect(summary.workspaceItems.find((item) => item.key === "procore-sync")).toEqual(
      expect.objectContaining({
        value: "—",
        detail: "Procore status unavailable",
      })
    );
  });
});
