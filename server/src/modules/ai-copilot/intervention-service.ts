import { and, desc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  aiFeedback,
  aiDisconnectCaseHistory,
  aiDisconnectCases,
  companies,
  deals,
  tasks,
} from "@trock-crm/shared/schema";
import {
  getDisconnectCaseIdentity,
  listCurrentSalesProcessDisconnectRows,
  type SalesProcessDisconnectRow,
} from "./service.js";
import type {
  InterventionCaseDetail,
  InterventionQueueItem,
  InterventionQueueResult,
} from "./intervention-types.js";
import {
  completeTask,
  dismissTask,
  snoozeTask,
  updateTask,
} from "../tasks/service.js";

type TenantDb = NodePgDatabase<typeof schema>;

type DisconnectCaseRow = typeof aiDisconnectCases.$inferSelect;
type DisconnectCaseInsert = typeof aiDisconnectCases.$inferInsert;
type DisconnectCaseHistoryRow = typeof aiDisconnectCaseHistory.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type DealRow = typeof deals.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;
type AiFeedbackRow = typeof aiFeedback.$inferSelect;

type InMemoryTenantDb = {
  state: {
    cases: DisconnectCaseRow[];
    tasks: TaskRow[];
    deals: Array<Pick<DealRow, "id" | "dealNumber" | "name" | "companyId">>;
    companies: Array<Pick<CompanyRow, "id" | "name">>;
    history: DisconnectCaseHistoryRow[];
    feedback?: AiFeedbackRow[];
  };
};

