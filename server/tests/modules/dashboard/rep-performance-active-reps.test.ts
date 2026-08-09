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

describe("rep performance active rep filtering", () => {
  it("filters current snapshots to active users in the query", async () => {
    const { getRepPerformanceSnapshots } = await import("../../../src/modules/dashboard/service.js");
    const tenantDb = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as any;

    await getRepPerformanceSnapshots(tenantDb, "office-1", "mtd");

    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(queryText).toContain("join public.users u");
    expect(queryText).toContain("u.id = rps.rep_id");
    expect(queryText).toContain("u.is_active = true");
    expect(queryText).toContain("u.office_id =");
    expect(queryText).not.toContain("left join public.users u on u.id = current.rep_id");
  });

  it("applies the roster flag WITH its owner-backed exception, matching the cards and funnel", async () => {
    // The cards and the funnel (dashboardRosterMembershipSql) deliberately RETAIN anyone who owns a deal
    // in this office whatever the flag says. Activity Pulse, strategic alerts and the coaching prompts
    // are all built from these snapshot rows, so a bare `generates_sales = true` here would go quiet for
    // exactly the people the cards still show — cross-panel drift on one screen, which is the failure the
    // shared predicate exists to prevent.
    const { getRepPerformanceSnapshots } = await import("../../../src/modules/dashboard/service.js");
    const tenantDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) } as any;

    await getRepPerformanceSnapshots(tenantDb, "office-1", "mtd");
    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();

    expect(queryText).toContain("u.generates_sales = true");
    expect(queryText).toContain("select 1 from deals d where d.assigned_rep_id = u.id");
  });
});
