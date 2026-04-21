import { sql } from "drizzle-orm";
import type { HubSpotOwner } from "../migration/hubspot-client.js";
import { fetchAllOwners, normalizeHubSpotOwnerEmail } from "../migration/hubspot-client.js";
import { db } from "../../db.js";

type OwnershipRecordType = "deal" | "lead";
type OwnershipSyncStatus = "matched" | "unmatched" | "conflict";

export interface OwnershipSyncResult {
  assigned: number;
  unchanged: number;
  unmatched: number;
  conflicts: number;
  inactiveUserConflicts: number;
  examples: {
    matched: OwnershipSyncExample[];
    unmatched: OwnershipSyncExample[];
    conflicts: OwnershipSyncExample[];
    inactiveUserConflicts: OwnershipSyncExample[];
  };
}

export interface OwnershipSyncExample {
  recordType: OwnershipRecordType;
  recordId: string;
  ownerId: string;
  ownerEmail: string | null;
  assignedRepId: string | null;
  mappingStatus: OwnershipSyncStatus;
  reasonCode: string | null;
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

interface SyncOfficeRow {
  id: string;
  name: string;
  slug: string;
}

interface OwnerMappingCandidate {
  id: string;
  email?: string;
}

type OwnershipSyncWriteClient = Pick<typeof db, "execute">;

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

async function fetchActiveOffices(client: OwnershipSyncWriteClient): Promise<SyncOfficeRow[]> {
  const result = await client.execute(sql`
    SELECT id, name, slug
    FROM public.offices
    WHERE is_active = true
    ORDER BY name ASC
  `);

  return getRows<{ id: string; name: string; slug: string }>(result).map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
  }));
}

async function fetchDistinctOwnerIds(
  client: OwnershipSyncWriteClient,
  recordType: OwnershipRecordType
): Promise<string[]> {
  const result = await client.execute(sql`
    SELECT DISTINCT hubspot_owner_id
    FROM ${recordType === "deal" ? sql.raw("deals") : sql.raw("leads")}
    WHERE is_active = true
      AND hubspot_owner_id IS NOT NULL
  `);

  return getRows<{ hubspot_owner_id: string }>(result)
    .map((row) => row.hubspot_owner_id)
    .filter((value): value is string => Boolean(value));
}