function isInMemoryTenantDb(value: unknown): value is InMemoryTenantDb {
  return Boolean(value && typeof value === "object" && "state" in value);
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function severityRank(value: string) {
  switch (value) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function buildBusinessKey(officeId: string, row: SalesProcessDisconnectRow) {
  const identity = getDisconnectCaseIdentity(row);
  return `${officeId}:${row.disconnectType}:${identity.scopeType}:${identity.scopeId}`;
}

function buildCaseMetadata(row: SalesProcessDisconnectRow) {
  return {
    evidenceSummary: row.disconnectSummary,
    disconnectLabel: row.disconnectLabel,
    disconnectSummary: row.disconnectSummary,
    disconnectDetails: row.disconnectDetails,
    dealNumber: row.dealNumber,
    dealName: row.dealName,
    companyName: row.companyName,
    stageName: row.stageName,
    assignedRepName: row.assignedRepName,
    ageDays: row.ageDays,
    latestCustomerEmailAt: row.latestCustomerEmailAt,
    lastActivityAt: row.lastActivityAt,
    proposalStatus: row.proposalStatus,
    procoreSyncStatus: row.procoreSyncStatus,
    procoreDriftReason: row.procoreDriftReason,
  } satisfies Record<string, unknown>;
}

function buildCaseInsert(
  officeId: string,
  row: SalesProcessDisconnectRow,
  now: Date
): DisconnectCaseInsert {
  return {
    officeId,
    scopeType: getDisconnectCaseIdentity(row).scopeType,
    scopeId: getDisconnectCaseIdentity(row).scopeId,
    dealId: row.id,
    companyId: row.companyId,
    disconnectType: row.disconnectType,
    clusterKey: getDisconnectCaseIdentity(row).clusterKey,
    businessKey: buildBusinessKey(officeId, row),
    severity: row.disconnectSeverity,
    status: "open",
    generatedTaskId: null,
    escalated: false,
    reopenCount: 0,
    firstDetectedAt: now,
    lastDetectedAt: now,
    metadataJson: buildCaseMetadata(row),
  };
}

function shouldReopenCase(existing: DisconnectCaseRow, now: Date) {
  if (existing.status === "resolved") return true;
  if (existing.status !== "snoozed") return false;
  if (!existing.snoozedUntil) return true;
  return existing.snoozedUntil <= now;
}

function sortQueueItems(a: InterventionQueueItem, b: InterventionQueueItem) {
  const expiredSnoozeA = a.status === "snoozed" ? 1 : 0;
  const expiredSnoozeB = b.status === "snoozed" ? 1 : 0;
  if (expiredSnoozeA !== expiredSnoozeB) return expiredSnoozeB - expiredSnoozeA;
  const severityDelta = severityRank(b.severity) - severityRank(a.severity);
  if (severityDelta !== 0) return severityDelta;
  if (b.ageDays !== a.ageDays) return b.ageDays - a.ageDays;
  return a.businessKey.localeCompare(b.businessKey);
}

function projectQueueItem(input: {
  row: DisconnectCaseRow;
  task: TaskRow | null;
  deal: Pick<DealRow, "id" | "dealNumber" | "name" | "companyId"> | null;
  company: Pick<CompanyRow, "id" | "name"> | null;
  history: DisconnectCaseHistoryRow | null;
}): InterventionQueueItem {
  const ageDaysRaw = input.row.metadataJson && typeof input.row.metadataJson === "object"
    ? (input.row.metadataJson as Record<string, unknown>).ageDays
    : null;
  const evidenceSummaryRaw = input.row.metadataJson && typeof input.row.metadataJson === "object"
    ? (input.row.metadataJson as Record<string, unknown>).evidenceSummary
    : null;

  return {
    id: input.row.id,
    businessKey: input.row.businessKey,
    disconnectType: input.row.disconnectType,
    clusterKey: input.row.clusterKey,
    severity: input.row.severity,
    status: input.row.status as "open" | "snoozed" | "resolved",
    escalated: input.row.escalated,
    ageDays: typeof ageDaysRaw === "number" ? ageDaysRaw : 0,
    assignedTo: input.row.assignedTo,
    generatedTask: input.task
      ? {
          id: input.task.id,
          status: input.task.status,
          assignedTo: input.task.assignedTo,
          title: input.task.title,
        }
      : null,
    deal: input.deal
      ? {
          id: input.deal.id,
          dealNumber: input.deal.dealNumber,
          name: input.deal.name,
        }
      : null,
    company: input.company
      ? {
          id: input.company.id,
          name: input.company.name,
        }
      : null,
    evidenceSummary: typeof evidenceSummaryRaw === "string" ? evidenceSummaryRaw : null,
    lastIntervention: input.history
      ? {
          actionType: input.history.actionType,
          actedAt: input.history.actedAt.toISOString(),
        }
      : null,
  };
}

async function getCasesByOffice(tenantDb: TenantDb, officeId: string) {
  return tenantDb
    .select()
    .from(aiDisconnectCases)
    .where(eq(aiDisconnectCases.officeId, officeId));
}

export async function loadDisconnectCaseSchemaTables(tenantDb: {
  select: () => {
    from: <T>(table: T) => Promise<T>;
  };
}) {
  const cases = await tenantDb.select().from(aiDisconnectCases);
  const history = await tenantDb.select().from(aiDisconnectCaseHistory);

  return { cases, history };
}

export async function materializeDisconnectCases(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: { officeId: string; now?: Date }
) {
  const now = input.now ?? new Date();
  const rows = await listCurrentSalesProcessDisconnectRows(tenantDb as never, { limit: 500 });
  const uniqueRows = Array.from(
    rows.reduce((map, row) => map.set(buildBusinessKey(input.officeId, row), row), new Map<string, SalesProcessDisconnectRow>()).values()
  );

  if (isInMemoryTenantDb(tenantDb)) {
    for (const row of uniqueRows) {
      const businessKey = buildBusinessKey(input.officeId, row);
      const existing = tenantDb.state.cases.find(
        (item) => item.officeId === input.officeId && item.businessKey === businessKey
      );
      const nextGeneratedTask = tenantDb.state.tasks.find(
        (task) => task.dedupeKey === businessKey || task.dealId === row.id
      );
      if (!existing) {
        tenantDb.state.cases.push({
          id: `case-${tenantDb.state.cases.length + 1}`,
          ...buildCaseInsert(input.officeId, row, now),
          generatedTaskId: nextGeneratedTask?.id ?? null,
          createdAt: now,
          updatedAt: now,
        } as DisconnectCaseRow);
        continue;
      }

      existing.severity = row.disconnectSeverity;
      existing.clusterKey = getDisconnectCaseIdentity(row).clusterKey;
      existing.lastDetectedAt = now;
      existing.companyId = row.companyId;
      existing.generatedTaskId = nextGeneratedTask?.id ?? existing.generatedTaskId;
      existing.metadataJson = buildCaseMetadata(row);
      existing.updatedAt = now;
      if (shouldReopenCase(existing, now)) {
        existing.status = "open";
        existing.reopenCount += 1;
        existing.snoozedUntil = null;
        existing.resolvedAt = null;
        existing.resolutionReason = null;
      }
    }
    return { caseCount: tenantDb.state.cases.length };
  }

  const businessKeys = uniqueRows.map((row) => buildBusinessKey(input.officeId, row));
  const existingCases = businessKeys.length
    ? await tenantDb
        .select()
        .from(aiDisconnectCases)
        .where(and(eq(aiDisconnectCases.officeId, input.officeId), inArray(aiDisconnectCases.businessKey, businessKeys)))
    : [];
  const existingByBusinessKey = new Map(existingCases.map((row) => [row.businessKey, row]));

  for (const row of uniqueRows) {
    const businessKey = buildBusinessKey(input.officeId, row);
    const existing = existingByBusinessKey.get(businessKey);
    const nextGeneratedTask = await tenantDb
      .select()
      .from(tasks)
      .where(eq(tasks.dealId, row.id))
      .orderBy(desc(tasks.createdAt))
      .limit(1);

    const baseUpdate = {
      severity: row.disconnectSeverity,
      clusterKey: getDisconnectCaseIdentity(row).clusterKey,
      companyId: row.companyId,
      lastDetectedAt: now,
      generatedTaskId: nextGeneratedTask[0]?.id ?? existing?.generatedTaskId ?? null,
      metadataJson: buildCaseMetadata(row),
      updatedAt: now,
    } satisfies Partial<DisconnectCaseInsert>;

    if (!existing) {
      await tenantDb.insert(aiDisconnectCases).values({
        ...buildCaseInsert(input.officeId, row, now),
        generatedTaskId: nextGeneratedTask[0]?.id ?? null,
        createdAt: now,
        updatedAt: now,
      });
      continue;
    }

    const reopen = shouldReopenCase(existing, now);
    await tenantDb
      .update(aiDisconnectCases)
      .set({
        ...baseUpdate,
        status: reopen ? "open" : existing.status,
        snoozedUntil: reopen ? null : existing.snoozedUntil,
        resolvedAt: reopen ? null : existing.resolvedAt,
        resolutionReason: reopen ? null : existing.resolutionReason,
        reopenCount: reopen ? existing.reopenCount + 1 : existing.reopenCount,
      })
      .where(eq(aiDisconnectCases.id, existing.id));
  }

  return { caseCount: uniqueRows.length };
}

export async function listInterventionCases(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: { officeId: string; status?: "open" | "snoozed" | "resolved"; page?: number; pageSize?: number; now?: Date }
): Promise<InterventionQueueResult> {
  const now = input.now ?? new Date();
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, Math.min(input.pageSize ?? 50, 200));

  if (isInMemoryTenantDb(tenantDb)) {
    let cases = tenantDb.state.cases.filter((row) => row.officeId === input.officeId);
    cases = cases.filter((row) => {
      if (input.status) return row.status === input.status;
      if (row.status === "resolved") return false;
      if (row.status === "snoozed" && (!row.snoozedUntil || row.snoozedUntil > now)) return false;
      return true;
    });

    const latestHistoryByCase = new Map<string, DisconnectCaseHistoryRow>();
    for (const row of tenantDb.state.history.sort((a, b) => b.actedAt.getTime() - a.actedAt.getTime())) {
      if (!latestHistoryByCase.has(row.disconnectCaseId)) latestHistoryByCase.set(row.disconnectCaseId, row);
    }

    const items = cases
      .map((row) =>
        projectQueueItem({
          row,
          task: tenantDb.state.tasks.find((task) => task.id === row.generatedTaskId) ?? null,
          deal: tenantDb.state.deals.find((deal) => deal.id === row.dealId) ?? null,
          company: tenantDb.state.companies.find((company) => company.id === row.companyId) ?? null,
          history: latestHistoryByCase.get(row.id) ?? null,
        })
      )
      .sort(sortQueueItems);

    const paged = items.slice((page - 1) * pageSize, page * pageSize);
    return {
      items: paged,
      totalCount: items.length,
      page,
      pageSize,
    };
  }

  let cases = await getCasesByOffice(tenantDb, input.officeId);
  cases = cases.filter((row) => {
    if (input.status) return row.status === input.status;
    if (row.status === "resolved") return false;
    if (row.status === "snoozed" && (!row.snoozedUntil || row.snoozedUntil > now)) return false;
    return true;
  });

  const taskIds = cases.map((row) => row.generatedTaskId).filter((value): value is string => Boolean(value));
  const dealIds = cases.map((row) => row.dealId).filter((value): value is string => Boolean(value));
  const companyIds = cases.map((row) => row.companyId).filter((value): value is string => Boolean(value));
  const [taskRows, dealRows, companyRows, historyRows] = await Promise.all([
    taskIds.length ? tenantDb.select().from(tasks).where(inArray(tasks.id, taskIds)) : Promise.resolve([]),
    dealIds.length ? tenantDb.select().from(deals).where(inArray(deals.id, dealIds)) : Promise.resolve([]),
    companyIds.length ? tenantDb.select().from(companies).where(inArray(companies.id, companyIds)) : Promise.resolve([]),
    cases.length
      ? tenantDb
          .select()
          .from(aiDisconnectCaseHistory)
          .where(inArray(aiDisconnectCaseHistory.disconnectCaseId, cases.map((row) => row.id)))
          .orderBy(desc(aiDisconnectCaseHistory.actedAt))
      : Promise.resolve([]),
  ]);

  const taskMap = new Map(taskRows.map((row) => [row.id, row]));
  const dealMap = new Map(dealRows.map((row) => [row.id, row]));
  const companyMap = new Map(companyRows.map((row) => [row.id, row]));
  const latestHistoryByCase = new Map<string, DisconnectCaseHistoryRow>();
  for (const row of historyRows) {
    if (!latestHistoryByCase.has(row.disconnectCaseId)) latestHistoryByCase.set(row.disconnectCaseId, row);
  }

  const items = cases
    .map((row) =>
      projectQueueItem({
        row,
        task: row.generatedTaskId ? taskMap.get(row.generatedTaskId) ?? null : null,
        deal: row.dealId ? dealMap.get(row.dealId) ?? null : null,
        company: row.companyId ? companyMap.get(row.companyId) ?? null : null,
        history: latestHistoryByCase.get(row.id) ?? null,
      })
    )
    .sort(sortQueueItems);

  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    totalCount: items.length,
    page,
    pageSize,
  };
}

