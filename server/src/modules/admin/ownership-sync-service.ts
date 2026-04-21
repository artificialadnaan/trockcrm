import { sql } from "drizzle-orm";
import type { HubSpotOwner } from "../migration/hubspot-client.js";
import { fetchAllOwners, normalizeHubSpotOwnerEmail } from "../migration/hubspot-client.js";
import { listActiveUsersWithOfficeAccess } from "./users-service.js";
import { db } from "../../db.js";

type OwnershipRecordType = "deal" | "lead";
type OwnershipSyncStatus = "matched" | "unmatched" | "conflict";

export interface OwnershipSyncResult {
  assigned: number;
  unchanged: number;
  unmatched: number;
  conflicts: number;
  inactiveUserConflicts: number;
}

interface OwnershipTargetRow {
  id: string;
  assignedRepId: string;
  hubspotOwnerEmail: string | null;
  ownershipSyncStatus: string | null;
  unassignedReasonCode: string | null;
}

interface SyncUserRow {
  id: string;
  email: string;
  officeId: string;
  isActive: boolean;
}

interface OwnerMappingCandidate {
  id: string;
  email?: string;
}

function getRows<T>(result: unknown): T[] {
  if (!result) return [];
  if (Array.isArray(result)) return result as T[];
  if (typeof result === "object" && result !== null && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function normalizeEmailValue(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

async function fetchDistinctOwnerIds(recordType: OwnershipRecordType): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT hubspot_owner_id
    FROM ${recordType === "deal" ? sql.raw("deals") : sql.raw("leads")}
    WHERE is_active = true
      AND hubspot_owner_id IS NOT NULL
  `);

  return getRows<{ hubspot_owner_id: string }>(result)
    .map((row) => row.hubspot_owner_id)
    .filter((value): value is string => Boolean(value));
}

async function fetchRowsForOwner(recordType: OwnershipRecordType, ownerId: string): Promise<OwnershipTargetRow[]> {
  const result = await db.execute(sql`
    SELECT
      id,
      assigned_rep_id,
      hubspot_owner_email,
      ownership_sync_status,
      unassigned_reason_code
    FROM ${recordType === "deal" ? sql.raw("deals") : sql.raw("leads")}
    WHERE is_active = true
      AND hubspot_owner_id = ${ownerId}
  `);

  return getRows<{
    id: string;
    assigned_rep_id: string;
    hubspot_owner_email: string | null;
    ownership_sync_status: string | null;
    unassigned_reason_code: string | null;
  }>(result).map((row) => ({
    id: row.id,
    assignedRepId: row.assigned_rep_id,
    hubspotOwnerEmail: row.hubspot_owner_email,
    ownershipSyncStatus: row.ownership_sync_status,
    unassignedReasonCode: row.unassigned_reason_code,
  }));
}

async function fetchAllUsersForSync(): Promise<SyncUserRow[]> {
  const result = await db.execute(sql`
    SELECT
      id,
      email,
      office_id,
      is_active
    FROM users
    ORDER BY display_name ASC
  `);

  return getRows<{
    id: string;
    email: string;
    office_id: string;
    is_active: boolean;
  }>(result).map((row) => ({
    id: row.id,
    email: row.email,
    officeId: row.office_id,
    isActive: row.is_active,
  }));
}

async function upsertOwnerMapping(
  owner: OwnerMappingCandidate,
  ownerEmail: string | null,
  mappingStatus: OwnershipSyncStatus,
  failureReasonCode: string | null,
  matchedUser: SyncUserRow | null
) {
  await db.execute(sql`
    INSERT INTO public.hubspot_owner_mappings (
      hubspot_owner_id,
      hubspot_owner_email,
      user_id,
      office_id,
      mapping_status,
      failure_reason_code,
      last_seen_at,
      created_at,
      updated_at
    )
    VALUES (
      ${owner.id},
      ${ownerEmail},
      ${matchedUser?.id ?? null},
      ${matchedUser?.officeId ?? null},
      ${mappingStatus},
      ${failureReasonCode},
      NOW(),
      NOW(),
      NOW()
    )
    ON CONFLICT (hubspot_owner_id)
    DO UPDATE SET
      hubspot_owner_email = EXCLUDED.hubspot_owner_email,
      user_id = EXCLUDED.user_id,
      office_id = EXCLUDED.office_id,
      mapping_status = EXCLUDED.mapping_status,
      failure_reason_code = EXCLUDED.failure_reason_code,
      last_seen_at = NOW(),
      updated_at = NOW()
  `);
}

async function updateTargetRow(
  recordType: OwnershipRecordType,
  row: OwnershipTargetRow,
  owner: OwnerMappingCandidate,
  ownerEmail: string | null,
  mappingStatus: OwnershipSyncStatus,
  failureReasonCode: string | null,
  matchedUser: SyncUserRow | null
) {
  const table = recordType === "deal" ? sql.raw("deals") : sql.raw("leads");
  if (mappingStatus === "matched" && matchedUser) {
    await db.execute(sql`
      UPDATE ${table}
      SET assigned_rep_id = ${matchedUser.id},
          hubspot_owner_id = ${owner.id},
          hubspot_owner_email = ${ownerEmail},
          ownership_synced_at = NOW(),
          ownership_sync_status = 'matched',
          unassigned_reason_code = NULL,
          updated_at = NOW()
      WHERE id = ${row.id}
        AND is_active = true
        AND COALESCE(ownership_sync_status, '') <> 'manual_override'
    `);
    return;
  }

  await db.execute(sql`
    UPDATE ${table}
    SET hubspot_owner_id = ${owner.id},
        hubspot_owner_email = ${ownerEmail},
        ownership_synced_at = NOW(),
        ownership_sync_status = ${mappingStatus},
        unassigned_reason_code = ${failureReasonCode},
        updated_at = NOW()
    WHERE id = ${row.id}
      AND is_active = true
      AND COALESCE(ownership_sync_status, '') <> 'manual_override'
  `);
}

function rowMatchesMatchedState(row: OwnershipTargetRow, ownerEmail: string | null, matchedUser: SyncUserRow): boolean {
  return (
    row.assignedRepId === matchedUser.id &&
    normalizeEmailValue(row.hubspotOwnerEmail) === ownerEmail &&
    row.ownershipSyncStatus === "matched" &&
    row.unassignedReasonCode == null
  );
}

function rowMatchesUnresolvedState(
  row: OwnershipTargetRow,
  ownerEmail: string | null,
  mappingStatus: Exclude<OwnershipSyncStatus, "matched">,
  failureReasonCode: string | null
): boolean {
  return (
    normalizeEmailValue(row.hubspotOwnerEmail) === ownerEmail &&
    row.ownershipSyncStatus === mappingStatus &&
    row.unassignedReasonCode === failureReasonCode
  );
}

export async function runOwnershipSync(input: { dryRun?: boolean } = {}): Promise<OwnershipSyncResult> {
  const dryRun = input.dryRun ?? false;
  const result: OwnershipSyncResult = {
    assigned: 0,
    unchanged: 0,
    unmatched: 0,
    conflicts: 0,
    inactiveUserConflicts: 0,
  };

  const hubspotOwners = await fetchAllOwners();
  const activeUsers = await listActiveUsersWithOfficeAccess();
  const allUsers = await fetchAllUsersForSync();

  const activeUsersByEmail = new Map<string, SyncUserRow[]>();
  for (const user of activeUsers) {
    const email = normalizeEmailValue(user.email);
    if (!email) continue;
    const rows = activeUsersByEmail.get(email) ?? [];
    rows.push({
      id: user.id,
      email: user.email,
      officeId: user.officeId,
      isActive: user.isActive,
    });
    activeUsersByEmail.set(email, rows);
  }

  const allUsersByEmail = new Map<string, SyncUserRow[]>();
  for (const user of allUsers) {
    const email = normalizeEmailValue(user.email);
    if (!email) continue;
    const rows = allUsersByEmail.get(email) ?? [];
    rows.push(user);
    allUsersByEmail.set(email, rows);
  }

  const recordOwnerIds = new Set<string>();
  for (const ownerId of await fetchDistinctOwnerIds("deal")) recordOwnerIds.add(ownerId);
  for (const ownerId of await fetchDistinctOwnerIds("lead")) recordOwnerIds.add(ownerId);

  const ownerById = new Map<string, HubSpotOwner>(hubspotOwners.map((owner) => [owner.id, owner]));
  const orderedOwners: OwnerMappingCandidate[] = [
    ...hubspotOwners,
    ...[...recordOwnerIds].filter((ownerId) => !ownerById.has(ownerId)).map((ownerId) => ({ id: ownerId })),
  ];

  for (const owner of orderedOwners) {
    const ownerEmail = normalizeHubSpotOwnerEmail(owner);
    const activeMatches = ownerEmail ? activeUsersByEmail.get(ownerEmail) ?? [] : [];
    const inactiveMatches = ownerEmail
      ? (allUsersByEmail.get(ownerEmail) ?? []).filter((user) => !user.isActive)
      : [];

    let mappingStatus: OwnershipSyncStatus = "unmatched";
    let failureReasonCode: string | null = "owner_mapping_failure";
    let matchedUser: SyncUserRow | null = null;

    if (activeMatches.length === 1) {
      mappingStatus = "matched";
      failureReasonCode = null;
      matchedUser = activeMatches[0];
    } else if (activeMatches.length > 1) {
      mappingStatus = "conflict";
      failureReasonCode = "duplicate_user_match";
    } else if (inactiveMatches.length > 0) {
      mappingStatus = "conflict";
      failureReasonCode = "inactive_owner_match";
    }

    await upsertOwnerMapping(owner, ownerEmail, mappingStatus, failureReasonCode, matchedUser);

    const recordTypes: OwnershipRecordType[] = ["deal", "lead"];
    for (const recordType of recordTypes) {
      const rows = await fetchRowsForOwner(recordType, owner.id);
      for (const row of rows) {
        if (row.ownershipSyncStatus === "manual_override") {
          result.unchanged++;
          continue;
        }

        if (mappingStatus === "matched" && matchedUser) {
          if (rowMatchesMatchedState(row, ownerEmail, matchedUser)) {
            result.unchanged++;
            continue;
          }

          result.assigned++;
          if (!dryRun) {
            await updateTargetRow(recordType, row, owner, ownerEmail, mappingStatus, failureReasonCode, matchedUser);
          }
          continue;
        }

        if (rowMatchesUnresolvedState(row, ownerEmail, mappingStatus as "unmatched" | "conflict", failureReasonCode)) {
          result.unchanged++;
          continue;
        }

        if (mappingStatus === "conflict") {
          result.conflicts++;
          if (failureReasonCode === "inactive_owner_match") {
            result.inactiveUserConflicts++;
          }
        } else {
          result.unmatched++;
        }

        if (!dryRun) {
          await updateTargetRow(recordType, row, owner, ownerEmail, mappingStatus, failureReasonCode, null);
        }
      }
    }
  }

  return result;
}