async function fetchRowsForOwner(
  client: OwnershipSyncWriteClient,
  recordType: OwnershipRecordType,
  ownerId: string
): Promise<OwnershipTargetRow[]> {
  const result = await client.execute(sql`
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

async function fetchAllUsersForSync(client: OwnershipSyncWriteClient): Promise<SyncUserRow[]> {
  const result = await client.execute(sql`
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

async function setTenantSearchPath(client: OwnershipSyncWriteClient, schemaName: string) {
  await client.execute(sql`
    SELECT set_config('search_path', ${`${schemaName},public`}, true)
  `);
}

async function upsertOwnerMapping(
  client: OwnershipSyncWriteClient,
  owner: OwnerMappingCandidate,
  ownerEmail: string | null,
  mappingStatus: OwnershipSyncStatus,
  failureReasonCode: string | null,
  matchedUser: SyncUserRow | null
) {
  await client.execute(sql`
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
  client: OwnershipSyncWriteClient,
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
    await client.execute(sql`
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

  await client.execute(sql`
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

function createExample(
  recordType: OwnershipRecordType,
  row: OwnershipTargetRow,
  owner: OwnerMappingCandidate,
  ownerEmail: string | null,
  mappingStatus: OwnershipSyncStatus,
  reasonCode: string | null,
  assignedRepId: string | null
): OwnershipSyncExample {
  return {
    recordType,
    recordId: row.id,
    ownerId: owner.id,
    ownerEmail,
    assignedRepId,
    mappingStatus,
    reasonCode,
  };
}

function pushExample(
  bucket: OwnershipSyncExample[],
  example: OwnershipSyncExample,
  limit = 3
) {
  if (bucket.length < limit) bucket.push(example);
}

export async function runOwnershipSync(input: { dryRun?: boolean } = {}): Promise<OwnershipSyncResult> {
  const dryRun = input.dryRun ?? false;
  const result: OwnershipSyncResult = {
    assigned: 0,
    unchanged: 0,
    unmatched: 0,
    conflicts: 0,
    inactiveUserConflicts: 0,
    examples: {
      matched: [],
      unmatched: [],
      conflicts: [],
      inactiveUserConflicts: [],
    },
  };

  const hubspotOwners = await fetchAllOwners();

  const runSync = async (client: OwnershipSyncWriteClient) => {
    const offices = await fetchActiveOffices(client);
    const allUsers = await fetchAllUsersForSync(client);
    const activeUsers = allUsers.filter((user) => user.isActive);

    const activeUsersByEmail = new Map<string, SyncUserRow[]>();
    for (const user of activeUsers) {
      const email = normalizeEmailValue(user.email);
      if (!email) continue;
      const rows = activeUsersByEmail.get(email) ?? [];
      rows.push(user);
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

    for (const office of offices) {
      const schemaName = `office_${office.slug}`;
      await setTenantSearchPath(client, schemaName);

      const recordOwnerIds = new Set<string>();
      for (const ownerId of await fetchDistinctOwnerIds(client, "deal")) recordOwnerIds.add(ownerId);
      for (const ownerId of await fetchDistinctOwnerIds(client, "lead")) recordOwnerIds.add(ownerId);

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

        if (!dryRun) {
          await upsertOwnerMapping(client, owner, ownerEmail, mappingStatus, failureReasonCode, matchedUser);
        }

        const recordTypes: OwnershipRecordType[] = ["deal", "lead"];
        for (const recordType of recordTypes) {
          const rows = await fetchRowsForOwner(client, recordType, owner.id);
          for (const row of rows) {
            if (row.ownershipSyncStatus === "manual_override") {
              result.unchanged++;
              pushExample(
                result.examples.matched,
                createExample(recordType, row, owner, ownerEmail, "matched", "manual_override", row.assignedRepId)
              );
              continue;
            }

            if (mappingStatus === "matched" && matchedUser) {
              pushExample(
                result.examples.matched,
                createExample(recordType, row, owner, ownerEmail, mappingStatus, null, matchedUser.id)
              );
              if (rowMatchesMatchedState(row, ownerEmail, matchedUser)) {
                result.unchanged++;
                continue;
              }

              result.assigned++;
              if (!dryRun) {
                await updateTargetRow(client, recordType, row, owner, ownerEmail, mappingStatus, failureReasonCode, matchedUser);
              }
              continue;
            }

            if (rowMatchesUnresolvedState(row, ownerEmail, mappingStatus as "unmatched" | "conflict", failureReasonCode)) {
              result.unchanged++;
              const example = createExample(
                recordType,
                row,
                owner,
                ownerEmail,
                mappingStatus,
                failureReasonCode,
                row.assignedRepId
              );
              if (mappingStatus === "conflict") {
                pushExample(result.examples.conflicts, example);
                if (failureReasonCode === "inactive_owner_match") {
                  pushExample(result.examples.inactiveUserConflicts, example);
                }
              } else {
                pushExample(result.examples.unmatched, example);
              }
              continue;
            }

            if (mappingStatus === "conflict") {
              result.conflicts++;
              const example = createExample(recordType, row, owner, ownerEmail, mappingStatus, failureReasonCode, null);
              pushExample(result.examples.conflicts, example);
              if (failureReasonCode === "inactive_owner_match") {
                result.inactiveUserConflicts++;
                pushExample(result.examples.inactiveUserConflicts, example);
              }
            } else {
              result.unmatched++;
              pushExample(
                result.examples.unmatched,
                createExample(recordType, row, owner, ownerEmail, mappingStatus, failureReasonCode, null)
              );
            }

            if (!dryRun) {
              await updateTargetRow(client, recordType, row, owner, ownerEmail, mappingStatus, failureReasonCode, null);
            }
          }
        }
      }
    }
  };

  await db.transaction(async (tx) => {
    await runSync(tx);
  });

  return result;
}