export async function getInterventionCaseDetail(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: { officeId: string; caseId: string }
): Promise<InterventionCaseDetail> {
  if (isInMemoryTenantDb(tenantDb)) {
    const row = tenantDb.state.cases.find((item) => item.officeId === input.officeId && item.id === input.caseId);
    if (!row) {
      throw new Error(`Intervention case ${input.caseId} not found`);
    }
    const task = row.generatedTaskId
      ? tenantDb.state.tasks.find((item) => item.id === row.generatedTaskId) ?? null
      : null;
    const deal = row.dealId ? tenantDb.state.deals.find((item) => item.id === row.dealId) ?? null : null;
    const company = row.companyId
      ? tenantDb.state.companies.find((item) => item.id === row.companyId) ?? null
      : null;
    const history = tenantDb.state.history
      .filter((item) => item.disconnectCaseId === row.id)
      .sort((a, b) => b.actedAt.getTime() - a.actedAt.getTime());

    return {
      case: {
        id: row.id,
        businessKey: row.businessKey,
        disconnectType: row.disconnectType,
        clusterKey: row.clusterKey,
        severity: row.severity,
        status: row.status as "open" | "snoozed" | "resolved",
        assignedTo: row.assignedTo,
        generatedTaskId: row.generatedTaskId,
        escalated: row.escalated,
        snoozedUntil: toIsoString(row.snoozedUntil),
        reopenCount: row.reopenCount,
        lastDetectedAt: row.lastDetectedAt.toISOString(),
        lastIntervenedAt: toIsoString(row.lastIntervenedAt),
        resolvedAt: toIsoString(row.resolvedAt),
        resolutionReason: row.resolutionReason,
        metadataJson: (row.metadataJson as Record<string, unknown> | null) ?? null,
      },
      generatedTask: task
        ? {
            id: task.id,
            title: task.title,
            status: task.status,
            assignedTo: task.assignedTo,
          }
        : null,
      crm: {
        deal: deal
          ? {
              id: deal.id,
              dealNumber: deal.dealNumber,
              name: deal.name,
            }
          : null,
        company: company
          ? {
              id: company.id,
              name: company.name,
            }
          : null,
      },
      history: history.map((entry) => ({
        id: entry.id,
        actionType: entry.actionType,
        actedBy: entry.actedBy,
        actedAt: entry.actedAt.toISOString(),
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        fromAssignee: entry.fromAssignee,
        toAssignee: entry.toAssignee,
        fromSnoozedUntil: toIsoString(entry.fromSnoozedUntil),
        toSnoozedUntil: toIsoString(entry.toSnoozedUntil),
        notes: entry.notes,
        metadataJson: (entry.metadataJson as Record<string, unknown> | null) ?? null,
      })),
    };
  }

  const row = await tenantDb
    .select()
    .from(aiDisconnectCases)
    .where(and(eq(aiDisconnectCases.officeId, input.officeId), eq(aiDisconnectCases.id, input.caseId)))
    .limit(1);
  if (!row[0]) {
    throw new Error(`Intervention case ${input.caseId} not found`);
  }
  const taskRow = row[0].generatedTaskId
    ? (
        await tenantDb.select().from(tasks).where(eq(tasks.id, row[0].generatedTaskId)).limit(1)
      )[0] ?? null
    : null;
  const dealRow = row[0].dealId
    ? (
        await tenantDb.select().from(deals).where(eq(deals.id, row[0].dealId)).limit(1)
      )[0] ?? null
    : null;
  const companyRow = row[0].companyId
    ? (
        await tenantDb.select().from(companies).where(eq(companies.id, row[0].companyId)).limit(1)
      )[0] ?? null
    : null;
  const historyRows = await tenantDb
    .select()
    .from(aiDisconnectCaseHistory)
    .where(eq(aiDisconnectCaseHistory.disconnectCaseId, row[0].id))
    .orderBy(desc(aiDisconnectCaseHistory.actedAt));

  return {
    case: {
      id: row[0].id,
      businessKey: row[0].businessKey,
      disconnectType: row[0].disconnectType,
      clusterKey: row[0].clusterKey,
      severity: row[0].severity,
      status: row[0].status as "open" | "snoozed" | "resolved",
      assignedTo: row[0].assignedTo,
      generatedTaskId: row[0].generatedTaskId,
      escalated: row[0].escalated,
      snoozedUntil: toIsoString(row[0].snoozedUntil),
      reopenCount: row[0].reopenCount,
      lastDetectedAt: row[0].lastDetectedAt.toISOString(),
      lastIntervenedAt: toIsoString(row[0].lastIntervenedAt),
      resolvedAt: toIsoString(row[0].resolvedAt),
      resolutionReason: row[0].resolutionReason,
      metadataJson: (row[0].metadataJson as Record<string, unknown> | null) ?? null,
    },
    generatedTask: taskRow
      ? {
          id: taskRow.id,
          title: taskRow.title,
          status: taskRow.status,
          assignedTo: taskRow.assignedTo,
        }
      : null,
    crm: {
      deal: dealRow
        ? {
            id: dealRow.id,
            dealNumber: dealRow.dealNumber,
            name: dealRow.name,
          }
        : null,
      company: companyRow
        ? {
            id: companyRow.id,
            name: companyRow.name,
          }
        : null,
    },
    history: historyRows.map((entry) => ({
      id: entry.id,
      actionType: entry.actionType,
      actedBy: entry.actedBy,
      actedAt: entry.actedAt.toISOString(),
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      fromAssignee: entry.fromAssignee,
      toAssignee: entry.toAssignee,
      fromSnoozedUntil: toIsoString(entry.fromSnoozedUntil),
      toSnoozedUntil: toIsoString(entry.toSnoozedUntil),
      notes: entry.notes,
      metadataJson: (entry.metadataJson as Record<string, unknown> | null) ?? null,
    })),
  };
}

