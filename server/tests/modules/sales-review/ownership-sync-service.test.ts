import { describe, expect, it } from "vitest";
import { summarizeOwnershipSyncPlan } from "../../../src/modules/sales-review/ownership-sync-service.js";

describe("ownership sync service", () => {
  it("maps HubSpot-owned deals to active CRM users by external identity", () => {
    const result = summarizeOwnershipSyncPlan({
      deals: [
        {
          id: "deal-1",
          name: "Skyline Towers",
          hubspotDealId: "hs-deal-1",
          assignedRepId: null,
          ownershipSyncStatus: null,
        },
      ],
      hubspotDeals: [
        {
          id: "hs-deal-1",
          properties: {
            hubspot_owner_id: "owner-1",
          },
        },
      ],
      hubspotOwners: [
        {
          id: "owner-1",
          email: "rep@trock.dev",
        },
      ],
      identityRows: [
        {
          userId: "user-1",
          externalUserId: "owner-1",
          externalEmail: "rep@trock.dev",
          isActive: true,
        },
      ],
    });

    expect(result.summary.matchedCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      targetAssignedRepId: "user-1",
      ownershipSyncStatus: "matched",
      unassignedReasonCode: null,
      summaryBucket: "matched",
    });
  });

  it("marks deals unassigned when the HubSpot deal has no owner", () => {
    const result = summarizeOwnershipSyncPlan({
      deals: [
        {
          id: "deal-1",
          name: "Skyline Towers",
          hubspotDealId: "hs-deal-1",
          assignedRepId: "user-1",
          ownershipSyncStatus: "matched",
        },
      ],
      hubspotDeals: [
        {
          id: "hs-deal-1",
          properties: {},
        },
      ],
      hubspotOwners: [],
      identityRows: [],
    });

    expect(result.summary.missingHubspotOwnerCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      targetAssignedRepId: null,
      ownershipSyncStatus: "unassigned",
      unassignedReasonCode: "missing_hubspot_owner",
      summaryBucket: "missing_hubspot_owner",
    });
  });

  it("flags inactive mapped users separately from unmatched owners", () => {
    const result = summarizeOwnershipSyncPlan({
      deals: [
        {
          id: "deal-1",
          name: "Skyline Towers",
          hubspotDealId: "hs-deal-1",
          assignedRepId: null,
          ownershipSyncStatus: null,
        },
      ],
      hubspotDeals: [
        {
          id: "hs-deal-1",
          properties: {
            hubspot_owner_id: "owner-2",
          },
        },
      ],
      hubspotOwners: [
        {
          id: "owner-2",
          email: "inactive@trock.dev",
        },
      ],
      identityRows: [
        {
          userId: "user-2",
          externalUserId: "owner-2",
          externalEmail: "inactive@trock.dev",
          isActive: false,
        },
      ],
    });

    expect(result.summary.inactiveOwnerConflictCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      targetAssignedRepId: null,
      unassignedReasonCode: "inactive_owner_mapping",
      summaryBucket: "inactive_owner_mapping",
    });
  });

  it("preserves manual reassignment when HubSpot still lacks a valid owner mapping", () => {
    const result = summarizeOwnershipSyncPlan({
      deals: [
        {
          id: "deal-1",
          name: "Skyline Towers",
          hubspotDealId: "hs-deal-1",
          assignedRepId: "user-9",
          ownershipSyncStatus: "manual_reassign",
        },
      ],
      hubspotDeals: [
        {
          id: "hs-deal-1",
          properties: {
            hubspot_owner_id: "owner-missing",
          },
        },
      ],
      hubspotOwners: [
        {
          id: "owner-missing",
          email: "missing@trock.dev",
        },
      ],
      identityRows: [],
    });

    expect(result.summary.manualOverrideCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      targetAssignedRepId: "user-9",
      ownershipSyncStatus: "manual_reassign",
      summaryBucket: "manual_override",
    });
  });
});
