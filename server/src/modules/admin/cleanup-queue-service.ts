import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AuthenticatedUser } from "@trock-crm/shared/types";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { updateDeal } from "../deals/service.js";
import { updateLead } from "../leads/service.js";

export type CleanupReasonCode =
  | "missing_decision_maker"
  | "missing_budget_status"
  | "missing_next_step"
  | "missing_next_step_due_at"
  | "missing_forecast_window"
  | "missing_forecast_confidence"
  | "stale_no_recent_activity"
  | "missing_company_or_property_link"
  | "unassigned_owner"
  | "owner_mapping_failure"
  | "inactive_owner_match";

export interface CleanupQueueRow {
  recordType: "lead" | "deal";
  recordId: string;
  recordName: string;
  officeId: string;
  assignedUserId: string | null;
  assignedRepId: string | null;
  reasonCode: CleanupReasonCode;
  reasonCodes: CleanupReasonCode[];
  severity: "high" | "medium" | "low";
  generatedAt: Date;
  evaluatedAt: Date;
}

export interface CleanupQueueResult {
  rows: CleanupQueueRow[];
  byReason: Array<{ reasonCode: CleanupReasonCode; count: number }>;
}

export interface CleanupSourceRow {
  id: string;
  recordName: string;
  assignedRepId: string | null;
  decisionMakerName: string | null;
  budgetStatus: string | null;
  nextStep: string | null;
  nextStepDueAt: string | Date | null;
  forecastWindow: string | null;
  forecastConfidencePercent: number | string | null;
  lastActivityAt: string | Date | null;
  companyId: string | null;
  propertyId: string | null;
  ownershipSyncStatus: string | null;
  unassignedReasonCode: string | null;
}

type CleanupDb = {
  execute: NodePgDatabase<typeof schema>["execute"];
};

type CleanupActor = Pick<AuthenticatedUser, "id" | "role" | "officeId" | "activeOfficeId">;

const REASON_PRIORITY: CleanupReasonCode[] = [
  "missing_next_step",
  "missing_budget_status",
  "missing_next_step_due_at",
  "missing_decision_maker",
  "missing_forecast_window",
  "missing_forecast_confidence",
  "missing_company_or_property_link",
  "stale_no_recent_activity",
  "unassigned_owner",
  "owner_mapping_failure",
  "inactive_owner_match",
];

const OWNERSHIP_REASON_SET = new Set<CleanupReasonCode>([
  "unassigned_owner",
  "owner_mapping_failure",
  "inactive_owner_match",
]);

function normalizeDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function getRows<T>(result: unknown): T[] {
  if (!result) return [];
  if (Array.isArray(result)) return result as T[];
  if (typeof result === "object" && result !== null && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function isOlderThanDays(value: string | Date | null | undefined, days: number, now = new Date()): boolean {
  const date = normalizeDate(value);
  if (!date) return false;
  const diffMs = now.getTime() - date.getTime();
  return diffMs > days * 24 * 60 * 60 * 1000;
}

function toReasonCounts(rows: CleanupQueueRow[]): Array<{ reasonCode: CleanupReasonCode; count: number }> {
  const counts = new Map<CleanupReasonCode, number>();
  for (const row of rows) {
    for (const reasonCode of row.reasonCodes) {
      counts.set(reasonCode, (counts.get(reasonCode) ?? 0) + 1);
    }
  }

  return REASON_PRIORITY
    .filter((reasonCode) => counts.has(reasonCode))
    .map((reasonCode) => ({ reasonCode, count: counts.get(reasonCode) ?? 0 }));
}

function pickPrimaryReason(reasonCodes: CleanupReasonCode[]): CleanupReasonCode {
  for (const reasonCode of REASON_PRIORITY) {
    if (reasonCodes.includes(reasonCode)) return reasonCode;
  }
  return reasonCodes[0] ?? "missing_next_step";
}

function severityForReasons(reasonCodes: CleanupReasonCode[]): "high" | "medium" | "low" {
  if (reasonCodes.some((reasonCode) => OWNERSHIP_REASON_SET.has(reasonCode))) {
    return "high";
  }

  if (reasonCodes.includes("stale_no_recent_activity")) {
    return "low";
  }

  return "medium";
}

function buildCleanupRow(
  recordType: "lead" | "deal",
  officeId: string,
  source: CleanupSourceRow,
  evaluator: (row: CleanupSourceRow) => CleanupReasonCode[]
): CleanupQueueRow | null {
  const reasonCodes = evaluator(source);
  if (reasonCodes.length === 0) return null;

  const evaluatedAt = new Date();
  return {
    recordType,
    recordId: source.id,
    recordName: source.recordName,
    officeId,
    assignedUserId: source.assignedRepId,
    assignedRepId: source.assignedRepId,
    reasonCode: pickPrimaryReason(reasonCodes),
    reasonCodes,
    severity: severityForReasons(reasonCodes),
    generatedAt: evaluatedAt,
    evaluatedAt,
  };
}

function evaluateRepCleanupReasons(row: CleanupSourceRow): CleanupReasonCode[] {
  const reasons: CleanupReasonCode[] = [];

  if (!row.decisionMakerName) reasons.push("missing_decision_maker");
  if (!row.budgetStatus) reasons.push("missing_budget_status");
  if (!row.nextStep) reasons.push("missing_next_step");
  if (!row.nextStepDueAt) reasons.push("missing_next_step_due_at");
  if (!row.forecastWindow) reasons.push("missing_forecast_window");
  if (!row.forecastConfidencePercent) reasons.push("missing_forecast_confidence");
  if (!row.companyId || !row.propertyId) reasons.push("missing_company_or_property_link");
  if (isOlderThanDays(row.lastActivityAt, 14)) reasons.push("stale_no_recent_activity");

  return reasons;
}

function evaluateOwnershipQueueReasons(row: CleanupSourceRow): CleanupReasonCode[] {
  const reasons: CleanupReasonCode[] = [];

  if (!row.assignedRepId) reasons.push("unassigned_owner");
  if (row.unassignedReasonCode === "owner_mapping_failure") reasons.push("owner_mapping_failure");
  if (row.unassignedReasonCode === "inactive_owner_match") reasons.push("inactive_owner_match");
  if (row.ownershipSyncStatus === "unmatched" && !reasons.includes("owner_mapping_failure")) {
    reasons.push("owner_mapping_failure");
  }
  if (row.ownershipSyncStatus === "conflict" && !reasons.includes("inactive_owner_match")) {
    reasons.push("inactive_owner_match");
  }

  return reasons;
}

async function fetchRows(
  tenantDb: CleanupDb,
  recordType: "lead" | "deal",
  whereClause: string
): Promise<CleanupSourceRow[]> {
  const table = recordType === "deal" ? "deals" : "leads";
  const result = await tenantDb.execute(sql.raw(`
    SELECT
      id,
      name AS "recordName",
      assigned_rep_id AS "assignedRepId",
      decision_maker_name AS "decisionMakerName",
      budget_status AS "budgetStatus",
      next_step AS "nextStep",
      next_step_due_at AS "nextStepDueAt",
      forecast_window AS "forecastWindow",
      forecast_confidence_percent AS "forecastConfidencePercent",
      last_activity_at AS "lastActivityAt",
      company_id AS "companyId",
      property_id AS "propertyId",
      ownership_sync_status AS "ownershipSyncStatus",
      unassigned_reason_code AS "unassignedReasonCode"
    FROM ${table}
    WHERE is_active = true
      ${whereClause}
  `));

  const rows = getRows<CleanupSourceRow>(result);
  return rows.map((row) => ({
    ...row,
    assignedRepId: row.assignedRepId ?? null,
    decisionMakerName: row.decisionMakerName ?? null,
    budgetStatus: row.budgetStatus ?? null,
    nextStep: row.nextStep ?? null,
    nextStepDueAt: row.nextStepDueAt ?? null,
    forecastWindow: row.forecastWindow ?? null,
    forecastConfidencePercent: row.forecastConfidencePercent ?? null,
    lastActivityAt: row.lastActivityAt ?? null,
    companyId: row.companyId ?? null,
    propertyId: row.propertyId ?? null,
    ownershipSyncStatus: row.ownershipSyncStatus ?? null,
    unassignedReasonCode: row.unassignedReasonCode ?? null,
  }));
}

function sortRows(rows: CleanupQueueRow[]): CleanupQueueRow[] {
  return [...rows].sort((left, right) => {
    const severityRank: Record<CleanupQueueRow["severity"], number> = { high: 0, medium: 1, low: 2 };
    const severityDelta = severityRank[left.severity] - severityRank[right.severity];
    if (severityDelta !== 0) return severityDelta;
    if (left.recordType !== right.recordType) return left.recordType.localeCompare(right.recordType);
    return left.recordName.localeCompare(right.recordName);
  });
}

function assertActorCanViewOffice(actor: CleanupActor | undefined, officeId: string) {
  if (!actor) return;
  if (actor.role === "admin") return;
  const activeOfficeId = actor.activeOfficeId ?? actor.officeId;
  if (activeOfficeId !== officeId) {
    throw new AppError(403, "Directors can only view cleanup queues for accessible offices");
  }
}

async function writeManualOverride(
  tenantDb: CleanupDb,
  recordType: "lead" | "deal",
  recordId: string
) {
  const table = recordType === "deal" ? "deals" : "leads";
  await tenantDb.execute(sql.raw(`
    UPDATE ${table}
    SET ownership_sync_status = 'manual_override',
        unassigned_reason_code = NULL,
        ownership_synced_at = NOW(),
        updated_at = NOW()
    WHERE id = '${recordId}'
  `));
}

export async function getMyCleanupQueue(
  tenantDb: CleanupDb,
  userId: string,
  officeId?: string
): Promise<CleanupQueueResult> {
  const dealRows = await fetchRows(
    tenantDb,
    "deal",
    `AND assigned_rep_id = '${userId}'`
  );
  const leadRows = await fetchRows(
    tenantDb,
    "lead",
    `AND assigned_rep_id = '${userId}'`
  );

  const rows = sortRows([
    ...dealRows.flatMap((row) => {
      const queueRow = buildCleanupRow("deal", officeId ?? "", row, evaluateRepCleanupReasons);
      return queueRow ? [queueRow] : [];
    }),
    ...leadRows.flatMap((row) => {
      const queueRow = buildCleanupRow("lead", officeId ?? "", row, evaluateRepCleanupReasons);
      return queueRow ? [queueRow] : [];
    }),
  ]);

  return {
    rows,
    byReason: toReasonCounts(rows),
  };
}

export async function getOfficeOwnershipQueue(
  tenantDb: CleanupDb,
  officeId: string,
  actor?: CleanupActor
): Promise<CleanupQueueResult> {
  assertActorCanViewOffice(actor, officeId);

  const whereClause = `
      AND (
        assigned_rep_id IS NULL
        OR ownership_sync_status IN ('unmatched', 'conflict')
        OR unassigned_reason_code IN ('owner_mapping_failure', 'inactive_owner_match')
      )
  `;

  const dealRows = await fetchRows(tenantDb, "deal", whereClause);
  const leadRows = await fetchRows(tenantDb, "lead", whereClause);

  const rows = sortRows([
    ...dealRows.flatMap((row) => {
      const queueRow = buildCleanupRow("deal", officeId, row, evaluateOwnershipQueueReasons);
      return queueRow ? [queueRow] : [];
    }),
    ...leadRows.flatMap((row) => {
      const queueRow = buildCleanupRow("lead", officeId, row, evaluateOwnershipQueueReasons);
      return queueRow ? [queueRow] : [];
    }),
  ]);

  return {
    rows,
    byReason: toReasonCounts(rows),
  };
}

export async function bulkReassignOwnershipQueueRows(
  tenantDb: CleanupDb,
  actor: CleanupActor,
  input: {
    rows: Array<{ recordType: "lead" | "deal"; recordId: string }>;
    assigneeId: string;
  }
): Promise<{ updated: number }> {
  if (actor.role !== "admin" && actor.role !== "director") {
    throw new AppError(403, "Only directors and admins can bulk reassign cleanup queue rows");
  }

  if (!input.assigneeId) {
    throw new AppError(400, "assigneeId is required");
  }

  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    throw new AppError(400, "rows are required");
  }

  const officeId = actor.activeOfficeId ?? actor.officeId;
  const uniqueRows = new Map<string, { recordType: "lead" | "deal"; recordId: string }>();
  for (const row of input.rows) {
    uniqueRows.set(`${row.recordType}:${row.recordId}`, row);
  }

  let updated = 0;
  for (const row of uniqueRows.values()) {
    if (row.recordType === "deal") {
      await updateDeal(tenantDb as any, row.recordId, { assignedRepId: input.assigneeId }, actor.role, actor.id, officeId);
      await writeManualOverride(tenantDb, "deal", row.recordId);
      updated++;
      continue;
    }

    await updateLead(
      tenantDb as any,
      row.recordId,
      { assignedRepId: input.assigneeId, officeId },
      actor.role,
      actor.id
    );
    await writeManualOverride(tenantDb, "lead", row.recordId);
    updated++;
  }

  return { updated };
}