type MutationAction = "assign" | "snooze" | "resolve" | "escalate";

interface MutationRecordInput {
  actionType: MutationAction;
  actedBy: string;
  comment: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  fromAssignee?: string | null;
  toAssignee?: string | null;
  fromSnoozedUntil?: Date | null;
  toSnoozedUntil?: Date | null;
  metadataJson?: Record<string, unknown> | null;
}

interface MutationResult {
  updatedCount: number;
  skippedCount: number;
  errors: Array<{ caseId: string; message: string }>;
}

function createFeedbackComment(input: {
  comment: string | null;
  metadataJson?: Record<string, unknown> | null;
}) {
  if (!input.metadataJson || Object.keys(input.metadataJson).length === 0) {
    return input.comment;
  }

  return JSON.stringify({
    note: input.comment,
    ...input.metadataJson,
  });
}

async function writeMutationArtifacts(
  tenantDb: TenantDb | InMemoryTenantDb,
  disconnectCase: DisconnectCaseRow,
  input: MutationRecordInput
) {
  const actedAt = new Date();
  const historyRecord = {
    id: isInMemoryTenantDb(tenantDb)
      ? `history-${(tenantDb.state.history?.length ?? 0) + 1}`
      : undefined,
    disconnectCaseId: disconnectCase.id,
    actionType: input.actionType,
    actedBy: input.actedBy,
    actedAt,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    fromAssignee: input.fromAssignee ?? null,
    toAssignee: input.toAssignee ?? null,
    fromSnoozedUntil: input.fromSnoozedUntil ?? null,
    toSnoozedUntil: input.toSnoozedUntil ?? null,
    notes: input.comment,
    metadataJson: input.metadataJson ?? null,
  } satisfies typeof aiDisconnectCaseHistory.$inferInsert;

  const feedbackPayload = {
    targetType: "disconnect_case",
    targetId: disconnectCase.id,
    userId: input.actedBy,
    feedbackType: "intervention_action",
    feedbackValue: input.actionType,
    comment: createFeedbackComment({
      comment: input.comment,
      metadataJson: input.metadataJson,
    }),
  } satisfies typeof aiFeedback.$inferInsert;

  if (isInMemoryTenantDb(tenantDb)) {
    tenantDb.state.history.push(historyRecord as DisconnectCaseHistoryRow);
    const feedbackRecord = {
      id: `feedback-${(tenantDb.state.feedback?.length ?? 0) + 1}`,
      createdAt: actedAt,
      ...feedbackPayload,
    } as AiFeedbackRow;
    tenantDb.state.feedback ??= [];
    tenantDb.state.feedback.push(feedbackRecord);
    return { historyId: historyRecord.id!, feedbackId: feedbackRecord.id };
  }

  const [createdHistory] = await tenantDb
    .insert(aiDisconnectCaseHistory)
    .values(historyRecord)
    .returning();
  const [createdFeedback] = await tenantDb
    .insert(aiFeedback)
    .values(feedbackPayload)
    .returning();

  return { historyId: createdHistory.id, feedbackId: createdFeedback.id };
}

