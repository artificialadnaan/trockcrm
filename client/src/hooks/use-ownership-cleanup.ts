import { api } from "@/lib/api";

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

export interface OwnershipSyncPreview {
  summary: OwnershipSyncSummary;
  rows: Array<{
    id: string;
    name: string;
    assignedRepId: string | null;
    targetAssignedRepId: string | null;
    ownerId: string | null;
    ownerEmail: string | null;
    ownershipSyncStatus: string;
    unassignedReasonCode: string | null;
    summaryBucket: string;
  }>;
}

export interface AssignableUser {
  id: string;
  displayName: string;
  email: string;
  officeId: string;
  isActive: boolean;
}

export function previewOwnershipSync() {
  return api<OwnershipSyncPreview>("/sales-review/ownership-sync/preview", {
    method: "POST",
  });
}

export function applyOwnershipSync() {
  return api<OwnershipSyncSummary>("/sales-review/ownership-sync/apply", {
    method: "POST",
  });
}

export async function listAssignableUsers() {
  const response = await api<{ users: AssignableUser[] }>("/sales-review/assignable-users");
  return response.users;
}

export function reassignOwnership(dealId: string, userId: string) {
  return api<{ success: true }>("/sales-review/ownership-reassign", {
    method: "POST",
    json: { dealId, userId },
  });
}
