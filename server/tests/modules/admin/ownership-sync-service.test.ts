import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it, vi, beforeEach } from "vitest";
import * as publicSchema from "../../../../shared/src/schema/public/index.js";
import * as rootSchema from "../../../../shared/src/schema/index.js";
import { hubspotOwnerMappings } from "../../../../shared/src/schema/public/hubspot-owner-mappings.js";
import { deals } from "../../../../shared/src/schema/tenant/deals.js";
import { leads } from "../../../../shared/src/schema/tenant/leads.js";

const {
  dbExecuteMock,
  fetchAllOwnersMock,
  listActiveUsersWithOfficeAccessMock,
} = vi.hoisted(() => ({
  dbExecuteMock: vi.fn(),
  fetchAllOwnersMock: vi.fn(),
  listActiveUsersWithOfficeAccessMock: vi.fn(),
}));

vi.mock("../../../../server/src/db.js", () => ({
  db: {
    execute: dbExecuteMock,
  },
}));

vi.mock("../../../../server/src/modules/migration/hubspot-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../server/src/modules/migration/hubspot-client.js")>(
    "../../../../server/src/modules/migration/hubspot-client.js"
  );
  return {
    ...actual,
    fetchAllOwners: fetchAllOwnersMock,
  };
});

vi.mock("../../../../server/src/modules/admin/users-service.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../server/src/modules/admin/users-service.js")>(
    "../../../../server/src/modules/admin/users-service.js"
  );
  return {
    ...actual,
    listActiveUsersWithOfficeAccess: listActiveUsersWithOfficeAccessMock,
  };
});

import { runOwnershipSync } from "../../../../server/src/modules/admin/ownership-sync-service.js";
import { normalizeHubSpotOwnerEmail } from "../../../../server/src/modules/migration/hubspot-client.js";

beforeEach(() => {
  dbExecuteMock.mockReset();
  fetchAllOwnersMock.mockReset();
  listActiveUsersWithOfficeAccessMock.mockReset();
});

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