async function loadCasesForMutation(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string,
  caseIds: string[]
) {
  if (isInMemoryTenantDb(tenantDb)) {
    return tenantDb.state.cases.filter(
      (item) => item.officeId === officeId && caseIds.includes(item.id)
    );
  }

  if (caseIds.length === 0) return [];
  return tenantDb
    .select()
    .from(aiDisconnectCases)
    .where(and(eq(aiDisconnectCases.officeId, officeId), inArray(aiDisconnectCases.id, caseIds)));
}

async function syncGeneratedTaskAssignment(
  tenantDb: TenantDb | InMemoryTenantDb,
  disconnectCase: DisconnectCaseRow,
  assignedTo: string,
  actor: { role: string; userId: string }
) {
  if (!disconnectCase.generatedTaskId) return;

  if (isInMemoryTenantDb(tenantDb)) {
    const task = tenantDb.state.tasks.find((item) => item.id === disconnectCase.generatedTaskId);
    if (task) task.assignedTo = assignedTo;
    return;
  }

  await updateTask(
    tenantDb,
    disconnectCase.generatedTaskId,
    { assignedTo },
    actor.role,
    actor.userId
  );
}

async function syncGeneratedTaskSnooze(
  tenantDb: TenantDb | InMemoryTenantDb,
  disconnectCase: DisconnectCaseRow,
  snoozedUntil: Date,
  actor: { role: string; userId: string }
) {
  if (!disconnectCase.generatedTaskId) return;

  if (isInMemoryTenantDb(tenantDb)) {
    const task = tenantDb.state.tasks.find((item) => item.id === disconnectCase.generatedTaskId);
    if (task) task.dueDate = snoozedUntil.toISOString().slice(0, 10);
    return;
  }

  await snoozeTask(
    tenantDb,
    disconnectCase.generatedTaskId,
    snoozedUntil.toISOString().slice(0, 10),
    actor.role,
    actor.userId
  );
}

