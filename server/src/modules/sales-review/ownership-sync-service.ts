import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  userExternalIdentities,
  users,
  userOfficeAccess,
  type externalUserSourceEnum,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import {
  fetchAllDeals,
  fetchAllOwners,
  type HubSpotDeal,
  type HubSpotOwner,
} from "../migration/hubspot-client.js";

type TenantDb = NodePgDatabase<typeof schema>;
type ExternalUserSource = (typeof externalUserSourceEnum.enumValues)[number];

type CurrentDeal = {
  id: string;
  name: string;
  hubspotDealId: string | null;
  assignedRepId: string | null;
  ownershipSyncStatus: string | null;
};

type OwnerResolution = {
  targetAssignedRepId: string | null;
  ownerId: string | null;
  ownerEmail: string | null;
  ownershipSyncStatus: string;
  unassignedReasonCode: string | null;
  summaryBucket:
    | "matched"
    | "unchanged"
    | "missing_hubspot_deal"
    | "missing_hubspot_owner"
    | "owner_mapping_failure"
    | "inactive_owner_mapping"
    | "manual_override";
};

export interface OwnershipSyncSummary {
  scannedCount: number;
  matchedCount: number;
  updatedCount: number;
  unchangedCount: number;
  missingHubspotDealCount: number;
  missingHubspotOwnerCount: number;
  ownerMappingFailureCount: number;
  inactiveOwnerConflictCount: number;
  manualOverrideCount: number;
}

type IdentityRow = {
  userId: string;
  externalUserId: string;
  externalEmail: string | null;
  isActive: boolean;
};

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() || null;
}