function createExecuteImplementation(options: {
  owners: Array<{ id: string; email?: string | null }>;
  activeUsers: Array<{ id: string; email: string; displayName: string; officeId: string; isActive: boolean }>;
  allUsers: Array<{ id: string; email: string; displayName: string; officeId: string; isActive: boolean }>;
  dealRowsByOwner: Record<string, Array<{ id: string; assignedRepId: string; hubspotOwnerEmail: string | null; ownershipSyncStatus: string | null; unassignedReasonCode: string | null }>>;
  leadRowsByOwner: Record<string, Array<{ id: string; assignedRepId: string; hubspotOwnerEmail: string | null; ownershipSyncStatus: string | null; unassignedReasonCode: string | null }>>;
}) {
  const updateQueries: string[] = [];

  dbExecuteMock.mockImplementation(async (query: unknown) => {
    const text = extractSqlText(query).replace(/\s+/g, " ").trim().toLowerCase();

    if (text.includes("select distinct hubspot_owner_id") && text.includes("from deals")) {
      return { rows: options.owners.map((owner) => ({ hubspot_owner_id: owner.id })) };
    }

    if (text.includes("select distinct hubspot_owner_id") && text.includes("from leads")) {
      return { rows: options.owners.map((owner) => ({ hubspot_owner_id: owner.id })) };
    }

    if (text.includes("from users u") && text.includes("where u.is_active = true")) {
      return {
        rows: options.activeUsers.map((user) => ({
          id: user.id,
          email: user.email,
          display_name: user.displayName,
          office_id: user.officeId,
          is_active: user.isActive,
        })),
      };
    }

    if (text.includes("from users") && !text.includes("where u.is_active = true")) {
      return {
        rows: options.allUsers.map((user) => ({
          id: user.id,
          email: user.email,
          display_name: user.displayName,
          office_id: user.officeId,
          is_active: user.isActive,
        })),
      };
    }

    if (text.includes("from deals") && text.includes("where is_active = true") && text.includes("hubspot_owner_id =")) {
      const ownerId = extractSqlText(query).match(/hubspot_owner_id = ([^ \n]+)/i)?.[1]?.replace(/['"]/g, "");
      return {
        rows: (options.dealRowsByOwner[ownerId ?? ""] ?? []).map((row) => ({
          id: row.id,
          assigned_rep_id: row.assignedRepId,
          hubspot_owner_email: row.hubspotOwnerEmail,
          ownership_sync_status: row.ownershipSyncStatus,
          unassigned_reason_code: row.unassignedReasonCode,
        })),
      };
    }

    if (text.includes("from leads") && text.includes("where is_active = true") && text.includes("hubspot_owner_id =")) {
      const ownerId = extractSqlText(query).match(/hubspot_owner_id = ([^ \n]+)/i)?.[1]?.replace(/['"]/g, "");
      return {
        rows: (options.leadRowsByOwner[ownerId ?? ""] ?? []).map((row) => ({
          id: row.id,
          assigned_rep_id: row.assignedRepId,
          hubspot_owner_email: row.hubspotOwnerEmail,
          ownership_sync_status: row.ownershipSyncStatus,
          unassigned_reason_code: row.unassignedReasonCode,
        })),
      };
    }

    if (text.includes("insert into public.hubspot_owner_mappings")) {
      return { rows: [] };
    }

    if (text.startsWith("update deals") || text.startsWith("update leads")) {
      updateQueries.push(text);
      return { rows: [] };
    }

    return { rows: [] };
  });

  return {
    updateQueries,
  };
}

describe("ownership sync schema contract", () => {
  it("exposes ownership metadata columns on deals, leads, and hubspot owner mappings", () => {
    const dealColumns = getTableColumns(deals);
    const leadColumns = getTableColumns(leads);
    const mappingColumns = getTableColumns(hubspotOwnerMappings);

    expect(dealColumns.hubspotOwnerId.name).toBe("hubspot_owner_id");
    expect(dealColumns.hubspotOwnerEmail.name).toBe("hubspot_owner_email");
    expect(dealColumns.ownershipSyncedAt.name).toBe("ownership_synced_at");
    expect(dealColumns.ownershipSyncStatus.name).toBe("ownership_sync_status");
    expect(dealColumns.unassignedReasonCode.name).toBe("unassigned_reason_code");

    expect(leadColumns.hubspotOwnerId.name).toBe("hubspot_owner_id");
    expect(leadColumns.hubspotOwnerEmail.name).toBe("hubspot_owner_email");
    expect(leadColumns.ownershipSyncedAt.name).toBe("ownership_synced_at");
    expect(leadColumns.ownershipSyncStatus.name).toBe("ownership_sync_status");
    expect(leadColumns.unassignedReasonCode.name).toBe("unassigned_reason_code");

    expect(mappingColumns.hubspotOwnerId.name).toBe("hubspot_owner_id");
    expect(mappingColumns.hubspotOwnerId.isUnique).toBe(true);
    expect(mappingColumns.hubspotOwnerEmail.name).toBe("hubspot_owner_email");
    expect(mappingColumns.userId.name).toBe("user_id");
    expect(mappingColumns.officeId.name).toBe("office_id");
    expect(mappingColumns.mappingStatus.name).toBe("mapping_status");
    expect(mappingColumns.mappingStatus.default).toBe("pending");
    expect(mappingColumns.failureReasonCode.name).toBe("failure_reason_code");
    expect(mappingColumns.lastSeenAt.name).toBe("last_seen_at");
    expect(mappingColumns.updatedAt.name).toBe("updated_at");
    expect(mappingColumns.createdAt.name).toBe("created_at");
  });

  it("re-exports hubspotOwnerMappings from the public and root schema barrels", () => {
    expect(publicSchema.hubspotOwnerMappings).toBe(hubspotOwnerMappings);
    expect(rootSchema.hubspotOwnerMappings).toBe(hubspotOwnerMappings);
  });

  it("includes the Task 1 ownership migration contract in SQL", () => {
    const migrationSql = readFileSync(
      new URL("../../../../migrations/0042_hubspot_ownership_cleanup_phase_1.sql", import.meta.url),
      "utf8"
    );

    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS public.hubspot_owner_mappings");
    expect(migrationSql).toContain("hubspot_owner_id varchar(64) NOT NULL UNIQUE");
    expect(migrationSql).toContain("hubspot_owner_email varchar(320)");
    expect(migrationSql).toContain("mapping_status varchar(32) NOT NULL DEFAULT 'pending'");
    expect(migrationSql).toContain("ALTER TABLE deals");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS hubspot_owner_id varchar(64)");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS ownership_synced_at timestamptz");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS ownership_sync_status varchar(32)");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS unassigned_reason_code varchar(64)");
    expect(migrationSql).toContain("ALTER TABLE leads");
  });
});

describe("ownership sync service", () => {
  it("normalizes HubSpot owner emails", () => {
    expect(normalizeHubSpotOwnerEmail({ id: "owner-1", email: "  Rep@Example.COM " })).toBe("rep@example.com");
    expect(normalizeHubSpotOwnerEmail({ id: "owner-2" })).toBeNull();
  });

  it("counts matched, unmatched, conflict, and unchanged rows on dry run without mutating records", async () => {
    const { updateQueries } = createExecuteImplementation({
      owners: [
        { id: "owner-1", email: "Rep@One.com" },
        { id: "owner-2", email: "inactive@example.com" },
        { id: "owner-3" },
      ],
      activeUsers: [
        { id: "user-1", email: "rep@one.com", displayName: "Rep One", officeId: "office-1", isActive: true },
      ],
      allUsers: [
        { id: "user-1", email: "rep@one.com", displayName: "Rep One", officeId: "office-1", isActive: true },
        { id: "user-2", email: "inactive@example.com", displayName: "Inactive Rep", officeId: "office-2", isActive: false },
      ],
      dealRowsByOwner: {
        "owner-1": [
          {
            id: "deal-1",
            assignedRepId: "user-1",
            hubspotOwnerEmail: "rep@one.com",
            ownershipSyncStatus: "matched",
            unassignedReasonCode: null,
          },
        ],
        "owner-2": [
          {
            id: "deal-2",
            assignedRepId: "user-2",
            hubspotOwnerEmail: "old@example.com",
            ownershipSyncStatus: null,
            unassignedReasonCode: null,
          },
        ],
      },
      leadRowsByOwner: {
        "owner-1": [
          {
            id: "lead-1",
            assignedRepId: "user-old",
            hubspotOwnerEmail: "old@example.com",
            ownershipSyncStatus: null,
            unassignedReasonCode: null,
          },
        ],
        "owner-3": [
          {
            id: "lead-2",
            assignedRepId: "user-old",
            hubspotOwnerEmail: "old@example.com",
            ownershipSyncStatus: null,
            unassignedReasonCode: null,
          },
        ],
      },
    });

    fetchAllOwnersMock.mockResolvedValue([
      { id: "owner-1", email: "Rep@One.com" },
      { id: "owner-2", email: "inactive@example.com" },
      { id: "owner-3" },
    ]);
    listActiveUsersWithOfficeAccessMock.mockResolvedValue([
      { id: "user-1", email: "rep@one.com", displayName: "Rep One", officeId: "office-1", isActive: true },
    ]);

    const result = await runOwnershipSync({ dryRun: true });

    expect(result).toEqual({
      assigned: 1,
      unchanged: 1,
      unmatched: 1,
      conflicts: 1,
      inactiveUserConflicts: 1,
    });
    expect(updateQueries).toHaveLength(0);
  });

  it("applies matched ownership and preserves manual overrides on rerun", async () => {
    const { updateQueries } = createExecuteImplementation({
      owners: [
        { id: "owner-1", email: "rep@one.com" },
        { id: "owner-2" },
      ],
      activeUsers: [
        { id: "user-1", email: "rep@one.com", displayName: "Rep One", officeId: "office-1", isActive: true },
      ],
      allUsers: [
        { id: "user-1", email: "rep@one.com", displayName: "Rep One", officeId: "office-1", isActive: true },
      ],
      dealRowsByOwner: {
        "owner-1": [
          {
            id: "deal-1",
            assignedRepId: "user-old",
            hubspotOwnerEmail: "old@example.com",
            ownershipSyncStatus: null,
            unassignedReasonCode: null,
          },
        ],
        "owner-2": [
          {
            id: "deal-2",
            assignedRepId: "user-old",
            hubspotOwnerEmail: "old@example.com",
            ownershipSyncStatus: null,
            unassignedReasonCode: null,
          },
        ],
      },
      leadRowsByOwner: {
        "owner-1": [
          {
            id: "lead-1",
            assignedRepId: "user-old",
            hubspotOwnerEmail: "old@example.com",
            ownershipSyncStatus: null,
            unassignedReasonCode: null,
          },
          {
            id: "lead-2",
            assignedRepId: "user-manual",
            hubspotOwnerEmail: "old@example.com",
            ownershipSyncStatus: "manual_override",
            unassignedReasonCode: null,
          },
        ],
      },
    });

    fetchAllOwnersMock.mockResolvedValue([
      { id: "owner-1", email: "rep@one.com" },
      { id: "owner-2" },
    ]);
    listActiveUsersWithOfficeAccessMock.mockResolvedValue([
      { id: "user-1", email: "rep@one.com", displayName: "Rep One", officeId: "office-1", isActive: true },
    ]);

    const result = await runOwnershipSync({ dryRun: false });

    expect(result.assigned).toBe(2);
    expect(result.unchanged).toBe(1);
    expect(result.unmatched).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(result.inactiveUserConflicts).toBe(0);
    expect(updateQueries.some((query) => query.includes("update deals"))).toBe(true);
    expect(updateQueries.some((query) => query.includes("update leads") && query.includes("lead-2"))).toBe(false);
  });
});