const resolutionToTaskOutcome = {
  task_completed: "completed",
  follow_up_completed: "completed",
  owner_aligned: "dismissed",
  false_positive: "dismissed",
  duplicate_case: "dismissed",
  issue_no_longer_relevant: "dismissed",
} as const;

async function syncGeneratedTaskResolution(
  tenantDb: TenantDb | InMemoryTenantDb,
  disconnectCase: DisconnectCaseRow,
  resolutionReason: keyof typeof resolutionToTaskOutcome,
  actor: { role: string; userId: string }
) {
  if (!disconnectCase.generatedTaskId) return;

  const nextTaskStatus = resolutionToTaskOutcome[resolutionReason];
  if (isInMemoryTenantDb(tenantDb)) {
    const task = tenantDb.state.tasks.find((item) => item.id === disconnectCase.generatedTaskId);
    if (task) task.status = nextTaskStatus;
    return;
  }

  if (nextTaskStatus === "completed") {
    await completeTask(tenantDb, disconnectCase.generatedTaskId, actor.role, actor.userId);
    return;
  }

  await dismissTask(tenantDb, disconnectCase.generatedTaskId, actor.role, actor.userId);
}

export async function assignInterventionCases(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    caseIds: string[];
    assignedTo: string;
    actorUserId: string;
    actorRole: string;
    notes?: string | null;
  }
): Promise<MutationResult> {
  const rows = await loadCasesForMutation(tenantDb, input.officeId, input.caseIds);
  const errors: Array<{ caseId: string; message: string }> = [];

  for (const row of rows) {
    const fromAssignee = row.assignedTo ?? null;
    const actedAt = new Date();
    if (isInMemoryTenantDb(tenantDb)) {
      row.assignedTo = input.assignedTo;
      row.lastIntervenedAt = actedAt;
    } else {
      await tenantDb
        .update(aiDisconnectCases)
        .set({
          assignedTo: input.assignedTo,
          lastIntervenedAt: actedAt,
          updatedAt: actedAt,
        })
        .where(eq(aiDisconnectCases.id, row.id));
    }
    await syncGeneratedTaskAssignment(tenantDb, row, input.assignedTo, {
      role: input.actorRole,
      userId: input.actorUserId,
    });
    await writeMutationArtifacts(tenantDb, row, {
      actionType: "assign",
      actedBy: input.actorUserId,
      comment: input.notes ?? null,
      fromStatus: row.status,
      toStatus: row.status,
      fromAssignee,
      toAssignee: input.assignedTo,
    });
  }

  return {
    updatedCount: rows.length,
    skippedCount: input.caseIds.length - rows.length,
    errors,
  };
}

