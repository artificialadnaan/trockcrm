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
  dbTransactionMock,
  fetchAllOwnersMock,
  listActiveUsersWithOfficeAccessMock,
} = vi.hoisted(() => ({
  dbExecuteMock: vi.fn(),
  dbTransactionMock: vi.fn(),
  fetchAllOwnersMock: vi.fn(),
  listActiveUsersWithOfficeAccessMock: vi.fn(),
}));

vi.mock("../../../../server/src/db.js", () => ({
  db: {
    execute: dbExecuteMock,
    transaction: dbTransactionMock,
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
  dbTransactionMock.mockReset();
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
  offices: Array<{ id: string; name: string; slug: string }>;
  owners: Array<{ id: string; email?: string | null }>;
  activeUsers: Array<{ id: string; email: string; displayName: string; officeId: string; isActive: boolean }>;
  allUsers: Array<{ id: string; email: string; displayName: string; officeId: string; isActive: boolean }>;
  dealRowsByOwner: Record<string, Array<{ id: string; assignedRepId: string; hubspotOwnerEmail: string | null; ownershipSyncStatus: string | null; unassignedReasonCode: string | null }>>;
  leadRowsByOwner: Record<string, Array<{ id: string; assignedRepId: string; hubspotOwnerEmail: string | null; ownershipSyncStatus: string | null; unassignedReasonCode: string | null }>>;
  tenantRowsBySchema?: Record<string, {
    dealRowsByOwner: Record<string, Array<{ id: string; assignedRepId: string; hubspotOwnerEmail: string | null; ownershipSyncStatus: string | null; unassignedReasonCode: string | null }>>;
    leadRowsByOwner: Record<string, Array<{ id: string; assignedRepId: string; hubspotOwnerEmail: string | null; ownershipSyncStatus: string | null; unassignedReasonCode: string | null }>>;
  }>;
}) {
  const updateQueries: string[] = [];
  const writeQueries: string[] = [];
  let currentSchema: string | null = null;

  dbTransactionMock.mockImplementation(async (callback: (client: { execute: typeof dbExecuteMock }) => Promise<unknown>) => {
    await callback({ execute: dbExecuteMock });
  });

  dbExecuteMock.mockImplementation(async (query: unknown) => {
    const text = extractSqlText(query).replace(/\s+/g, " ").trim().toLowerCase();

    if (text.includes("set_config('search_path'")) {
      const schemaMatch = extractSqlText(query).match(/office_[a-z0-9_-]+,public/i);
      currentSchema = schemaMatch ? schemaMatch[0].split(",")[0] : null;
      return { rows: [] };
    }

    if (text.includes("from public.offices")) {
      return {
        rows: options.offices.map((office) => ({
          id: office.id,
          name: office.name,
          slug: office.slug,
        })),
      };
    }

    const schemaRows =
      currentSchema && options.tenantRowsBySchema?.[currentSchema]
        ? options.tenantRowsBySchema[currentSchema]
        : undefined;

    if (text.includes("select distinct hubspot_owner_id") && text.includes("from deals")) {
      if (!currentSchema) throw new Error("search_path was not set before tenant query");
      const rowsByOwner = schemaRows?.dealRowsByOwner ?? options.dealRowsByOwner;
      return {
        rows: Object.keys(rowsByOwner).map((ownerId) => ({ hubspot_owner_id: ownerId })),
      };
    }

    if (text.includes("select distinct hubspot_owner_id") && text.includes("from leads")) {
      if (!currentSchema) throw new Error("search_path was not set before tenant query");
      const rowsByOwner = schemaRows?.leadRowsByOwner ?? options.leadRowsByOwner;
      return {
        rows: Object.keys(rowsByOwner).map((ownerId) => ({ hubspot_owner_id: ownerId })),
      };
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
      if (!currentSchema) throw new Error("search_path was not set before tenant query");
      const rowsByOwner = schemaRows?.dealRowsByOwner ?? options.dealRowsByOwner;
      const ownerId = extractSqlText(query).match(/hubspot_owner_id = ([^ \n]+)/i)?.[1]?.replace(/['"]/g, "");
      return {
        rows: (rowsByOwner[ownerId ?? ""] ?? []).map((row) => ({
          id: row.id,
          assigned_rep_id: row.assignedRepId,
          hubspot_owner_email: row.hubspotOwnerEmail,
          ownership_sync_status: row.ownershipSyncStatus,
          unassigned_reason_code: row.unassignedReasonCode,
        })),
      };
    }

    if (text.includes("from leads") && text.includes("where is_active = true") && text.includes("hubspot_owner_id =")) {
      if (!currentSchema) throw new Error("search_path was not set before tenant query");
      const rowsByOwner = schemaRows?.leadRowsByOwner ?? options.leadRowsByOwner;
      const ownerId = extractSqlText(query).match(/hubspot_owner_id = ([^ \n]+)/i)?.[1]?.replace(/['"]/g, "");
      return {
        rows: (rowsByOwner[ownerId ?? ""] ?? []).map((row) => ({
          id: row.id,
          assigned_rep_id: row.assignedRepId,
          hubspot_owner_email: row.hubspotOwnerEmail,
          ownership_sync_status: row.ownershipSyncStatus,
          unassigned_reason_code: row.unassignedReasonCode,
        })),
      };
    }

    if (text.includes("insert into public.hubspot_owner_mappings")) {
      writeQueries.push(text);
      return { rows: [] };
    }

    if (text.startsWith("update deals") || text.startsWith("update leads")) {
      updateQueries.push(text);
      writeQueries.push(text);
      return { rows: [] };
    }

    return { rows: [] };
  });

  return {
    updateQueries,
    writeQueries,
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
    const { updateQueries, writeQueries } = createExecuteImplementation({
      offices: [{ id: "office-1", name: "Office One", slug: "one" }],
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

    expect(result.assigned).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.unmatched).toBe(1);
    expect(result.conflicts).toBe(1);
    expect(result.inactiveUserConflicts).toBe(1);
    expect(result.examples.matched.length).toBeGreaterThan(0);
    expect(result.examples.unmatched.length).toBeGreaterThan(0);
    expect(result.examples.conflicts.length).toBeGreaterThan(0);
    expect(result.examples.inactiveUserConflicts.length).toBeGreaterThan(0);
    expect(result.examples.matched[0]).toMatchObject({
      recordType: "deal",
      recordId: "deal-1",
      ownerId: "owner-1",
      mappingStatus: "matched",
    });
    expect(result.examples.unmatched[0]).toMatchObject({
      recordType: "lead",
      recordId: "lead-2",
      ownerId: "owner-3",
      mappingStatus: "unmatched",
    });
    expect(result.examples.conflicts[0]).toMatchObject({
      ownerId: "owner-2",
      mappingStatus: "conflict",
    });
    expect(result.examples.inactiveUserConflicts[0]).toMatchObject({
      ownerId: "owner-2",
      reasonCode: "inactive_owner_match",
    });
    expect(updateQueries).toHaveLength(0);
    expect(writeQueries).toHaveLength(0);
    expect(dbTransactionMock).toHaveBeenCalledOnce();
  });

  it("wraps apply-mode writes in a database transaction", async () => {
    const transactionCallbacks: Array<(client: { execute: typeof dbExecuteMock }) => Promise<unknown>> = [];
    dbTransactionMock.mockImplementation(async (callback: (client: { execute: typeof dbExecuteMock }) => Promise<unknown>) => {
      transactionCallbacks.push(callback);
      await callback({ execute: dbExecuteMock });
    });

    dbExecuteMock.mockImplementation(async (query: unknown) => {
      const text = extractSqlText(query).replace(/\s+/g, " ").trim().toLowerCase();
      if (text.includes("select distinct hubspot_owner_id")) return { rows: [{ hubspot_owner_id: "owner-1" }] };
      if (text.includes("from users u") && text.includes("where u.is_active = true")) {
        return {
          rows: [{ id: "user-1", email: "rep@one.com", display_name: "Rep One", office_id: "office-1", is_active: true }],
        };
      }
      if (text.includes("from users") && !text.includes("where u.is_active = true")) {
        return {
          rows: [{ id: "user-1", email: "rep@one.com", display_name: "Rep One", office_id: "office-1", is_active: true }],
        };
      }
      if (text.includes("from deals") && text.includes("hubspot_owner_id =")) {
        return {
          rows: [{
            id: "deal-1",
            assigned_rep_id: "user-old",
            hubspot_owner_email: "old@example.com",
            ownership_sync_status: null,
            unassigned_reason_code: null,
          }],
        };
      }
      if (text.includes("from leads") && text.includes("hubspot_owner_id =")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    fetchAllOwnersMock.mockResolvedValue([{ id: "owner-1", email: "rep@one.com" }]);
    listActiveUsersWithOfficeAccessMock.mockResolvedValue([
      { id: "user-1", email: "rep@one.com", displayName: "Rep One", officeId: "office-1", isActive: true },
    ]);

    await runOwnershipSync({ dryRun: false });

    expect(dbTransactionMock).toHaveBeenCalledOnce();
    expect(transactionCallbacks).toHaveLength(1);
    expect(typeof transactionCallbacks[0]).toBe("function");
  });

  it("switches tenant search_path for each active office during dry run", async () => {
    const { writeQueries } = createExecuteImplementation({
      offices: [
        { id: "office-1", name: "Office One", slug: "one" },
        { id: "office-2", name: "Office Two", slug: "two" },
      ],
      owners: [
        { id: "owner-1", email: "rep1@one.com" },
        { id: "owner-2", email: "rep2@two.com" },
      ],
      activeUsers: [
        { id: "user-1", email: "rep1@one.com", displayName: "Rep One", officeId: "office-1", isActive: true },
        { id: "user-2", email: "rep2@two.com", displayName: "Rep Two", officeId: "office-2", isActive: true },
      ],
      allUsers: [
        { id: "user-1", email: "rep1@one.com", displayName: "Rep One", officeId: "office-1", isActive: true },
        { id: "user-2", email: "rep2@two.com", displayName: "Rep Two", officeId: "office-2", isActive: true },
      ],
      tenantRowsBySchema: {
        office_one: {
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
          },
          leadRowsByOwner: {},
        },
        office_two: {
          dealRowsByOwner: {},
          leadRowsByOwner: {
            "owner-2": [
              {
                id: "lead-2",
                assignedRepId: "user-old",
                hubspotOwnerEmail: "old@example.com",
                ownershipSyncStatus: null,
                unassignedReasonCode: null,
              },
            ],
          },
        },
      },
      dealRowsByOwner: {},
      leadRowsByOwner: {},
    });

    fetchAllOwnersMock.mockResolvedValue([
      { id: "owner-1", email: "rep1@one.com" },
      { id: "owner-2", email: "rep2@two.com" },
    ]);
    listActiveUsersWithOfficeAccessMock.mockResolvedValue([]);

    await runOwnershipSync({ dryRun: true });

    const searchPathCalls = dbExecuteMock.mock.calls
      .map(([query]) => extractSqlText(query))
      .filter((text) => text.toLowerCase().includes("set_config('search_path'"));

    expect(searchPathCalls.some((text) => text.includes("office_one,public"))).toBe(true);
    expect(searchPathCalls.some((text) => text.includes("office_two,public"))).toBe(true);
    expect(writeQueries).toHaveLength(0);
  });

  it("applies matched ownership and preserves manual overrides on rerun", async () => {
    const { updateQueries } = createExecuteImplementation({
      offices: [{ id: "office-1", name: "Office One", slug: "one" }],
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
    expect(dbTransactionMock).toHaveBeenCalledOnce();
  });
});
