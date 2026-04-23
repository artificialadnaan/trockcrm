import { beforeEach, describe, expect, it, vi } from "vitest";

function createMockTenantDb(rows: any[] = []) {
  const queue = Array.isArray(rows[0]) ? [...(rows as any[][])] : [rows];
  return {
    execute: vi.fn().mockImplementation(async () => ({ rows: queue.shift() ?? [] })),
  } as any;
}

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

  return "";
}

describe("admin data scrub reporting service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns summary, backlog buckets, ownership coverage, and scrub activity rollups", async () => {
    const { getAdminDataScrubOverview } = await import("../../../src/modules/admin/admin-reporting-service.js");
    const tenantDb = createMockTenantDb([
      [{ open_duplicate_contacts: "6", resolved_duplicate_contacts_7d: "3" }],
      [{ deals_missing_region: "2", contacts_missing_company: "5", deals_primary_contact_company_mismatch: "1" }],
      [{ recent_scrub_actions_7d: "9" }],
      [
        {
          user_id: "user-1",
          user_name: "Admin User",
          action_count: "7",
          ownership_edit_count: "4",
          last_action_at: "2026-04-18T01:00:00.000Z",
        },
      ],
      [
        {
          user_id: "user-1",
          user_name: "Admin User",
          duplicate_resolution_count: "2",
          last_resolution_at: "2026-04-18T02:00:00.000Z",
        },
      ],
    ]);

    const result = await getAdminDataScrubOverview(tenantDb);

    expect(result.summary).toEqual({
      openDuplicateContacts: 6,
      resolvedDuplicateContacts7d: 3,
      openOwnershipGaps: 8,
      recentScrubActions7d: 12,
    });
    expect(result.backlogBuckets).toEqual([
      { bucketKey: "duplicate_contacts", label: "Duplicate Contacts", count: 6, linkPath: "/admin/merge-queue" },
      { bucketKey: "ownership_gaps", label: "Ownership Gaps", count: 8, linkPath: "/admin/audit" },
    ]);
    expect(result.ownershipCoverage[0]).toEqual({
      gapKey: "deals_missing_region",
      label: "Deals Missing Region",
      count: 2,
    });
    expect(result.scrubActivityByUser[0]).toMatchObject({
      userId: "user-1",
      userName: "Admin User",
      actionCount: 9,
      ownershipEditCount: 4,
      lastActionAt: "2026-04-18T02:00:00.000Z",
    });
  });

  it("counts ownership edits from deals and contacts only when cleanup fields change", async () => {
    const { getAdminDataScrubOverview } = await import("../../../src/modules/admin/admin-reporting-service.js");
    const tenantDb = createMockTenantDb([[], [], [], [], []]);

    await getAdminDataScrubOverview(tenantDb);

    const activityQuery = extractSqlText(tenantDb.execute.mock.calls[3][0]).toLowerCase();
    expect(activityQuery).toContain("al.table_name in ('deals', 'contacts')");
    expect(activityQuery).toContain("jsonb_object_keys");
    expect(activityQuery).toContain("assigned_rep_id");
    expect(activityQuery).toContain("company_id");
    expect(activityQuery).not.toContain("duplicate_queue");
  });
});