export async function snoozeInterventionCases(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    caseIds: string[];
    snoozedUntil: Date | string;
    actorUserId: string;
    actorRole: string;
    notes?: string | null;
  }
): Promise<MutationResult> {
  const snoozedUntil = input.snoozedUntil instanceof Date
    ? input.snoozedUntil
    : new Date(input.snoozedUntil);
  const rows = await loadCasesForMutation(tenantDb, input.officeId, input.caseIds);
  const errors: Array<{ caseId: string; message: string }> = [];

  for (const row of rows) {
    const fromStatus = row.status;
    const fromSnoozedUntil = row.snoozedUntil ?? null;
    const actedAt = new Date();
    if (isInMemoryTenantDb(tenantDb)) {
      row.status = "snoozed";
      row.snoozedUntil = snoozedUntil;
      row.lastIntervenedAt = actedAt;
    } else {
      await tenantDb
        .update(aiDisconnectCases)
        .set({
          status: "snoozed",
          snoozedUntil,
          lastIntervenedAt: actedAt,
          updatedAt: actedAt,
        })
        .where(eq(aiDisconnectCases.id, row.id));
    }
    await syncGeneratedTaskSnooze(tenantDb, row, snoozedUntil, {
      role: input.actorRole,
      userId: input.actorUserId,
    });
    await writeMutationArtifacts(tenantDb, row, {
      actionType: "snooze",
      actedBy: input.actorUserId,
      comment: input.notes ?? null,
      fromStatus,
      toStatus: "snoozed",
      fromAssignee: row.assignedTo ?? null,
      toAssignee: row.assignedTo ?? null,
      fromSnoozedUntil,
      toSnoozedUntil: snoozedUntil,
    });
  }

  return {
    updatedCount: rows.length,
    skippedCount: input.caseIds.length - rows.length,
    errors,
  };
}

