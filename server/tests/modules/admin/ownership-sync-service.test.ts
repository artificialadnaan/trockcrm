import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { hubspotOwnerMappings } from "../../../../shared/src/schema/public/hubspot-owner-mappings.js";
import { deals } from "../../../../shared/src/schema/tenant/deals.js";
import { leads } from "../../../../shared/src/schema/tenant/leads.js";

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
});
