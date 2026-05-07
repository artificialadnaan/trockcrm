export interface ProcoreSyncSummaryRow extends Record<string, unknown> {
  sync_status: string;
  count: string;
}

export type ProcoreConflictResolution = "accept_crm" | "accept_procore";

export interface ProcoreConflictResolutionIntent extends Record<string, unknown> {
  resolutionId: string;
  resolution: ProcoreConflictResolution;
  requestedBy: string;
  requestedAt: string;
  crmEntityType: string;
  crmEntityId: string;
  procoreId: string;
}

export interface ProcoreConflictData extends Record<string, unknown> {
  procore_status?: string;
  crm_status?: string;
  resolutionIntent?: ProcoreConflictResolutionIntent;
  originalConflictData?: ProcoreConflictData | Record<string, unknown> | null;
}