export function buildOwnerEmailMap(owners: HubSpotOwner[]) {
  return new Map(
    owners
      .map((owner) => [owner.id, normalizeEmail(owner.email)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

function resolveOwner(
  deal: CurrentDeal,
  hubspotDeal: HubSpotDeal | null,
  ownerEmailById: Map<string, string>,
  activeIdentityByOwnerId: Map<string, string>,
  activeUserByEmail: Map<string, string>,
  inactiveIdentityByOwnerId: Set<string>,
): OwnerResolution {
  if (!hubspotDeal) {
    return {
      targetAssignedRepId: deal.assignedRepId,
      ownerId: null,
      ownerEmail: null,
      ownershipSyncStatus: "missing_hubspot_deal",
      unassignedReasonCode: null,
      summaryBucket: "missing_hubspot_deal",
    };
  }

  const ownerId = hubspotDeal.properties.hubspot_owner_id ?? null;
  const ownerEmail = ownerId ? ownerEmailById.get(ownerId) ?? null : null;

  if (!ownerId) {
    if (deal.assignedRepId && deal.ownershipSyncStatus === "manual_reassign") {
      return {
        targetAssignedRepId: deal.assignedRepId,
        ownerId: null,
        ownerEmail: null,
        ownershipSyncStatus: "manual_reassign",
        unassignedReasonCode: null,
        summaryBucket: "manual_override",
      };
    }

    return {
      targetAssignedRepId: null,
      ownerId: null,
      ownerEmail: null,
      ownershipSyncStatus: "unassigned",
      unassignedReasonCode: "missing_hubspot_owner",
      summaryBucket: "missing_hubspot_owner",
    };
  }

  const mappedUserId =
    activeIdentityByOwnerId.get(ownerId) ??
    (ownerEmail ? activeUserByEmail.get(ownerEmail) ?? null : null);

  if (mappedUserId) {
    const unchanged =
      deal.assignedRepId === mappedUserId &&
      deal.ownershipSyncStatus === "matched";

    return {
      targetAssignedRepId: mappedUserId,
      ownerId,
      ownerEmail,
      ownershipSyncStatus: "matched",
      unassignedReasonCode: null,
      summaryBucket: unchanged ? "unchanged" : "matched",
    };
  }

  if (inactiveIdentityByOwnerId.has(ownerId)) {
    if (deal.assignedRepId && deal.ownershipSyncStatus === "manual_reassign") {
      return {
        targetAssignedRepId: deal.assignedRepId,
        ownerId,
        ownerEmail,
        ownershipSyncStatus: "manual_reassign",
        unassignedReasonCode: null,
        summaryBucket: "manual_override",
      };
    }

    return {
      targetAssignedRepId: null,
      ownerId,
      ownerEmail,
      ownershipSyncStatus: "unassigned",
      unassignedReasonCode: "inactive_owner_mapping",
      summaryBucket: "inactive_owner_mapping",
    };
  }

  if (deal.assignedRepId && deal.ownershipSyncStatus === "manual_reassign") {
    return {
      targetAssignedRepId: deal.assignedRepId,
      ownerId,
      ownerEmail,
      ownershipSyncStatus: "manual_reassign",
      unassignedReasonCode: null,
      summaryBucket: "manual_override",
    };
  }

  return {
    targetAssignedRepId: null,
    ownerId,
    ownerEmail,
    ownershipSyncStatus: "unassigned",
    unassignedReasonCode: "owner_mapping_failure",
    summaryBucket: "owner_mapping_failure",
  };
}

export function summarizeOwnershipSyncPlan(input: {
  deals: CurrentDeal[];
  hubspotDeals: HubSpotDeal[];
  hubspotOwners: HubSpotOwner[];
  identityRows: IdentityRow[];
}): {
  summary: OwnershipSyncSummary;
  rows: Array<CurrentDeal & OwnerResolution>;
} {
  const hubspotDealById = new Map(input.hubspotDeals.map((deal) => [deal.id, deal]));
  const ownerEmailById = buildOwnerEmailMap(input.hubspotOwners);
  const activeIdentityByOwnerId = new Map(
    input.identityRows
      .filter((row) => row.isActive)
      .map((row) => [row.externalUserId, row.userId] as const)
  );
  const activeUserByEmail = new Map(
    input.identityRows
      .filter((row) => row.isActive)
      .map((row) => [normalizeEmail(row.externalEmail), row.userId] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0]))
  );
  const inactiveIdentityByOwnerId = new Set(
    input.identityRows.filter((row) => !row.isActive).map((row) => row.externalUserId)
  );

  const rows = input.deals.map((deal) => {
    const hubspotDeal = deal.hubspotDealId ? hubspotDealById.get(deal.hubspotDealId) ?? null : null;
    return {
      ...deal,
      ...resolveOwner(
        deal,
        hubspotDeal,
        ownerEmailById,
        activeIdentityByOwnerId,
        activeUserByEmail,
        inactiveIdentityByOwnerId,
      ),
    };
  });

  const summary: OwnershipSyncSummary = {
    scannedCount: rows.length,
    matchedCount: rows.filter((row) => row.summaryBucket === "matched").length,
    updatedCount: rows.filter((row) => row.summaryBucket !== "unchanged").length,
    unchangedCount: rows.filter((row) => row.summaryBucket === "unchanged").length,
    missingHubspotDealCount: rows.filter((row) => row.summaryBucket === "missing_hubspot_deal").length,
    missingHubspotOwnerCount: rows.filter((row) => row.summaryBucket === "missing_hubspot_owner").length,
    ownerMappingFailureCount: rows.filter((row) => row.summaryBucket === "owner_mapping_failure").length,
    inactiveOwnerConflictCount: rows.filter((row) => row.summaryBucket === "inactive_owner_mapping").length,
    manualOverrideCount: rows.filter((row) => row.summaryBucket === "manual_override").length,
  };

  return { summary, rows };
}

async function listActiveHubspotIdentities(tenantDb: TenantDb, officeId: string) {
  const officeUsers = await tenantDb
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      officeId: users.officeId,
      isActive: users.isActive,
      officeAccessId: userOfficeAccess.id,
    })
    .from(users)
    .leftJoin(
      userOfficeAccess,
      and(eq(userOfficeAccess.userId, users.id), eq(userOfficeAccess.officeId, officeId))
    )
    .where(eq(users.isActive, true));

  const scopedUsers = officeUsers.filter(
    (user) => user.officeId === officeId || user.officeAccessId !== null,
  );

  const officeUserIds = Array.from(new Set(scopedUsers.map((user) => user.id)));
  const identityRows = officeUserIds.length
    ? await tenantDb
        .select({
          userId: userExternalIdentities.userId,
          externalUserId: userExternalIdentities.externalUserId,
          externalEmail: userExternalIdentities.externalEmail,
          isActive: users.isActive,
        })
        .from(userExternalIdentities)
        .innerJoin(users, eq(users.id, userExternalIdentities.userId))
        .where(
          and(
            eq(userExternalIdentities.sourceSystem, "hubspot" as ExternalUserSource),
            inArray(userExternalIdentities.userId, officeUserIds),
          )
        )
    : [];

  return { officeUsers: scopedUsers, identityRows };
}

