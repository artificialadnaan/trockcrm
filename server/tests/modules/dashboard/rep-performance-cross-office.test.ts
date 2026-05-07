import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: {},
}));

const getMyCleanupQueueMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/modules/admin/cleanup-queue-service.js", () => ({
  getMyCleanupQueue: getMyCleanupQueueMock,
}));

vi.mock("../../../src/modules/migration/service.js", () => ({
  getMigrationSummary: vi.fn(),
}));

function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }

  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }

  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }

  return "";
}

function snapshotRow(repId: string, repName: string) {
  return {
    rep_id: repId,
    rep_name: repName,
    period_kind: "mtd",
    period_start: "2026-05-01",
    period_end: "2026-05-07",
    pipeline_value: "1000",
    closed_value: "500",
    deals_count: "1",
    wins_count: "1",
    losses_count: "0",
    win_rate: "100",
    avg_days_to_close: "10",
    at_risk_count: "0",
    activity_total: "3",
    calls: "1",
    emails: "1",
    meetings: "1",
    notes: "0",
    sparkline_8w: [],
    region: null,
    computed_at: "2026-05-07T12:00:00.000Z",
    previous_pipeline_value: null,
    previous_closed_value: null,
    previous_deals_count: null,
    previous_wins_count: null,
    previous_losses_count: null,
    previous_win_rate: null,
    previous_avg_days_to_close: null,
    previous_at_risk_count: null,
    previous_activity_total: null,
    previous_calls: null,
    previous_emails: null,
    previous_meetings: null,
    previous_notes: null,
  };
}

describe("rep performance cross-office scoping", () => {
  it("filters snapshots to reps in the active office", async () => {
    const { getRepPerformanceSnapshots } = await import("../../../src/modules/dashboard/service.js");
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [snapshotRow("rep-a1", "Office A Rep 1"), snapshotRow("rep-a2", "Office A Rep 2")],
        })
        .mockResolvedValueOnce({
          rows: [snapshotRow("rep-b1", "Office B Rep 1"), snapshotRow("rep-b2", "Office B Rep 2")],
        }),
    } as any;

    const officeA = await getRepPerformanceSnapshots(tenantDb, "office-a", "mtd");
    const officeB = await getRepPerformanceSnapshots(tenantDb, "office-b", "mtd");

    const firstQueryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    const secondQueryText = extractSqlText(tenantDb.execute.mock.calls[1][0]).toLowerCase();

    expect(firstQueryText).toContain("join public.users u");
    expect(firstQueryText).toContain("u.office_id =");
    expect(secondQueryText).toContain("u.office_id =");
    expect(officeA.rows.map((row) => row.repId)).toEqual(["rep-a1", "rep-a2"]);
    expect(officeB.rows.map((row) => row.repId)).toEqual(["rep-b1", "rep-b2"]);
  });
});