export async function resolveInterventionCases(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    caseIds: string[];
    resolutionReason: keyof typeof resolutionToTaskOutcome;
    actorUserId: string;
    actorRole: string;
    notes?: string | null;
  }
): Promise<MutationResult> {
  const rows = await loadCasesForMutation(tenantDb, input.officeId, input.caseIds);
  const errors: Array<{ caseId: string; message: string }> = [];
  const taskOutcome = resolutionToTaskOutcome[input.resolutionReason];

  for (const row of rows) {
    const fromStatus = row.status;
    const actedAt = new Date();
    if (isInMemoryTenantDb(tenantDb)) {
      row.status = "resolved";
      row.resolutionReason = input.resolutionReason;
      row.resolvedAt = actedAt;
      row.snoozedUntil = null;
      row.lastIntervenedAt = actedAt;
    } else {
      await tenantDb
        .update(aiDisconnectCases)
        .set({
          status: "resolved",
          resolutionReason: input.resolutionReason,
          resolvedAt: actedAt,
          snoozedUntil: null,
          lastIntervenedAt: actedAt,
          updatedAt: actedAt,
        })
        .where(eq(aiDisconnectCases.id, row.id));
    }
    await syncGeneratedTaskResolution(tenantDb, row, input.resolutionReason, {
      role: input.actorRole,
      userId: input.actorUserId,
    });
    await writeMutationArtifacts(tenantDb, row, {
      actionType: "resolve",
      actedBy: input.actorUserId,
      comment: input.notes ?? null,
      fromStatus,
      toStatus: "resolved",
      fromAssignee: row.assignedTo ?? null,
      toAssignee: row.assignedTo ?? null,
      metadataJson: {
        resolutionReason: input.resolutionReason,
        taskOutcome,
      },
    });
  }

  return {
    updatedCount: rows.length,
    skippedCount: input.caseIds.length - rows.length,
    errors,
  };
}

export async function escalateInterventionCases(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    caseIds: string[];
    actorUserId: string;
    actorRole: string;
    notes?: string | null;
  }
): Promise<MutationResult> {
  const rows = await loadCasesForMutation(tenantDb, input.officeId, input.caseIds);
  const errors: Array<{ caseId: string; message: string }> = [];

  for (const row of rows) {
    const actedAt = new Date();
    if (isInMemoryTenantDb(tenantDb)) {
      row.escalated = true;
      row.lastIntervenedAt = actedAt;
    } else {
      await tenantDb
        .update(aiDisconnectCases)
        .set({
          escalated: true,
          lastIntervenedAt: actedAt,
          updatedAt: actedAt,
        })
        .where(eq(aiDisconnectCases.id, row.id));
    }
    await writeMutationArtifacts(tenantDb, row, {
      actionType: "escalate",
      actedBy: input.actorUserId,
      comment: input.notes ?? null,
      fromStatus: row.status,
      toStatus: row.status,
      fromAssignee: row.assignedTo ?? null,
      toAssignee: row.assignedTo ?? null,
      metadataJson: { escalated: true },
    });
  }

  return {
    updatedCount: rows.length,
    skippedCount: input.caseIds.length - rows.length,
    errors,
  };
}