export async function previewOwnershipSync(tenantDb: TenantDb, officeId: string) {
  const [crmDeals, hubspotDeals, hubspotOwners, { identityRows }] = await Promise.all([
    tenantDb
      .select({
        id: deals.id,
        name: deals.name,
        hubspotDealId: deals.hubspotDealId,
        assignedRepId: deals.assignedRepId,
        ownershipSyncStatus: deals.ownershipSyncStatus,
      })
      .from(deals)
      .where(and(eq(deals.isActive, true), isNotNull(deals.hubspotDealId))),
    fetchAllDeals(),
    fetchAllOwners(),
    listActiveHubspotIdentities(tenantDb, officeId),
  ]);

  return summarizeOwnershipSyncPlan({
    deals: crmDeals,
    hubspotDeals,
    hubspotOwners,
    identityRows,
  });
}

export async function applyOwnershipSync(tenantDb: TenantDb, officeId: string) {
  const preview = await previewOwnershipSync(tenantDb, officeId);

  for (const row of preview.rows) {
    if (row.summaryBucket === "unchanged") continue;

    await tenantDb
      .update(deals)
      .set({
        assignedRepId: row.targetAssignedRepId,
        hubspotOwnerId: row.ownerId,
        hubspotOwnerEmail: row.ownerEmail,
        ownershipSyncedAt: new Date(),
        ownershipSyncStatus: row.ownershipSyncStatus,
        unassignedReasonCode: row.unassignedReasonCode,
        updatedAt: new Date(),
      })
      .where(eq(deals.id, row.id));
  }

  return preview.summary;
}

export async function listAssignableOfficeUsers(tenantDb: TenantDb, officeId: string) {
  const rows = await tenantDb
    .select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
      officeId: users.officeId,
      isActive: users.isActive,
      officeAccessId: userOfficeAccess.id,
    })
    .from(users)
    .leftJoin(
      userOfficeAccess,
      and(eq(userOfficeAccess.userId, users.id), eq(userOfficeAccess.officeId, officeId))
    )
    .where(
      and(
        eq(users.isActive, true),
      )
    );

  return rows
    .filter((row) => row.officeId === officeId || row.officeAccessId !== null)
    .map((row) => ({
      id: row.id,
      displayName: row.displayName,
      email: row.email,
      officeId: row.officeId,
      isActive: row.isActive,
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function reassignOwnedDeal(input: {
  tenantDb: TenantDb;
  actor: { id: string; role: "admin" | "director" | "rep"; activeOfficeId: string };
  dealId: string;
  userId: string;
}) {
  if (input.actor.role === "rep") {
    throw new AppError(403, "Only directors and admins can reassign ownership");
  }

  const [dealRow] = await input.tenantDb
    .select({
      id: deals.id,
      assignedRepId: deals.assignedRepId,
    })
    .from(deals)
    .where(eq(deals.id, input.dealId))
    .limit(1);

  if (!dealRow) {
    throw new AppError(404, "Deal not found");
  }

  const [targetUser] = await input.tenantDb
    .select({
      id: users.id,
      officeId: users.officeId,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  if (!targetUser || !targetUser.isActive) {
    throw new AppError(400, "Target user is missing or inactive");
  }

  const hasOfficeAccess =
    targetUser.officeId === input.actor.activeOfficeId ||
    (
      await input.tenantDb
        .select({ officeId: userOfficeAccess.officeId })
        .from(userOfficeAccess)
        .where(
          and(
            eq(userOfficeAccess.userId, input.userId),
            eq(userOfficeAccess.officeId, input.actor.activeOfficeId),
          )
        )
        .limit(1)
    ).length > 0;

  if (!hasOfficeAccess) {
    throw new AppError(400, "Target user does not have access to this office");
  }

  await input.tenantDb
    .update(deals)
    .set({
      assignedRepId: input.userId,
      ownershipSyncStatus: "manual_reassign",
      unassignedReasonCode: null,
      updatedAt: new Date(),
    })
    .where(eq(deals.id, input.dealId));
}
