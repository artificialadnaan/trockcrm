import crypto from "crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  aiFeedback,
  aiCopilotPackets,
  aiDisconnectCaseHistory,
  aiDisconnectCases,
  companies,
  deals,
  tasks,
  users,
} from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import {
  getDisconnectCaseIdentity,
  listCurrentSalesProcessDisconnectRows,
  type SalesProcessDisconnectRow,
} from "./service.js";
import { getAiCopilotProvider } from "./provider.js";
import {
  RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES,
  SNOOZE_REASON_TO_EXPECTED_OPTIONS,
  ESCALATION_TARGET_TYPES,
  mapStructuredResolveReasonToLegacyResolutionReason,
} from "./intervention-outcome-taxonomy.js";
import type {
  InterventionAnalyticsBreachRow,
  InterventionAnalyticsDashboard,
  InterventionAnalyticsHotspotRow,
  InterventionCaseDetail,
  InterventionCopilotEvidenceItem,
  InterventionCopilotOwnerContext,
  InterventionCopilotPacketView,
  InterventionCopilotRecommendedAction,
  InterventionCopilotRiskFlag,
  InterventionCopilotRootCause,
  InterventionCopilotReopenRisk,
  InterventionCopilotSimilarCase,
  InterventionCopilotView,
  InterventionManagerBrief,
  InterventionOutcomeEffectiveness,
  InterventionQueueFilters,
  InterventionQueueItem,
  InterventionQueueResult,
  InterventionQueueView,
  StructuredEscalateConclusion,
  StructuredInterventionConclusion,
  StructuredResolveConclusion,
  StructuredSnoozeConclusion,
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
type AiCopilotPacketRow = typeof aiCopilotPackets.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type DealRow = typeof deals.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;
type UserRow = typeof users.$inferSelect;
type AiFeedbackRow = typeof aiFeedback.$inferSelect;

type InMemoryTenantDb = {
  state: {
    cases: DisconnectCaseRow[];
    tasks: TaskRow[];
    deals: Array<Pick<DealRow, "id" | "dealNumber" | "name" | "companyId">>;
    companies: Array<Pick<CompanyRow, "id" | "name">>;
    users?: Array<Pick<UserRow, "id" | "displayName">>;
    history: DisconnectCaseHistoryRow[];
    packets?: AiCopilotPacketRow[];
    feedback?: AiFeedbackRow[];
  };
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const INTERVENTION_SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-0000000000a1";

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

function interventionSlaThresholdDays(value: string) {
  switch (value) {
    case "critical":
      return 0;
    case "high":
      return 2;
    case "medium":
      return 5;
    case "low":
      return 10;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

function startOfDay(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function calculateBusinessDaysElapsed(startedAt: Date | null | undefined, now: Date) {
  if (!startedAt) return 0;
  const current = startOfDay(startedAt);
  const end = startOfDay(now);
  let elapsed = 0;

  while (current < end) {
    current.setDate(current.getDate() + 1);
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      elapsed++;
    }
  }

  return elapsed;
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
    stageKey: row.stageKey ?? null,
    stageName: row.stageName,
    assignedRepId: row.assignedRepId ?? null,
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
    currentLifecycleStartedAt: now,
    lastReopenedAt: null,
    metadataJson: buildCaseMetadata(row),
  };
}

function shouldReopenCase(existing: DisconnectCaseRow, now: Date) {
  if (existing.status === "resolved") return true;
  if (existing.status !== "snoozed") return false;
  if (!existing.snoozedUntil) return true;
  return existing.snoozedUntil <= now;
}

function getSystemActorUserId() {
  return INTERVENTION_SYSTEM_ACTOR_ID;
}

function buildReopenHistoryMetadata(input: {
  priorConclusionActionId: string;
  priorConclusionKind: "resolve" | "snooze" | "escalate";
  reopenReason: string;
  lifecycleStartedAt: string;
}) {
  return {
    priorConclusionActionId: input.priorConclusionActionId,
    priorConclusionKind: input.priorConclusionKind,
    reopenReason: input.reopenReason,
    lifecycleStartedAt: input.lifecycleStartedAt,
  };
}

function readHistoryConclusionKind(
  row: Pick<DisconnectCaseHistoryRow, "actionType" | "metadataJson">
): "resolve" | "snooze" | "escalate" {
  const kind = readHistoryMetadata(row).conclusion?.kind;
  if (kind === "resolve" || kind === "snooze" || kind === "escalate") return kind;

  if (row.actionType === "resolve" || row.actionType === "snooze" || row.actionType === "escalate") {
    return row.actionType;
  }

  return "resolve";
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

function readMetadataString(metadata: Record<string, unknown> | null | undefined, key: string) {
  if (!metadata || typeof metadata !== "object") return null;
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readMetadataDate(metadata: Record<string, unknown> | null | undefined, key: string) {
  const value = readMetadataString(metadata, key);
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveCaseAssigneeName(
  usersMap: Map<string, string>,
  assignedTo: string | null | undefined,
  metadataJson: Record<string, unknown> | null | undefined
) {
  return usersMap.get(assignedTo ?? "") ?? readMetadataString(metadataJson, "assignedRepName") ?? null;
}

function readHistoryMetadata(row: Pick<DisconnectCaseHistoryRow, "metadataJson">) {
  return (row.metadataJson ?? {}) as {
    conclusion?: {
      kind?: "resolve" | "snooze" | "escalate";
      outcomeCategory?: string;
      reasonCode?: string;
      effectiveness?: "confirmed" | "likely" | "unclear";
      snoozeReasonCode?: string;
      escalationReasonCode?: string;
      escalationTargetType?: string;
    } | null;
    priorConclusionActionId?: string;
    assigneeAtConclusion?: string | null;
    disconnectTypeAtConclusion?: string;
    lifecycleStartedAt?: string;
  };
}

function matchesQueueStatus(
  row: DisconnectCaseRow,
  input: { status?: "open" | "snoozed" | "resolved"; view?: InterventionQueueView; now: Date }
) {
  if (input.view === "overdue") {
    if (row.status !== "open") return false;
    return input.status ? row.status === input.status : true;
  }

  if (input.view === "snooze-breached") {
    if (row.status !== "snoozed") return false;
    if (!row.snoozedUntil || row.snoozedUntil > input.now) return false;
    return input.status ? row.status === input.status : true;
  }

  if (input.status) return row.status === input.status;
  if (row.status === "resolved") return false;
  if (row.status === "snoozed" && (!row.snoozedUntil || row.snoozedUntil > input.now)) return false;
  return true;
}

function matchesQueueFilters(row: DisconnectCaseRow, filters: InterventionQueueFilters | undefined) {
  if (!filters) return true;
  if (filters.severity && row.severity !== filters.severity) return false;
  if (filters.disconnectType && row.disconnectType !== filters.disconnectType) return false;
  if (filters.assigneeId && row.assignedTo !== filters.assigneeId) return false;
  if (filters.companyId && row.companyId !== filters.companyId) return false;
  if (filters.repId && readMetadataString(row.metadataJson as Record<string, unknown> | null, "assignedRepId") !== filters.repId) {
    return false;
  }
  if (filters.stageKey && readMetadataString(row.metadataJson as Record<string, unknown> | null, "stageKey") !== filters.stageKey) {
    return false;
  }
  return true;
}

function projectQueueItem(input: {
  row: DisconnectCaseRow;
  task: TaskRow | null;
  deal: Pick<DealRow, "id" | "dealNumber" | "name" | "companyId"> | null;
  company: Pick<CompanyRow, "id" | "name"> | null;
  history: DisconnectCaseHistoryRow | null;
  usersMap: Map<string, string>;
  now: Date;
}): InterventionQueueItem {
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
    reopenCount: input.row.reopenCount,
    ageDays: calculateBusinessDaysElapsed(input.row.currentLifecycleStartedAt, input.now),
    assignedTo: input.row.assignedTo,
    assignedToName: resolveCaseAssigneeName(
      input.usersMap,
      input.row.assignedTo,
      input.row.metadataJson as Record<string, unknown> | null
    ),
    generatedTask: input.task
      ? {
          id: input.task.id,
          status: input.task.status,
          assignedTo: input.task.assignedTo,
          assignedToName: input.usersMap.get(input.task.assignedTo ?? "") ?? null,
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
        const nextLifecycleStartedAt = now;
        await writeReopenedHistoryEvent(tenantDb, existing, nextLifecycleStartedAt);
        existing.status = "open";
        existing.reopenCount += 1;
        existing.currentLifecycleStartedAt = nextLifecycleStartedAt;
        existing.lastReopenedAt = nextLifecycleStartedAt;
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
    if (reopen) {
      await writeReopenedHistoryEvent(tenantDb, existing, now);
    }
    await tenantDb
      .update(aiDisconnectCases)
      .set({
        ...baseUpdate,
        status: reopen ? "open" : existing.status,
        snoozedUntil: reopen ? null : existing.snoozedUntil,
        resolvedAt: reopen ? null : existing.resolvedAt,
        resolutionReason: reopen ? null : existing.resolutionReason,
        reopenCount: reopen ? existing.reopenCount + 1 : existing.reopenCount,
        currentLifecycleStartedAt: reopen ? now : existing.currentLifecycleStartedAt,
        lastReopenedAt: reopen ? now : existing.lastReopenedAt,
      })
      .where(eq(aiDisconnectCases.id, existing.id));
  }

  return { caseCount: uniqueRows.length };
}

export async function listInterventionCases(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    status?: "open" | "snoozed" | "resolved";
    view?: InterventionQueueView;
    clusterKey?: string;
    filters?: InterventionQueueFilters;
    page?: number;
    pageSize?: number;
    now?: Date;
  }
): Promise<InterventionQueueResult> {
  const now = input.now ?? new Date();
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, Math.min(input.pageSize ?? 50, 200));

  if (isInMemoryTenantDb(tenantDb)) {
    let cases = tenantDb.state.cases.filter((row) => row.officeId === input.officeId);
    cases = cases
      .filter((row) => matchesQueueStatus(row, { status: input.status, view: input.view, now }))
      .filter((row) => matchesQueueFilters(row, input.filters));

    const latestHistoryByCase = new Map<string, DisconnectCaseHistoryRow>();
    for (const row of tenantDb.state.history.sort((a, b) => b.actedAt.getTime() - a.actedAt.getTime())) {
      if (!latestHistoryByCase.has(row.disconnectCaseId)) latestHistoryByCase.set(row.disconnectCaseId, row);
    }
    const usersMap = new Map((tenantDb.state.users ?? []).map((user) => [user.id, user.displayName]));

    const items = cases
      .map((row) =>
        projectQueueItem({
          row,
          task: tenantDb.state.tasks.find((task) => task.id === row.generatedTaskId) ?? null,
          deal: tenantDb.state.deals.find((deal) => deal.id === row.dealId) ?? null,
          company: tenantDb.state.companies.find((company) => company.id === row.companyId) ?? null,
          history: latestHistoryByCase.get(row.id) ?? null,
          usersMap,
          now,
        })
      )
      .filter((item) => matchesInterventionView(item, input.view))
      .filter((item) => !input.clusterKey || item.clusterKey === input.clusterKey)
      .sort(sortQueueItems);

    const paged = items.slice((page - 1) * pageSize, page * pageSize);
    return {
      items: paged,
      totalCount: items.length,
      page,
      pageSize,
    };
  }

  await materializeDisconnectCases(tenantDb, {
    officeId: input.officeId,
    now,
  });

  let cases = await getCasesByOffice(tenantDb, input.officeId);
  cases = cases
    .filter((row) => matchesQueueStatus(row, { status: input.status, view: input.view, now }))
    .filter((row) => matchesQueueFilters(row, input.filters));

  const taskIds = cases.map((row) => row.generatedTaskId).filter((value): value is string => Boolean(value));
  const dealIds = cases.map((row) => row.dealId).filter((value): value is string => Boolean(value));
  const companyIds = cases.map((row) => row.companyId).filter((value): value is string => Boolean(value));
  const assigneeIds = [...new Set(cases.map((row) => row.assignedTo).filter((value): value is string => Boolean(value)))];
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
  const taskAssigneeIds = taskRows.map((row) => row.assignedTo).filter((value): value is string => Boolean(value));
  const userIds = [...new Set([...assigneeIds, ...taskAssigneeIds])];
  const userRows = userIds.length
    ? await tenantDb.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, userIds))
    : [];

  const taskMap = new Map(taskRows.map((row) => [row.id, row]));
  const dealMap = new Map(dealRows.map((row) => [row.id, row]));
  const companyMap = new Map(companyRows.map((row) => [row.id, row]));
  const usersMap = new Map(userRows.map((row) => [row.id, row.displayName]));
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
        usersMap,
        now,
      })
    )
    .filter((item) => matchesInterventionView(item, input.view))
    .filter((item) => !input.clusterKey || item.clusterKey === input.clusterKey)
    .sort(sortQueueItems);

  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    totalCount: items.length,
    page,
    pageSize,
  };
}

function matchesInterventionView(item: InterventionQueueItem, view: InterventionQueueView | undefined) {
  if (!view) return true;

  switch (view) {
    case "all":
      return true;
    case "overdue":
      return item.status === "open" && item.ageDays > interventionSlaThresholdDays(item.severity);
    case "snooze-breached":
      return item.status === "snoozed";
    case "escalated":
      return item.escalated;
    case "unassigned":
      return !item.assignedTo;
    case "aging":
      return item.ageDays >= 7;
    case "repeat":
      return item.reopenCount > 0;
    case "generated-task-pending":
      return item.generatedTask !== null && item.generatedTask.status !== "completed" && item.generatedTask.status !== "dismissed";
    case "open":
    default:
      return item.status === "open";
  }
}

function buildSeverityCounts() {
  return {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  } satisfies Record<"critical" | "high" | "medium" | "low", number>;
}

function incrementSeverityCount(
  counts: Record<"critical" | "high" | "medium" | "low", number>,
  severity: string
) {
  if (severity === "critical" || severity === "high" || severity === "medium" || severity === "low") {
    counts[severity] += 1;
  }
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle] ?? null;
}

function formatAnalyticsLabel(value: string) {
  return value.replace(/_/g, " ");
}

function isOverdueDisconnectCase(row: DisconnectCaseRow, now: Date) {
  return row.status === "open" && calculateBusinessDaysElapsed(row.currentLifecycleStartedAt, now) > interventionSlaThresholdDays(row.severity);
}

function isSnoozeBreachedCase(row: DisconnectCaseRow, now: Date) {
  return row.status === "snoozed" && Boolean(row.snoozedUntil && row.snoozedUntil <= now);
}

function isRepeatOpenCase(row: DisconnectCaseRow) {
  return row.status === "open" && row.reopenCount > 0;
}

function isEscalatedOpenCase(row: DisconnectCaseRow) {
  return row.escalated && row.status !== "resolved";
}

function formatQueueLink(input: {
  view?: InterventionQueueView;
  caseId?: string;
  assigneeId?: string | null;
  disconnectType?: string | null;
  repId?: string | null;
  companyId?: string | null;
  stageKey?: string | null;
}) {
  const params = new URLSearchParams();
  if (input.view && input.view !== "open") params.set("view", input.view);
  if (input.assigneeId) params.set("assigneeId", input.assigneeId);
  if (input.disconnectType) params.set("disconnectType", input.disconnectType);
  if (input.repId) params.set("repId", input.repId);
  if (input.companyId) params.set("companyId", input.companyId);
  if (input.stageKey) params.set("stageKey", input.stageKey);
  if (input.caseId) params.set("caseId", input.caseId);
  const query = params.toString();
  return query ? `/admin/interventions?${query}` : "/admin/interventions";
}

async function loadInterventionAnalyticsData(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string,
  casesOverride?: DisconnectCaseRow[]
) {
  if (isInMemoryTenantDb(tenantDb)) {
    const scopedCases = casesOverride ?? tenantDb.state.cases.filter((row) => row.officeId === officeId);
    return {
      cases: scopedCases,
      deals: tenantDb.state.deals,
      companies: tenantDb.state.companies,
      users: tenantDb.state.users ?? [],
      history: tenantDb.state.history.filter((row) =>
        scopedCases.some((item) => item.id === row.disconnectCaseId)
      ),
    };
  }

  const cases = casesOverride ?? (await getCasesByOffice(tenantDb, officeId));
  const persistedCaseIds = cases
    .map((row) => row.id)
    .filter((value): value is string => UUID_PATTERN.test(value));
  const dealIds = cases.map((row) => row.dealId).filter((value): value is string => Boolean(value));
  const companyIds = cases.map((row) => row.companyId).filter((value): value is string => Boolean(value));
  const assigneeIds = [...new Set(cases.map((row) => row.assignedTo).filter((value): value is string => Boolean(value)))];
  const [dealRows, companyRows, userRows, historyRows] = await Promise.all([
    dealIds.length ? tenantDb.select().from(deals).where(inArray(deals.id, dealIds)) : Promise.resolve([]),
    companyIds.length ? tenantDb.select().from(companies).where(inArray(companies.id, companyIds)) : Promise.resolve([]),
    assigneeIds.length ? tenantDb.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, assigneeIds)) : Promise.resolve([]),
    persistedCaseIds.length
      ? tenantDb.select().from(aiDisconnectCaseHistory).where(inArray(aiDisconnectCaseHistory.disconnectCaseId, persistedCaseIds))
      : Promise.resolve([]),
  ]);

  return {
    cases,
    deals: dealRows,
    companies: companyRows,
    users: userRows,
    history: historyRows,
  };
}

async function buildAnalyticsPreviewCases(
  tenantDb: TenantDb,
  input: { officeId: string; now: Date }
) {
  const [existingCases, currentRows] = await Promise.all([
    getCasesByOffice(tenantDb, input.officeId),
    // `tenantDb` is already scoped to the active office schema by tenant middleware.
    listCurrentSalesProcessDisconnectRows(tenantDb, { limit: null }),
  ]);
  const existingByBusinessKey = new Map(existingCases.map((row) => [row.businessKey, row]));
  const previewCases: DisconnectCaseRow[] = [...existingCases];

  for (const row of currentRows) {
    const businessKey = buildBusinessKey(input.officeId, row);
    const existing = existingByBusinessKey.get(businessKey);
    if (!existing) {
      previewCases.push({
        id: `preview:${businessKey}`,
        ...buildCaseInsert(input.officeId, row, input.now),
        createdAt: input.now,
        updatedAt: input.now,
      } as DisconnectCaseRow);
      continue;
    }

    const reopen = shouldReopenCase(existing, input.now);
    const previewRow: DisconnectCaseRow = {
      ...existing,
      severity: row.disconnectSeverity,
      clusterKey: getDisconnectCaseIdentity(row).clusterKey,
      companyId: row.companyId,
      lastDetectedAt: input.now,
      metadataJson: buildCaseMetadata(row),
      updatedAt: input.now,
      status: reopen ? "open" : existing.status,
      snoozedUntil: reopen ? null : existing.snoozedUntil,
      resolvedAt: reopen ? null : existing.resolvedAt,
      resolutionReason: reopen ? null : existing.resolutionReason,
      reopenCount: reopen ? existing.reopenCount + 1 : existing.reopenCount,
      currentLifecycleStartedAt: reopen ? input.now : existing.currentLifecycleStartedAt,
      lastReopenedAt: reopen ? input.now : existing.lastReopenedAt,
    };

    const previewIndex = previewCases.findIndex((item) => item.id === existing.id);
    if (previewIndex >= 0) previewCases[previewIndex] = previewRow;
  }

  return previewCases;
}

function buildInterventionAnalyticsSummary(cases: DisconnectCaseRow[], now: Date) {
  const openCases = cases.filter((row) => row.status === "open");
  const overdueCases = openCases.filter((row) => isOverdueDisconnectCase(row, now));
  const escalatedCases = cases.filter((row) => isEscalatedOpenCase(row));
  const snoozeOverdueCases = cases.filter((row) => isSnoozeBreachedCase(row, now));
  const repeatOpenCases = openCases.filter((row) => isRepeatOpenCase(row));

  const openCasesBySeverity = buildSeverityCounts();
  const overdueCasesBySeverity = buildSeverityCounts();
  for (const row of openCases) incrementSeverityCount(openCasesBySeverity, row.severity);
  for (const row of overdueCases) incrementSeverityCount(overdueCasesBySeverity, row.severity);

  return {
    openCases: openCases.length,
    overdueCases: overdueCases.length,
    escalatedCases: escalatedCases.length,
    snoozeOverdueCases: snoozeOverdueCases.length,
    repeatOpenCases: repeatOpenCases.length,
    openCasesBySeverity,
    overdueCasesBySeverity,
  };
}

function buildInterventionAnalyticsOutcomes(
  cases: DisconnectCaseRow[],
  historyRows: DisconnectCaseHistoryRow[],
  now: Date
) {
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - 30);

  const recentHistory = historyRows.filter((row) => row.actedAt >= windowStart);
  const actionVolume30d = {
    assign: recentHistory.filter((row) => row.actionType === "assign").length,
    snooze: recentHistory.filter((row) => row.actionType === "snooze").length,
    resolve: recentHistory.filter((row) => row.actionType === "resolve").length,
    escalate: recentHistory.filter((row) => row.actionType === "escalate").length,
  };
  const recentResolutionCaseIds = new Set(
    recentHistory
      .filter((row) => row.actionType === "resolve")
      .map((row) => row.disconnectCaseId)
  );
  const casesById = new Map(cases.map((row) => [row.id, row]));
  const recentReopens = cases.filter(
    (row) =>
      Boolean(row.lastReopenedAt && row.lastReopenedAt >= windowStart) &&
      recentResolutionCaseIds.has(row.id) &&
      historyRows.some(
        (entry) =>
          entry.disconnectCaseId === row.id &&
          entry.actionType === "resolve" &&
          entry.actedAt < (row.lastReopenedAt as Date)
      )
  );
  const intervenedCaseIds = new Set(recentHistory.map((row) => row.disconnectCaseId));
  const openAges = cases
    .filter((row) => row.status === "open")
    .map((row) => calculateBusinessDaysElapsed(row.currentLifecycleStartedAt, now));
  const resolutionAges = recentHistory
    .filter((row) => row.actionType === "resolve")
    .map((entry) => {
      const lifecycleStartedAt =
        readMetadataDate(entry.metadataJson as Record<string, unknown> | null | undefined, "lifecycleStartedAt") ??
        (() => {
          const currentRow = casesById.get(entry.disconnectCaseId);
          if (!currentRow?.resolvedAt) return null;
          return currentRow.resolvedAt.getTime() === entry.actedAt.getTime() ? currentRow.currentLifecycleStartedAt : null;
        })();
      return lifecycleStartedAt ? calculateBusinessDaysElapsed(lifecycleStartedAt, entry.actedAt) : null;
    })
    .filter((value): value is number => value !== null);
  const clearanceDenominator = intervenedCaseIds.size;
  const reopenDenominator = recentResolutionCaseIds.size;

  return {
    clearanceRate30d: clearanceDenominator === 0 ? null : recentResolutionCaseIds.size / clearanceDenominator,
    reopenRate30d: reopenDenominator === 0 ? null : recentReopens.length / reopenDenominator,
    averageAgeOfOpenCases: average(openAges),
    medianAgeOfOpenCases: median(openAges),
    averageAgeToResolution: average(resolutionAges),
    actionVolume30d,
  };
}

function buildGroupedRate(
  rows: DisconnectCaseHistoryRow[],
  keyFor: (row: DisconnectCaseHistoryRow) => string,
  reopenedByActionId: Set<string>
) {
  const groups = new Map<string, DisconnectCaseHistoryRow[]>();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return [...groups.entries()].reduce<Record<string, number | null>>((acc, [key, group]) => {
    const reopened = group.filter((candidate) => reopenedByActionId.has(candidate.id));
    acc[key] = group.length === 0 ? null : reopened.length / group.length;
    return acc;
  }, {});
}

function buildGroupedRateTable(
  rows: DisconnectCaseHistoryRow[],
  keyFor: (row: DisconnectCaseHistoryRow) => string,
  reopenedByActionId: Set<string>
) {
  const rates = buildGroupedRate(rows, keyFor, reopenedByActionId);
  return Object.entries(rates).map(([key, rate]) => ({
    key,
    rate,
    count: rows.filter((row) => keyFor(row) === key).length,
  }));
}

function buildGroupedCountTable(
  rows: DisconnectCaseHistoryRow[],
  keyFor: (row: DisconnectCaseHistoryRow) => string
) {
  const groups = new Map<string, number>();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) continue;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return groups;
}

function buildConclusionMixByDisconnectType(rows: DisconnectCaseHistoryRow[]) {
  const keys = [...new Set(rows.map((row) => readHistoryMetadata(row).disconnectTypeAtConclusion ?? "").filter(Boolean))];
  return keys.map((key) => ({
    key,
    resolveCount: rows.filter((row) => readHistoryMetadata(row).disconnectTypeAtConclusion === key && readHistoryMetadata(row).conclusion?.kind === "resolve").length,
    snoozeCount: rows.filter((row) => readHistoryMetadata(row).disconnectTypeAtConclusion === key && readHistoryMetadata(row).conclusion?.kind === "snooze").length,
    escalateCount: rows.filter((row) => readHistoryMetadata(row).disconnectTypeAtConclusion === key && readHistoryMetadata(row).conclusion?.kind === "escalate").length,
  }));
}

function buildConclusionMixByActingUser(
  rows: DisconnectCaseHistoryRow[],
  usersMap: Map<string, string>
) {
  const userIds = [...new Set(rows.map((row) => row.actedBy).filter(Boolean))];
  return userIds.map((actorUserId) => ({
    actorUserId,
    actorName: usersMap.get(actorUserId) ?? null,
    resolveCount: rows.filter((row) => row.actedBy === actorUserId && readHistoryMetadata(row).conclusion?.kind === "resolve").length,
    snoozeCount: rows.filter((row) => row.actedBy === actorUserId && readHistoryMetadata(row).conclusion?.kind === "snooze").length,
    escalateCount: rows.filter((row) => row.actedBy === actorUserId && readHistoryMetadata(row).conclusion?.kind === "escalate").length,
  }));
}

function buildConclusionMixByAssigneeAtConclusion(
  rows: DisconnectCaseHistoryRow[],
  usersMap: Map<string, string>
) {
  const assigneeIds = [...new Set(rows.map((row) => readHistoryMetadata(row).assigneeAtConclusion ?? ""))];
  return assigneeIds.map((assigneeId) => ({
    assigneeId: assigneeId || null,
    assigneeName: assigneeId ? usersMap.get(assigneeId) ?? null : null,
    resolveCount: rows.filter((row) => (readHistoryMetadata(row).assigneeAtConclusion ?? "") === assigneeId && readHistoryMetadata(row).conclusion?.kind === "resolve").length,
    snoozeCount: rows.filter((row) => (readHistoryMetadata(row).assigneeAtConclusion ?? "") === assigneeId && readHistoryMetadata(row).conclusion?.kind === "snooze").length,
    escalateCount: rows.filter((row) => (readHistoryMetadata(row).assigneeAtConclusion ?? "") === assigneeId && readHistoryMetadata(row).conclusion?.kind === "escalate").length,
  }));
}

function computeMedianDaysToLinkedReopen(
  concludedRows: DisconnectCaseHistoryRow[],
  history: DisconnectCaseHistoryRow[],
  family: "resolve" | "snooze" | "escalate"
) {
  const reopenDurations = concludedRows
    .filter((row) => readHistoryMetadata(row).conclusion?.kind === family)
    .map((row) => {
      const reopen = history.find(
        (candidate) =>
          candidate.actionType === "reopened" &&
          readHistoryMetadata(candidate).priorConclusionActionId === row.id
      );
      if (!reopen) return null;
      return Math.floor(
        (new Date(String(reopen.actedAt)).getTime() - new Date(String(row.actedAt)).getTime()) /
          (1000 * 60 * 60 * 24)
      );
    })
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  if (reopenDurations.length === 0) return null;
  return reopenDurations[Math.floor(reopenDurations.length / 2)] ?? null;
}

function buildMedianDaysToReopenTable(
  concludedRows: DisconnectCaseHistoryRow[],
  history: DisconnectCaseHistoryRow[]
) {
  return (["resolve", "snooze", "escalate"] as const).map((key) => ({
    key,
    medianDays: computeMedianDaysToLinkedReopen(concludedRows, history, key),
  }));
}

function findLinkedReopen(
  history: DisconnectCaseHistoryRow[],
  conclusionActionId: string
) {
  return history.find(
    (candidate) =>
      candidate.actionType === "reopened" &&
      readHistoryMetadata(candidate).priorConclusionActionId === conclusionActionId
  );
}

function isDurablyClosedConclusion(
  row: DisconnectCaseHistoryRow,
  history: DisconnectCaseHistoryRow[],
  casesById: Map<string, DisconnectCaseRow>
) {
  if (findLinkedReopen(history, row.id)) return false;
  const currentRow = casesById.get(row.disconnectCaseId);
  if (!currentRow || currentRow.status !== "resolved" || !currentRow.resolvedAt) return false;
  if (currentRow.lastReopenedAt && currentRow.lastReopenedAt > row.actedAt) return false;
  return currentRow.resolvedAt >= row.actedAt;
}

function averageDaysToDurableClose(
  rows: DisconnectCaseHistoryRow[],
  history: DisconnectCaseHistoryRow[],
  casesById: Map<string, DisconnectCaseRow>
) {
  const durations = rows
    .filter((row) => isDurablyClosedConclusion(row, history, casesById))
    .map((row) => {
      const lifecycleStartedAt = readMetadataDate(row.metadataJson as Record<string, unknown> | null | undefined, "lifecycleStartedAt");
      const currentRow = casesById.get(row.disconnectCaseId);
      return lifecycleStartedAt && currentRow?.resolvedAt
        ? calculateBusinessDaysElapsed(lifecycleStartedAt, currentRow.resolvedAt)
        : null;
    })
    .filter((value): value is number => value !== null);

  return average(durations);
}

function medianDaysToReopen(rows: DisconnectCaseHistoryRow[], history: DisconnectCaseHistoryRow[]) {
  const durations = rows
    .map((row) => {
      const reopen = findLinkedReopen(history, row.id);
      return reopen ? calculateBusinessDaysElapsed(row.actedAt, reopen.actedAt) : null;
    })
    .filter((value): value is number => value !== null);

  return median(durations);
}

function buildConclusionFamilyQueueLink(family: "resolve" | "snooze" | "escalate", reopenedCount: number) {
  if (family === "escalate") return formatQueueLink({ view: "escalated" });
  if (family === "snooze") return formatQueueLink({ view: reopenedCount > 0 ? "repeat" : "snooze-breached" });
  return formatQueueLink({ view: reopenedCount > 0 ? "repeat" : "open" });
}

function buildBestEffortReasonQueueLink(
  family: "resolve" | "snooze" | "escalate",
  rows: DisconnectCaseHistoryRow[],
  history: DisconnectCaseHistoryRow[]
) {
  const sample = rows[0];
  const disconnectType = sample ? readHistoryMetadata(sample).disconnectTypeAtConclusion ?? null : null;
  const reopenedCount = rows.filter((row) => findLinkedReopen(history, row.id)).length;

  if (family === "escalate") {
    return formatQueueLink({ view: "escalated", disconnectType });
  }
  if (family === "snooze") {
    return formatQueueLink({ view: reopenedCount > 0 ? "repeat" : "snooze-breached", disconnectType });
  }
  return formatQueueLink({ view: reopenedCount > 0 ? "repeat" : "open", disconnectType });
}

function buildSummaryByConclusionFamily(
  concludedRows: DisconnectCaseHistoryRow[],
  history: DisconnectCaseHistoryRow[],
  reopenedByActionId: Set<string>,
  casesById: Map<string, DisconnectCaseRow>
) {
  return (["resolve", "snooze", "escalate"] as const)
    .map((key) => {
      const rows = concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === key);
      const durableCount = rows.filter((row) => isDurablyClosedConclusion(row, history, casesById)).length;
      const reopenedCount = rows.filter((row) => reopenedByActionId.has(row.id)).length;
      return {
        key,
        label: formatAnalyticsLabel(key),
        volume: rows.length,
        reopenRate: rows.length === 0 ? null : reopenedCount / rows.length,
        durableCloseRate: rows.length === 0 ? null : durableCount / rows.length,
        medianDaysToReopen: medianDaysToReopen(rows, history),
        averageDaysToDurableClose: averageDaysToDurableClose(rows, history, casesById),
        queueLink: buildConclusionFamilyQueueLink(key, reopenedCount),
      };
    })
    .filter((row) => row.volume > 0);
}

function buildPerformanceRows(
  rows: DisconnectCaseHistoryRow[],
  history: DisconnectCaseHistoryRow[],
  keyFor: (row: DisconnectCaseHistoryRow) => string,
  family: "resolve" | "snooze" | "escalate",
  casesById: Map<string, DisconnectCaseRow>
) {
  const groups = new Map<string, DisconnectCaseHistoryRow[]>();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const durableCount = group.filter((row) => isDurablyClosedConclusion(row, history, casesById)).length;
      const reopenedCount = group.filter((row) => findLinkedReopen(history, row.id)).length;
      return {
        key,
        label: formatAnalyticsLabel(key),
        volume: group.length,
        reopenRate: group.length === 0 ? null : reopenedCount / group.length,
        durableCloseRate: group.length === 0 ? null : durableCount / group.length,
        medianDaysToReopen: medianDaysToReopen(group, history),
        averageDaysToDurableClose: averageDaysToDurableClose(group, history, casesById),
        queueLink: buildBestEffortReasonQueueLink(family, group, history),
      };
    })
    .sort((a, b) => {
      if (b.volume !== a.volume) return b.volume - a.volume;
      return a.label.localeCompare(b.label);
    });
}

function buildDisconnectTypeInteractions(
  concludedRows: DisconnectCaseHistoryRow[],
  history: DisconnectCaseHistoryRow[],
  casesById: Map<string, DisconnectCaseRow>
) {
  const groups = new Map<string, DisconnectCaseHistoryRow[]>();
  for (const row of concludedRows) {
    const family = readHistoryMetadata(row).conclusion?.kind;
    const disconnectType = readHistoryMetadata(row).disconnectTypeAtConclusion;
    if (!family || !disconnectType) continue;
    const key = `${disconnectType}::${family}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const [disconnectType, conclusionFamily] = key.split("::") as [string, "resolve" | "snooze" | "escalate"];
      const durableCount = group.filter((row) => isDurablyClosedConclusion(row, history, casesById)).length;
      const reopenedCount = group.filter((row) => findLinkedReopen(history, row.id)).length;
      return {
        disconnectType,
        conclusionFamily,
        volume: group.length,
        reopenRate: group.length === 0 ? null : reopenedCount / group.length,
        durableCloseRate: group.length === 0 ? null : durableCount / group.length,
        queueLink:
          conclusionFamily === "escalate"
            ? formatQueueLink({ view: "escalated", disconnectType })
            : formatQueueLink({ view: reopenedCount > 0 ? "repeat" : "open", disconnectType }),
      };
    })
    .sort((a, b) => {
      if (b.volume !== a.volume) return b.volume - a.volume;
      return a.disconnectType.localeCompare(b.disconnectType);
    });
}

function buildAssigneeEffectiveness(
  concludedRows: DisconnectCaseHistoryRow[],
  history: DisconnectCaseHistoryRow[],
  usersMap: Map<string, string>,
  casesById: Map<string, DisconnectCaseRow>
) {
  const groups = new Map<string, DisconnectCaseHistoryRow[]>();
  for (const row of concludedRows) {
    const key = readHistoryMetadata(row).assigneeAtConclusion ?? "";
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([assigneeId, group]) => {
      const durableCount = group.filter((row) => isDurablyClosedConclusion(row, history, casesById)).length;
      const reopenedCount = group.filter((row) => findLinkedReopen(history, row.id)).length;
      return {
        assigneeId: assigneeId || null,
        assigneeName: assigneeId ? usersMap.get(assigneeId) ?? null : null,
        volume: group.length,
        resolveCount: group.filter((row) => readHistoryMetadata(row).conclusion?.kind === "resolve").length,
        snoozeCount: group.filter((row) => readHistoryMetadata(row).conclusion?.kind === "snooze").length,
        escalateCount: group.filter((row) => readHistoryMetadata(row).conclusion?.kind === "escalate").length,
        reopenRate: group.length === 0 ? null : reopenedCount / group.length,
        durableCloseRate: group.length === 0 ? null : durableCount / group.length,
        queueLink: assigneeId ? formatQueueLink({ view: "open", assigneeId }) : null,
      };
    })
    .sort((a, b) => {
      if (b.volume !== a.volume) return b.volume - a.volume;
      return (a.assigneeName ?? a.assigneeId ?? "").localeCompare(b.assigneeName ?? b.assigneeId ?? "");
    });
}

function buildOutcomeWarnings(
  concludedRows: DisconnectCaseHistoryRow[],
  history: DisconnectCaseHistoryRow[],
  casesById: Map<string, DisconnectCaseRow>
): InterventionOutcomeEffectiveness["warnings"] {
  const warnings: InterventionOutcomeEffectiveness["warnings"] = [];
  const snoozeRows = buildPerformanceRows(
    concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === "snooze"),
    history,
    (row) => String(readHistoryMetadata(row).conclusion?.snoozeReasonCode ?? ""),
    "snooze",
    casesById
  );
  for (const row of snoozeRows) {
    if (row.reopenRate !== null && row.reopenRate >= 0.35) {
      warnings.push({
        kind: "snooze_reopen_risk",
        key: row.key,
        label: row.label,
        volume: row.volume,
        rate: row.reopenRate,
        queueLink: row.queueLink,
      });
    }
  }

  const escalationReasonRows = buildPerformanceRows(
    concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === "escalate"),
    history,
    (row) => String(readHistoryMetadata(row).conclusion?.escalationReasonCode ?? ""),
    "escalate",
    casesById
  );
  for (const row of escalationReasonRows) {
    if (row.durableCloseRate !== null && row.durableCloseRate <= 0.4) {
      warnings.push({
        kind: "escalation_reason_weak_close_through",
        key: row.key,
        label: row.label,
        volume: row.volume,
        rate: row.durableCloseRate,
        queueLink: row.queueLink,
      });
    }
  }

  const escalationTargetRows = buildPerformanceRows(
    concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === "escalate"),
    history,
    (row) => String(readHistoryMetadata(row).conclusion?.escalationTargetType ?? ""),
    "escalate",
    casesById
  );
  for (const row of escalationTargetRows) {
    if (row.durableCloseRate !== null && row.durableCloseRate <= 0.4) {
      warnings.push({
        kind: "escalation_target_weak_close_through",
        key: row.key,
        label: row.label,
        volume: row.volume,
        rate: row.durableCloseRate,
        queueLink: row.queueLink,
      });
    }
  }

  const administrativeGroups = buildGroupedCountTable(
    concludedRows.filter(
      (row) =>
        readHistoryMetadata(row).conclusion?.kind === "resolve" &&
        readHistoryMetadata(row).conclusion?.effectiveness === "unclear"
    ),
    (row) => String(readHistoryMetadata(row).disconnectTypeAtConclusion ?? "")
  );

  for (const [key, volume] of administrativeGroups.entries()) {
    warnings.push({
      kind: "administrative_close_pattern",
      key,
      label: formatAnalyticsLabel(key),
      volume,
      rate: null,
      queueLink: formatQueueLink({ view: "open", disconnectType: key }),
    });
  }

  return warnings.sort((a, b) => {
    if (b.volume !== a.volume) return b.volume - a.volume;
    return a.label.localeCompare(b.label);
  });
}

function buildInterventionOutcomeEffectiveness(
  history: DisconnectCaseHistoryRow[],
  usersMap: Map<string, string>,
  cases: DisconnectCaseRow[],
  now: Date
): InterventionOutcomeEffectiveness {
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - 30);
  const recentHistory = history.filter((row) => row.actedAt >= windowStart);
  const concludedRows = recentHistory.filter((row) => Boolean(readHistoryMetadata(row).conclusion?.kind));
  const casesById = new Map(cases.map((row) => [row.id, row]));
  const reopenedByActionId = new Set(
    recentHistory
      .filter((row) => row.actionType === "reopened")
      .map((row) => String(readHistoryMetadata(row).priorConclusionActionId ?? ""))
      .filter(Boolean)
  );

  const baseRates = buildGroupedRate(
    concludedRows,
    (row) => String(readHistoryMetadata(row).conclusion?.kind ?? ""),
    reopenedByActionId
  );

  return {
    summaryByConclusionFamily: buildSummaryByConclusionFamily(concludedRows, recentHistory, reopenedByActionId, casesById),
    resolveReasonPerformance: buildPerformanceRows(
      concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === "resolve"),
      recentHistory,
      (row) => String(readHistoryMetadata(row).conclusion?.reasonCode ?? ""),
      "resolve",
      casesById
    ),
    snoozeReasonPerformance: buildPerformanceRows(
      concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === "snooze"),
      recentHistory,
      (row) => String(readHistoryMetadata(row).conclusion?.snoozeReasonCode ?? ""),
      "snooze",
      casesById
    ),
    escalationReasonPerformance: buildPerformanceRows(
      concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === "escalate"),
      recentHistory,
      (row) => String(readHistoryMetadata(row).conclusion?.escalationReasonCode ?? ""),
      "escalate",
      casesById
    ),
    escalationTargetPerformance: buildPerformanceRows(
      concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === "escalate"),
      recentHistory,
      (row) => String(readHistoryMetadata(row).conclusion?.escalationTargetType ?? ""),
      "escalate",
      casesById
    ),
    disconnectTypeInteractions: buildDisconnectTypeInteractions(concludedRows, recentHistory, casesById),
    assigneeEffectiveness: buildAssigneeEffectiveness(concludedRows, recentHistory, usersMap, casesById),
    warnings: buildOutcomeWarnings(concludedRows, recentHistory, casesById),
    reopenRateByConclusionFamily: {
      resolve: baseRates.resolve ?? null,
      snooze: baseRates.snooze ?? null,
      escalate: baseRates.escalate ?? null,
    },
    reopenRateByResolveCategory: buildGroupedRateTable(
      concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === "resolve"),
      (row) => String(readHistoryMetadata(row).conclusion?.outcomeCategory ?? ""),
      reopenedByActionId
    ),
    reopenRateBySnoozeReason: buildGroupedRateTable(
      concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === "snooze"),
      (row) => String(readHistoryMetadata(row).conclusion?.snoozeReasonCode ?? ""),
      reopenedByActionId
    ),
    reopenRateByEscalationReason: buildGroupedRateTable(
      concludedRows.filter((row) => readHistoryMetadata(row).conclusion?.kind === "escalate"),
      (row) => String(readHistoryMetadata(row).conclusion?.escalationReasonCode ?? ""),
      reopenedByActionId
    ),
    conclusionMixByDisconnectType: buildConclusionMixByDisconnectType(concludedRows),
    conclusionMixByActingUser: buildConclusionMixByActingUser(concludedRows, usersMap),
    conclusionMixByAssigneeAtConclusion: buildConclusionMixByAssigneeAtConclusion(concludedRows, usersMap),
    medianDaysToReopenByConclusionFamily: buildMedianDaysToReopenTable(concludedRows, recentHistory),
  };
}

function isAllowedManagerBriefQueueLink(value: string) {
  if (
    value === "/admin/intervention-analytics#queue-health" ||
    value === "/admin/intervention-analytics#manager-alerts" ||
    value === "/admin/intervention-analytics#outcome-effectiveness" ||
    value === "/admin/intervention-analytics#policy-recommendations"
  ) {
    return true;
  }

  if (!value.startsWith("/admin/interventions?")) return false;
  const search = value.split("?")[1] ?? "";
  const params = new URLSearchParams(search);
  const view = params.get("view");
  const caseId = params.get("caseId");

  if (caseId) return false;
  const keys = [...params.keys()];
  const allowedKeys = new Set(["view", "assigneeId", "disconnectType", "stageKey", "companyId", "repId"]);
  if (keys.some((key) => !allowedKeys.has(key))) return false;
  if (![...params.values()].some(Boolean) && keys.length === 0) return false;

  if (!view) return keys.length === 0;
  if (!["overdue", "escalated", "snooze-breached", "repeat", "generated-task-pending", "all"].includes(view)) {
    return false;
  }

  return true;
}

function sanitizeManagerBriefQueueLink(value: string | null | undefined) {
  if (!value) return null;
  return isAllowedManagerBriefQueueLink(value) ? value : null;
}

function countHistoryRowsInWindow(
  history: DisconnectCaseHistoryRow[],
  actionType: string,
  range: { start: Date; end: Date }
) {
  return history.filter((row) => row.actionType === actionType && row.actedAt >= range.start && row.actedAt < range.end).length;
}

function buildManagerBrief(
  history: DisconnectCaseHistoryRow[],
  cases: DisconnectCaseRow[],
  usersMap: Map<string, string>,
  now: Date
): InterventionManagerBrief {
  const currentWindowEnd = new Date(now);
  const currentWindowStart = new Date(now);
  currentWindowStart.setDate(currentWindowStart.getDate() - 7);
  const priorWindowStart = new Date(currentWindowStart);
  priorWindowStart.setDate(priorWindowStart.getDate() - 7);
  const currentWindow = { start: currentWindowStart, end: currentWindowEnd };
  const priorWindow = { start: priorWindowStart, end: currentWindowStart };

  const summary = buildInterventionAnalyticsSummary(cases, now);
  const outcomeEffectiveness = buildInterventionOutcomeEffectiveness(history, usersMap, cases, now);
  const hotspots = {
    assignees: buildHotspotRows(cases, now, {
      entityType: "assignee",
      keyFromCase: (row) => row.assignedTo,
      labelFromCase: (row) => usersMap.get(row.assignedTo ?? "") ?? row.assignedTo ?? "Unassigned",
      queueLinkFromCase: (row) => formatQueueLink({ view: "all", assigneeId: row.assignedTo ?? null }),
    }),
    disconnectTypes: buildHotspotRows(cases, now, {
      entityType: "disconnect_type",
      keyFromCase: (row) => row.disconnectType,
      labelFromCase: (row) => row.disconnectType,
      queueLinkFromCase: (row) => formatQueueLink({ view: "all", disconnectType: row.disconnectType }),
    }),
  };

  const currentEscalations = countHistoryRowsInWindow(history, "escalate", currentWindow);
  const priorEscalations = countHistoryRowsInWindow(history, "escalate", priorWindow);
  const currentReopens = countHistoryRowsInWindow(history, "reopened", currentWindow);
  const priorReopens = countHistoryRowsInWindow(history, "reopened", priorWindow);
  const currentResolves = countHistoryRowsInWindow(history, "resolve", currentWindow);
  const priorResolves = countHistoryRowsInWindow(history, "resolve", priorWindow);

  const headlineParts: string[] = [];
  if (summary.overdueCases > 0) headlineParts.push(`${summary.overdueCases} overdue`);
  if (summary.escalatedCases > 0) headlineParts.push(`${summary.escalatedCases} escalated-open`);
  if (summary.snoozeOverdueCases > 0) headlineParts.push(`${summary.snoozeOverdueCases} snooze-breached`);
  const headline =
    headlineParts.length > 0
      ? `Intervention pressure is concentrated in ${headlineParts.join(", ")} cases.`
      : "No strong manager brief is available yet.";

  const whatChanged: InterventionManagerBrief["whatChanged"] = [];
  if (currentEscalations > priorEscalations) {
    whatChanged.push({
      key: "escalations_up",
      tone: "worsened",
      text: `Escalations rose to ${currentEscalations} in the last 7 days from ${priorEscalations} in the prior 7 days.`,
      queueLink: sanitizeManagerBriefQueueLink("/admin/interventions?view=escalated"),
    });
  }
  if (currentReopens > priorReopens) {
    whatChanged.push({
      key: "reopens_up",
      tone: "worsened",
      text: `Repeat-open pressure increased to ${currentReopens} reopened cases from ${priorReopens} in the prior week.`,
      queueLink: sanitizeManagerBriefQueueLink("/admin/interventions?view=repeat"),
    });
  }
  if (currentResolves > priorResolves) {
    whatChanged.push({
      key: "resolves_up",
      tone: "improved",
      text: `Durable closure activity improved with ${currentResolves} resolve actions versus ${priorResolves} in the prior week.`,
      queueLink: sanitizeManagerBriefQueueLink("/admin/intervention-analytics#outcome-effectiveness"),
    });
  }
  if (summary.snoozeOverdueCases > 0 && currentReopens <= priorReopens) {
    whatChanged.push({
      key: "snooze_watch",
      tone: "watch",
      text: `${summary.snoozeOverdueCases} snoozed cases are already past due and need active follow-through.`,
      queueLink: sanitizeManagerBriefQueueLink("/admin/interventions?view=snooze-breached"),
    });
  }

  const focusNow: InterventionManagerBrief["focusNow"] = [];
  if (summary.overdueCases > 0) {
    focusNow.push({
      key: "focus_overdue",
      priority: "high",
      text: `Clear ${summary.overdueCases} overdue case${summary.overdueCases === 1 ? "" : "s"} before they roll into more escalations.`,
      queueLink: sanitizeManagerBriefQueueLink("/admin/interventions?view=overdue"),
    });
  }
  if (summary.escalatedCases > 0) {
    focusNow.push({
      key: "focus_escalated",
      priority: "high",
      text: `Review ${summary.escalatedCases} escalated-open case${summary.escalatedCases === 1 ? "" : "s"} for direct manager intervention.`,
      queueLink: sanitizeManagerBriefQueueLink("/admin/interventions?view=escalated"),
    });
  }
  const topAssignee = hotspots.assignees[0];
  if (topAssignee?.queueLink && topAssignee.openCases > 0) {
    focusNow.push({
      key: "focus_assignee_load",
      priority: topAssignee.overdueCases > 0 ? "high" : "medium",
      text: `${topAssignee.label} is carrying ${topAssignee.openCases} open cases, including ${topAssignee.overdueCases} overdue.`,
      queueLink: sanitizeManagerBriefQueueLink(topAssignee.queueLink),
    });
  }
  const topDisconnectType = hotspots.disconnectTypes[0];
  if (topDisconnectType?.queueLink && topDisconnectType.openCases > 0) {
    focusNow.push({
      key: "focus_disconnect_type",
      priority: "medium",
      text: `${topDisconnectType.label} is the heaviest open disconnect type at ${topDisconnectType.openCases} cases.`,
      queueLink: sanitizeManagerBriefQueueLink(topDisconnectType.queueLink),
    });
  }

  const emergingPatterns: InterventionManagerBrief["emergingPatterns"] = [];
  const highestReopenFamily = Object.entries(outcomeEffectiveness.reopenRateByConclusionFamily)
    .filter((entry): entry is ["resolve" | "snooze" | "escalate", number] => typeof entry[1] === "number")
    .sort((a, b) => b[1] - a[1])[0];
  if (highestReopenFamily && highestReopenFamily[1] >= 0.25) {
    emergingPatterns.push({
      key: `family_${highestReopenFamily[0]}`,
      title: `${highestReopenFamily[0][0].toUpperCase()}${highestReopenFamily[0].slice(1)} outcomes are reopening`,
      summary: `${Math.round(highestReopenFamily[1] * 100)}% of recent ${highestReopenFamily[0]} conclusions reopened inside the 30-day window.`,
      confidence: highestReopenFamily[1] >= 0.4 ? "high" : "medium",
      queueLink: sanitizeManagerBriefQueueLink("/admin/intervention-analytics#outcome-effectiveness"),
    });
  }
  for (const warning of outcomeEffectiveness.warnings.slice(0, 2)) {
    emergingPatterns.push({
      key: `warning_${warning.kind}_${warning.key}`,
      title: warning.label,
      summary: `${warning.volume} recent conclusions are showing a ${Math.round((warning.rate ?? 0) * 100)}% weak-close/reopen signal.`,
      confidence: (warning.rate ?? 0) >= 0.4 ? "high" : "medium",
      queueLink: sanitizeManagerBriefQueueLink(warning.queueLink),
    });
  }
  if (emergingPatterns.length === 0 && topDisconnectType?.openCases > 0) {
    emergingPatterns.push({
      key: "pattern_top_disconnect_type",
      title: `${topDisconnectType.label} is dominating intervention load`,
      summary: `${topDisconnectType.openCases} open cases are concentrated in the ${topDisconnectType.label} disconnect family.`,
      confidence: topDisconnectType.overdueCases > 0 ? "high" : "medium",
      queueLink: sanitizeManagerBriefQueueLink(topDisconnectType.queueLink),
    });
  }

  return {
    headline,
    summaryWindowLabel: "Compared with the prior 7 days",
    whatChanged: whatChanged.slice(0, 4),
    focusNow: focusNow.slice(0, 4),
    emergingPatterns: emergingPatterns.slice(0, 3),
    groundingNote:
      "Grounded in current intervention analytics, recent intervention history, queue pressure, and outcome-effectiveness trends.",
    error: null,
  };
}

export function buildManagerBriefSafely(
  history: DisconnectCaseHistoryRow[],
  cases: DisconnectCaseRow[],
  usersMap: Map<string, string>,
  now: Date,
  builder: (
    history: DisconnectCaseHistoryRow[],
    cases: DisconnectCaseRow[],
    usersMap: Map<string, string>,
    now: Date
  ) => InterventionManagerBrief = buildManagerBrief
): InterventionManagerBrief {
  try {
    return builder(history, cases, usersMap, now);
  } catch {
    return {
      headline: "No strong manager brief is available yet.",
      summaryWindowLabel: "Compared with the prior 7 days",
      whatChanged: [],
      focusNow: [],
      emergingPatterns: [],
      groundingNote: "Manager brief unavailable. Continue monitoring queue health and outcome trends.",
      error: "Failed to build manager brief",
    };
  }
}

function buildHotspotRows(
  cases: DisconnectCaseRow[],
  now: Date,
  input: {
    entityType: InterventionAnalyticsHotspotRow["entityType"];
    keyFromCase: (row: DisconnectCaseRow) => string | null;
    labelFromCase: (row: DisconnectCaseRow) => string;
    queueLinkFromCase: (row: DisconnectCaseRow) => string | null;
  }
): InterventionAnalyticsHotspotRow[] {
  const groups = new Map<string, { sample: DisconnectCaseRow; openCases: number; overdueCases: number; repeatOpenCases: number }>();

  for (const row of cases) {
    const key = input.keyFromCase(row);
    if (!key) continue;
    const existing = groups.get(key) ?? {
      sample: row,
      openCases: 0,
      overdueCases: 0,
      repeatOpenCases: 0,
    };
    if (row.status === "open") existing.openCases += 1;
    if (isOverdueDisconnectCase(row, now)) existing.overdueCases += 1;
    if (isRepeatOpenCase(row)) existing.repeatOpenCases += 1;
    groups.set(key, existing);
  }

  return [...groups.entries()]
    .map(([key, value]) => ({
      key,
      entityType: input.entityType,
      filterValue: key,
      label: input.labelFromCase(value.sample),
      openCases: value.openCases,
      overdueCases: value.overdueCases,
      repeatOpenCases: value.repeatOpenCases,
      clearanceRate30d: null,
      queueLink: input.queueLinkFromCase(value.sample),
    }))
    .filter((row) => row.openCases > 0 || row.overdueCases > 0 || row.repeatOpenCases > 0)
    .sort((a, b) => {
      if (b.overdueCases !== a.overdueCases) return b.overdueCases - a.overdueCases;
      if (b.openCases !== a.openCases) return b.openCases - a.openCases;
      return a.label.localeCompare(b.label);
    })
    .slice(0, 10);
}

function buildInterventionAnalyticsBreachQueue(
  cases: DisconnectCaseRow[],
  dealsMap: Map<string, Pick<DealRow, "id" | "dealNumber" | "name" | "companyId">>,
  companiesMap: Map<string, Pick<CompanyRow, "id" | "name">>,
  usersMap: Map<string, string>,
  now: Date
) {
  const items = cases
    .map((row) => {
      const breachReasons: InterventionAnalyticsBreachRow["breachReasons"] = [];
      if (isOverdueDisconnectCase(row, now)) breachReasons.push("overdue");
      if (isEscalatedOpenCase(row)) breachReasons.push("escalated_open");
      if (isSnoozeBreachedCase(row, now)) breachReasons.push("snooze_breached");
      if (isRepeatOpenCase(row)) breachReasons.push("repeat_open");
      if (breachReasons.length === 0) return null;

      const deal = row.dealId ? dealsMap.get(row.dealId) ?? null : null;
      const company = row.companyId ? companiesMap.get(row.companyId) ?? null : null;
      const primaryView: InterventionQueueView =
        breachReasons[0] === "snooze_breached"
          ? "snooze-breached"
          : breachReasons[0] === "repeat_open"
            ? "repeat"
            : breachReasons[0] === "escalated_open"
              ? "escalated"
              : "overdue";

      return {
        caseId: row.id,
        severity: row.severity,
        disconnectType: row.disconnectType,
        dealId: row.dealId,
        dealLabel: deal ? `${deal.dealNumber} ${deal.name}` : readMetadataString(row.metadataJson as Record<string, unknown> | null, "dealName"),
        companyId: row.companyId,
        companyLabel: company?.name ?? readMetadataString(row.metadataJson as Record<string, unknown> | null, "companyName"),
        ageDays: calculateBusinessDaysElapsed(row.currentLifecycleStartedAt, now),
        assignedTo: usersMap.get(row.assignedTo ?? "") ?? row.assignedTo,
        escalated: row.escalated,
        breachReasons,
        detailLink: formatQueueLink({ view: primaryView, caseId: row.id }),
        queueLink: formatQueueLink({ view: primaryView, caseId: row.id }),
      } satisfies InterventionAnalyticsBreachRow;
    })
    .filter((item): item is InterventionAnalyticsBreachRow => item !== null)
    .sort((a, b) => {
      const severityDelta = severityRank(b.severity) - severityRank(a.severity);
      if (severityDelta !== 0) return severityDelta;
      if (b.ageDays !== a.ageDays) return b.ageDays - a.ageDays;
      if (a.escalated !== b.escalated) return a.escalated ? -1 : 1;
      return (a.dealLabel ?? a.companyLabel ?? a.caseId).localeCompare(b.dealLabel ?? b.companyLabel ?? b.caseId);
    });

  return {
    items: items.slice(0, 25),
    totalCount: items.length,
    pageSize: 25,
  };
}

export async function getInterventionAnalyticsDashboard(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: { officeId: string; now?: Date }
): Promise<InterventionAnalyticsDashboard> {
  const now = input.now ?? new Date();
  const previewCases =
    isInMemoryTenantDb(tenantDb) ? undefined : await buildAnalyticsPreviewCases(tenantDb, { officeId: input.officeId, now });

  const { cases, deals: dealRows, companies: companyRows, users: userRows, history } = await loadInterventionAnalyticsData(
    tenantDb,
    input.officeId,
    previewCases
  );
  const dealsMap = new Map(dealRows.map((row) => [row.id, row]));
  const companiesMap = new Map(companyRows.map((row) => [row.id, row]));
  const usersMap = new Map(userRows.map((row) => [row.id, row.displayName]));

  return {
    summary: buildInterventionAnalyticsSummary(cases, now),
    outcomes: buildInterventionAnalyticsOutcomes(cases, history, now),
    managerBrief: buildManagerBriefSafely(history, cases, usersMap, now),
    outcomeEffectiveness: buildInterventionOutcomeEffectiveness(history, usersMap, cases, now),
    hotspots: {
      assignees: buildHotspotRows(cases, now, {
        entityType: "assignee",
        keyFromCase: (row) => row.assignedTo,
        labelFromCase: (row) => usersMap.get(row.assignedTo ?? "") ?? row.assignedTo ?? "Unassigned",
        queueLinkFromCase: (row) => formatQueueLink({ view: "open", assigneeId: row.assignedTo ?? null }),
      }),
      disconnectTypes: buildHotspotRows(cases, now, {
        entityType: "disconnect_type",
        keyFromCase: (row) => row.disconnectType,
        labelFromCase: (row) => row.disconnectType,
        queueLinkFromCase: (row) => formatQueueLink({ view: "open", disconnectType: row.disconnectType }),
      }),
      reps: buildHotspotRows(cases, now, {
        entityType: "rep",
        keyFromCase: (row) => readMetadataString(row.metadataJson as Record<string, unknown> | null, "assignedRepId"),
        labelFromCase: (row) =>
          readMetadataString(row.metadataJson as Record<string, unknown> | null, "assignedRepName") ?? "Unknown rep",
        queueLinkFromCase: (row) =>
          formatQueueLink({ view: "open", repId: readMetadataString(row.metadataJson as Record<string, unknown> | null, "assignedRepId") }),
      }),
      companies: buildHotspotRows(cases, now, {
        entityType: "company",
        keyFromCase: (row) => row.companyId,
        labelFromCase: (row) =>
          companiesMap.get(row.companyId ?? "")?.name ??
          readMetadataString(row.metadataJson as Record<string, unknown> | null, "companyName") ??
          "Unknown company",
        queueLinkFromCase: (row) => formatQueueLink({ view: "open", companyId: row.companyId }),
      }),
      stages: buildHotspotRows(cases, now, {
        entityType: "stage",
        keyFromCase: (row) => readMetadataString(row.metadataJson as Record<string, unknown> | null, "stageKey"),
        labelFromCase: (row) =>
          readMetadataString(row.metadataJson as Record<string, unknown> | null, "stageName") ?? "Unknown stage",
        queueLinkFromCase: (row) =>
          formatQueueLink({ view: "open", stageKey: readMetadataString(row.metadataJson as Record<string, unknown> | null, "stageKey") }),
      }),
    },
    breachQueue: buildInterventionAnalyticsBreachQueue(cases, dealsMap, companiesMap, usersMap, now),
    slaRules: {
      criticalDays: 0,
      highDays: 2,
      mediumDays: 5,
      lowDays: 10,
      timingBasis: "business_days",
    },
  };
}

export async function getInterventionCaseDetail(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: { officeId: string; caseId: string }
): Promise<InterventionCaseDetail> {
  if (isInMemoryTenantDb(tenantDb)) {
    const row = tenantDb.state.cases.find((item) => item.officeId === input.officeId && item.id === input.caseId);
    if (!row) {
      throw new AppError(404, "Intervention case not found");
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
    const usersMap = new Map((tenantDb.state.users ?? []).map((user) => [user.id, user.displayName]));

    return {
      case: {
        id: row.id,
        businessKey: row.businessKey,
        disconnectType: row.disconnectType,
        clusterKey: row.clusterKey,
        severity: row.severity,
        status: row.status as "open" | "snoozed" | "resolved",
        assignedTo: row.assignedTo,
        assignedToName: resolveCaseAssigneeName(
          usersMap,
          row.assignedTo,
          row.metadataJson as Record<string, unknown> | null | undefined
        ),
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
            assignedToName: usersMap.get(task.assignedTo ?? "") ?? null,
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
        actedByName: usersMap.get(entry.actedBy) ?? null,
        actedAt: entry.actedAt.toISOString(),
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        fromAssignee: entry.fromAssignee,
        fromAssigneeName: usersMap.get(entry.fromAssignee ?? "") ?? null,
        toAssignee: entry.toAssignee,
        toAssigneeName: usersMap.get(entry.toAssignee ?? "") ?? null,
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
    throw new AppError(404, "Intervention case not found");
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
  const userIds = [
    ...new Set(
      [
        row[0].assignedTo,
        taskRow?.assignedTo ?? null,
        ...historyRows.flatMap((entry) => [entry.actedBy, entry.fromAssignee, entry.toAssignee]),
      ].filter((value): value is string => Boolean(value))
    ),
  ];
  const userRows = userIds.length
    ? await tenantDb.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, userIds))
    : [];
  const usersMap = new Map(userRows.map((user) => [user.id, user.displayName]));

  return {
    case: {
      id: row[0].id,
      businessKey: row[0].businessKey,
      disconnectType: row[0].disconnectType,
      clusterKey: row[0].clusterKey,
      severity: row[0].severity,
      status: row[0].status as "open" | "snoozed" | "resolved",
      assignedTo: row[0].assignedTo,
      assignedToName: resolveCaseAssigneeName(
        usersMap,
        row[0].assignedTo,
        row[0].metadataJson as Record<string, unknown> | null
      ),
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
          assignedToName: usersMap.get(taskRow.assignedTo ?? "") ?? null,
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
      actedByName: usersMap.get(entry.actedBy) ?? null,
      actedAt: entry.actedAt.toISOString(),
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      fromAssignee: entry.fromAssignee,
      fromAssigneeName: usersMap.get(entry.fromAssignee ?? "") ?? null,
      toAssignee: entry.toAssignee,
      toAssigneeName: usersMap.get(entry.toAssignee ?? "") ?? null,
      fromSnoozedUntil: toIsoString(entry.fromSnoozedUntil),
      toSnoozedUntil: toIsoString(entry.toSnoozedUntil),
      notes: entry.notes,
      metadataJson: (entry.metadataJson as Record<string, unknown> | null) ?? null,
    })),
  };
}

const INTERVENTION_COPILOT_FEEDBACK_TYPE = "intervention_case_copilot";
const INTERVENTION_COPILOT_ALLOWED_ACTIONS = new Set([
  "assign",
  "resolve",
  "snooze",
  "escalate",
  "investigate",
] as const);

function isConclusionHistoryEntry(row: DisconnectCaseHistoryRow) {
  return Boolean(readHistoryMetadata(row).conclusion?.kind || row.actionType === "resolve" || row.actionType === "snooze" || row.actionType === "escalate");
}

function toCopilotOwnerContext(
  id: string | null,
  name: string | null
): InterventionCopilotOwnerContext {
  return { id, name };
}

function toCopilotString(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return "";
}

function toCopilotObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toCopilotObjectArray(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

function normalizePacketView(packet: AiCopilotPacketRow | null): InterventionCopilotPacketView {
  return {
    id: packet?.id ?? null,
    scopeType: packet?.scopeType === "intervention_case" ? "intervention_case" : null,
    scopeId: packet?.scopeId ?? null,
    packetKind: packet?.packetKind === "intervention_case" ? "intervention_case" : null,
    status: packet?.status ?? null,
    snapshotHash: packet?.snapshotHash ?? null,
    modelName: packet?.modelName ?? null,
    summaryText: packet?.summaryText ?? null,
    nextStepJson: toCopilotObject(packet?.nextStepJson ?? null),
    blindSpotsJson: toCopilotObjectArray(packet?.blindSpotsJson ?? null),
    evidenceJson: toCopilotObjectArray(packet?.evidenceJson ?? null),
    confidence:
      packet?.confidence == null
        ? null
        : Number.isFinite(Number(packet.confidence))
          ? Number(packet.confidence)
          : null,
    generatedAt: toIsoString(packet?.generatedAt ?? null),
    expiresAt: toIsoString(packet?.expiresAt ?? null),
    createdAt: toIsoString(packet?.createdAt ?? null),
    updatedAt: toIsoString(packet?.updatedAt ?? null),
  };
}

function normalizeRiskFlags(
  packet: AiCopilotPacketRow | null,
  input: {
    caseRow: DisconnectCaseRow;
    currentAssigneeId: string | null;
    task: TaskRow | null;
    latestConclusion: DisconnectCaseHistoryRow | null;
    now: Date;
  }
): InterventionCopilotRiskFlag[] {
  const packetFlags: InterventionCopilotRiskFlag[] = (toCopilotObjectArray(packet?.blindSpotsJson ?? null) ?? []).map(
    (flag, index) => ({
      flagType:
        typeof flag.flagType === "string"
          ? flag.flagType
          : typeof flag.kind === "string"
            ? flag.kind
            : `flag-${index + 1}`,
      title:
        typeof flag.title === "string"
          ? flag.title
          : typeof flag.label === "string"
            ? flag.label
            : `Risk flag ${index + 1}`,
      severity:
        flag.severity === "critical" || flag.severity === "high" || flag.severity === "medium" || flag.severity === "low"
          ? flag.severity
          : "medium",
      details:
        typeof flag.rationale === "string"
          ? flag.rationale
          : typeof flag.details === "string"
            ? flag.details
            : null,
    })
  );

  const flags: InterventionCopilotRiskFlag[] = [];
  if (!input.currentAssigneeId) {
    flags.push({
      flagType: "owner_gap",
      title: "No current owner",
      severity: "medium",
      details: "The case is not assigned to a current owner.",
    });
  }
  if (input.caseRow.reopenCount > 0) {
    flags.push({
      flagType: "reopen_risk",
      title: "Reopen risk",
      severity: input.caseRow.reopenCount > 1 ? "high" : "medium",
      details: "The case has already reopened at least once.",
    });
  }
  if (input.latestConclusion?.actionType === "snooze" && input.caseRow.snoozedUntil && input.caseRow.snoozedUntil <= input.now) {
    flags.push({
      flagType: "snooze_breach",
      title: "Snooze breached",
      severity: "high",
      details: "The snooze window has expired.",
    });
  }
  if (input.task && input.task.assignedTo !== (input.currentAssigneeId ?? null)) {
    flags.push({
      flagType: "owner_mismatch",
      title: "Generated task needs owner alignment",
      severity: "medium",
      details:
        input.currentAssigneeId
          ? `The case assignee and generated task owner do not match.`
          : `The generated task is currently assigned to ${input.task.assignedTo}.`,
    });
  }

  const merged = [...packetFlags];
  for (const derivedFlag of flags) {
    if (!merged.some((flag) => flag.flagType === derivedFlag.flagType)) {
      merged.push(derivedFlag);
    }
  }
  return merged;
}

function buildCopilotEvidence(
  packet: AiCopilotPacketRow | null,
  input: { caseRow: DisconnectCaseRow; task: TaskRow | null; latestConclusion: DisconnectCaseHistoryRow | null }
): InterventionCopilotEvidenceItem[] {
  const packetEvidence = toCopilotObjectArray(packet?.evidenceJson ?? null);
  if (packetEvidence && packetEvidence.length > 0) {
    return packetEvidence.map((item, index) => ({
      sourceType:
        typeof item.sourceType === "string"
          ? item.sourceType
          : typeof item.source === "string"
            ? item.source
            : "unknown",
      textSnippet:
        typeof item.textSnippet === "string"
          ? item.textSnippet
          : typeof item.value === "string"
            ? item.value
            : typeof item.text === "string"
              ? item.text
              : toCopilotString(item.value ?? item.text ?? item.details ?? item.summary ?? item.label),
      label: typeof item.label === "string" ? item.label : `Evidence ${index + 1}`,
    }));
  }

  const evidence: InterventionCopilotEvidenceItem[] = [
    {
      sourceType: "case",
      textSnippet:
        readMetadataString(input.caseRow.metadataJson as Record<string, unknown> | null, "evidenceSummary") ??
        readMetadataString(input.caseRow.metadataJson as Record<string, unknown> | null, "disconnectSummary") ??
        "No case summary is available.",
      label: "Case brief",
    },
    {
      sourceType: "task",
      textSnippet: input.task ? `${input.task.title} (${input.task.status})` : "No generated task is attached.",
      label: "Current task",
    },
    {
      sourceType: "history",
      textSnippet: input.latestConclusion ? `${input.latestConclusion.actionType} at ${input.latestConclusion.actedAt.toISOString()}` : "No intervention history yet.",
      label: "Latest intervention",
    },
  ];

  return evidence;
}

function buildRootCause(
  packet: AiCopilotPacketRow | null,
  caseRow: DisconnectCaseRow
): InterventionCopilotRootCause {
  const packetRootCause = toCopilotObject(packet?.nextStepJson ?? null)?.rootCause;
  if (packetRootCause && typeof packetRootCause === "object") {
    const normalized = packetRootCause as Record<string, unknown>;
    return {
      label: typeof normalized.label === "string" ? normalized.label : null,
      explanation:
        typeof normalized.explanation === "string"
          ? normalized.explanation
          : typeof normalized.rationale === "string"
            ? normalized.rationale
            : typeof normalized.details === "string"
              ? normalized.details
              : null,
    };
  }

  return {
    label: readMetadataString(caseRow.metadataJson as Record<string, unknown> | null, "disconnectLabel") ?? caseRow.disconnectType,
    explanation:
      readMetadataString(caseRow.metadataJson as Record<string, unknown> | null, "disconnectDetails") ??
      readMetadataString(caseRow.metadataJson as Record<string, unknown> | null, "disconnectSummary") ??
      null,
  };
}

function buildBlockerOwner(
  packet: AiCopilotPacketRow | null,
  input: { currentAssignee: InterventionCopilotOwnerContext | null; task: TaskRow | null }
): InterventionCopilotOwnerContext {
  const packetOwner = toCopilotObject(packet?.nextStepJson ?? null)?.blockerOwner;
  if (packetOwner && typeof packetOwner === "object") {
    const normalized = packetOwner as Record<string, unknown>;
    return {
      id:
        typeof normalized.id === "string"
          ? normalized.id
          : typeof normalized.details === "string"
            ? normalized.details
            : null,
      name: typeof normalized.name === "string" ? normalized.name : typeof normalized.label === "string" ? normalized.label : null,
    };
  }

  if (input.task?.assignedTo && input.task.assignedTo !== (input.currentAssignee?.id ?? null)) {
    return {
      id: input.task.assignedTo,
      name: null,
    };
  }

  if (input.currentAssignee) return input.currentAssignee;

  if (input.task?.assignedTo) {
    return {
      id: input.task.assignedTo,
      name: null,
    };
  }

  return {
    id: null,
    name: null,
  };
}

function buildReopenRisk(
  packet: AiCopilotPacketRow | null,
  input: { caseRow: DisconnectCaseRow; latestConclusion: DisconnectCaseHistoryRow | null; now: Date }
): InterventionCopilotReopenRisk {
  const packetRisk = toCopilotObject(packet?.nextStepJson ?? null)?.reopenRisk;
  if (packetRisk && typeof packetRisk === "object") {
    const normalized = packetRisk as Record<string, unknown>;
    return {
      level:
        normalized.level === "high" || normalized.level === "medium" || normalized.level === "low"
          ? normalized.level
          : "medium",
      rationale:
        typeof normalized.rationale === "string"
          ? normalized.rationale
          : typeof normalized.explanation === "string"
            ? normalized.explanation
            : typeof normalized.details === "string"
              ? normalized.details
              : null,
    };
  }

  const level: InterventionCopilotReopenRisk["level"] =
    input.caseRow.reopenCount > 1 || input.caseRow.escalated
      ? "high"
      : input.caseRow.reopenCount === 1
        ? "medium"
        : input.latestConclusion?.actionType === "snooze" && input.caseRow.snoozedUntil && input.caseRow.snoozedUntil <= input.now
          ? "high"
          : "low";

  return {
    level,
    rationale:
      input.caseRow.reopenCount > 0
        ? "The case has reopened before."
        : "The current state does not yet show a strong reopen signal.",
  };
}

function buildRecommendedAction(
  packet: AiCopilotPacketRow | null,
  input: {
    caseRow: DisconnectCaseRow;
    currentAssignee: InterventionCopilotOwnerContext | null;
    task: TaskRow | null;
    riskFlags: InterventionCopilotRiskFlag[];
    rootCause: InterventionCopilotRootCause;
    reopenRisk: InterventionCopilotReopenRisk;
  }
): InterventionCopilotRecommendedAction {
  if (input.caseRow.status === "resolved") {
    return {
      action: "resolve",
      rationale: "The case already appears resolved.",
      suggestedOwnerId: input.currentAssignee?.id ?? null,
      suggestedOwner: input.currentAssignee?.name ?? null,
    };
  }

  const nextStep = toCopilotObject(packet?.nextStepJson ?? null);
  if (nextStep && typeof nextStep.action === "string" && INTERVENTION_COPILOT_ALLOWED_ACTIONS.has(nextStep.action as never)) {
    return {
      action: nextStep.action as InterventionCopilotRecommendedAction["action"],
      rationale:
        typeof nextStep.rationale === "string"
          ? nextStep.rationale
          : typeof nextStep.summary === "string"
            ? nextStep.summary
            : null,
      suggestedOwnerId:
        typeof nextStep.suggestedOwnerId === "string"
          ? nextStep.suggestedOwnerId
          : typeof nextStep.ownerId === "string"
            ? nextStep.ownerId
            : null,
      suggestedOwner:
        typeof nextStep.suggestedOwner === "string"
          ? nextStep.suggestedOwner
          : typeof nextStep.ownerName === "string"
            ? nextStep.ownerName
            : null,
    };
  }

  if (!input.currentAssignee && input.task) {
    return {
      action: "assign",
      rationale: "Assign the generated task owner so the case has a clear next step.",
      suggestedOwnerId: input.task.assignedTo,
      suggestedOwner: null,
    };
  }

  if (input.reopenRisk.level === "high" || input.riskFlags.some((flag) => flag.flagType === "reopen_risk")) {
    return {
      action: "escalate",
      rationale: "The case shows repeat reopen risk and should be escalated.",
      suggestedOwnerId: input.currentAssignee?.id ?? null,
      suggestedOwner: input.currentAssignee?.name ?? null,
    };
  }

  return {
    action: "investigate",
    rationale: input.rootCause.explanation ?? "Review the evidence before mutating the case.",
    suggestedOwnerId: input.currentAssignee?.id ?? input.task?.assignedTo ?? null,
    suggestedOwner: input.currentAssignee?.name ?? null,
  };
}

function buildLatestHistoryMap(historyRows: DisconnectCaseHistoryRow[]) {
  const latestHistoryByCase = new Map<string, DisconnectCaseHistoryRow>();
  const latestConclusionByCase = new Map<string, DisconnectCaseHistoryRow>();
  const sorted = [...historyRows].sort((left, right) => right.actedAt.getTime() - left.actedAt.getTime());
  for (const row of sorted) {
    if (!latestHistoryByCase.has(row.disconnectCaseId)) {
      latestHistoryByCase.set(row.disconnectCaseId, row);
    }
    if (!latestConclusionByCase.has(row.disconnectCaseId) && isConclusionHistoryEntry(row)) {
      latestConclusionByCase.set(row.disconnectCaseId, row);
    }
  }
  return { latestHistoryByCase, latestConclusionByCase };
}

function computeLatestCaseChangedAt(input: {
  caseRow: DisconnectCaseRow;
  task: TaskRow | null;
  historyRows: DisconnectCaseHistoryRow[];
}) {
  const candidateDates: Array<Date | null | undefined> = [
    input.caseRow.updatedAt,
    input.caseRow.lastIntervenedAt,
    input.caseRow.lastReopenedAt,
    ...input.historyRows.map((row) => row.actedAt),
    input.task?.updatedAt ?? null,
    input.task?.createdAt ?? null,
  ];

  let latest: Date | null = null;
  for (const candidate of candidateDates) {
    if (!candidate) continue;
    if (!latest || candidate.getTime() > latest.getTime()) {
      latest = candidate;
    }
  }
  return latest;
}

function normalizeViewerFeedbackValue(
  feedbackRows: AiFeedbackRow[],
  packetId: string | null,
  viewerUserId: string | null | undefined
) {
  if (!packetId || !viewerUserId) return null;
  const latest = feedbackRows
    .filter(
      (row) =>
        row.targetType === "packet" &&
        row.targetId === packetId &&
        row.userId === viewerUserId &&
        row.feedbackType === INTERVENTION_COPILOT_FEEDBACK_TYPE
    )
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  if (!latest) return null;
  return latest.feedbackValue === "useful" || latest.feedbackValue === "not_useful" ? latest.feedbackValue : null;
}

function buildSimilarCases(input: {
  officeId: string;
  caseRow: DisconnectCaseRow;
  cases: DisconnectCaseRow[];
  latestConclusionByCase: Map<string, DisconnectCaseHistoryRow>;
  historyRows: DisconnectCaseHistoryRow[];
}): InterventionCopilotView["similarCases"] {
  const currentStageKey = readMetadataString(input.caseRow.metadataJson as Record<string, unknown> | null, "stageKey");
  const currentClusterKey = input.caseRow.clusterKey;

  return input.cases
    .filter((candidate) => candidate.officeId === input.officeId)
    .filter((candidate) => candidate.id !== input.caseRow.id)
    .filter((candidate) => candidate.disconnectType === input.caseRow.disconnectType)
    .map((candidate) => {
      const conclusion = input.latestConclusionByCase.get(candidate.id) ?? null;
      if (!conclusion || candidate.status === "open") return null;

      const candidateStageKey = readMetadataString(candidate.metadataJson as Record<string, unknown> | null, "stageKey");
      const reopened = input.historyRows.some(
        (row) =>
          row.disconnectCaseId === candidate.id &&
          row.actionType === "reopened" &&
          readHistoryMetadata(row).priorConclusionActionId === conclusion.id
      );
      const durableClose = readHistoryConclusionKind(conclusion) === "resolve" && !reopened;
      const lifecycleStartedAt =
        readMetadataDate(conclusion.metadataJson as Record<string, unknown> | null, "lifecycleStartedAt") ??
        candidate.currentLifecycleStartedAt ??
        null;
      const daysToDurableClosure =
        durableClose && lifecycleStartedAt && candidate.resolvedAt
          ? calculateBusinessDaysElapsed(lifecycleStartedAt, candidate.resolvedAt)
          : null;

      return {
        caseId: candidate.id,
        businessKey: candidate.businessKey,
        disconnectType: candidate.disconnectType,
        clusterKey: candidate.clusterKey,
        assigneeAtConclusion:
          readHistoryMetadata(conclusion).assigneeAtConclusion ??
          conclusion.toAssignee ??
          null,
        conclusionKind: readHistoryConclusionKind(conclusion),
        reasonCode:
          readHistoryMetadata(conclusion).conclusion?.reasonCode ??
          readHistoryMetadata(conclusion).conclusion?.snoozeReasonCode ??
          readHistoryMetadata(conclusion).conclusion?.escalationReasonCode ??
          null,
        durableClose,
        reopened,
        daysToDurableClosure,
        queueLink: formatQueueLink({ caseId: candidate.id }),
        _score: [
          currentClusterKey && candidate.clusterKey === currentClusterKey ? 1 : 0,
          currentStageKey && candidateStageKey === currentStageKey ? 1 : 0,
          candidate.severity === input.caseRow.severity ? 1 : 0,
          conclusion.actedAt.getTime(),
        ] as const,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => {
      if (right._score[0] !== left._score[0]) return right._score[0] - left._score[0];
      if (right._score[1] !== left._score[1]) return right._score[1] - left._score[1];
      if (right._score[2] !== left._score[2]) return right._score[2] - left._score[2];
      if (right._score[3] !== left._score[3]) return right._score[3] - left._score[3];
      return left.businessKey.localeCompare(right.businessKey);
    })
    .slice(0, 5)
    .map(({ _score: _scoreIgnored, ...item }) => item);
}

function normalizePacketTime(
  packet: AiCopilotPacketRow | null
): string | null {
  return toIsoString(packet?.generatedAt ?? packet?.createdAt ?? null);
}

export async function getInterventionCopilotView(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    caseId: string;
    viewerUserId?: string | null;
    now?: Date;
  }
): Promise<InterventionCopilotView> {
  const data = await loadInterventionAnalyticsData(tenantDb, input.officeId);
  const caseRow = data.cases.find((row) => row.id === input.caseId && row.officeId === input.officeId);
  if (!caseRow) {
    throw new AppError(404, "Intervention case not found");
  }

  const task = caseRow.generatedTaskId
    ? isInMemoryTenantDb(tenantDb)
      ? tenantDb.state.tasks.find((row) => row.id === caseRow.generatedTaskId) ?? null
      : (
          await tenantDb
            .select()
            .from(tasks)
            .where(eq(tasks.id, caseRow.generatedTaskId))
            .limit(1)
        )[0] ?? null
    : null;

  const packet = isInMemoryTenantDb(tenantDb)
    ? [...(tenantDb.state.packets ?? [])]
        .filter(
          (row) =>
            row.scopeType === "intervention_case" &&
            row.scopeId === caseRow.id &&
            row.packetKind === "intervention_case" &&
            row.status === "ready"
        )
        .sort(
          (left, right) =>
            (right.generatedAt?.getTime() ?? right.createdAt.getTime()) -
            (left.generatedAt?.getTime() ?? left.createdAt.getTime())
        )[0] ?? null
    : (
        await tenantDb
          .select()
          .from(aiCopilotPackets)
          .where(
            and(
              eq(aiCopilotPackets.scopeType, "intervention_case"),
              eq(aiCopilotPackets.scopeId, caseRow.id),
              eq(aiCopilotPackets.packetKind, "intervention_case"),
              eq(aiCopilotPackets.status, "ready")
            )
          )
          .orderBy(desc(aiCopilotPackets.generatedAt), desc(aiCopilotPackets.createdAt))
          .limit(1)
      )[0] ?? null;

  const feedbackRows = isInMemoryTenantDb(tenantDb)
    ? tenantDb.state.feedback ?? []
    : await tenantDb
        .select()
        .from(aiFeedback)
        .where(and(eq(aiFeedback.targetType, "packet"), eq(aiFeedback.feedbackType, INTERVENTION_COPILOT_FEEDBACK_TYPE)))
        .orderBy(desc(aiFeedback.createdAt));

  const { latestConclusionByCase } = buildLatestHistoryMap(data.history);
  const currentHistoryRows = data.history.filter((row) => row.disconnectCaseId === caseRow.id);
  const latestCurrentConclusion = latestConclusionByCase.get(caseRow.id) ?? null;
  const now = input.now ?? new Date();
  const normalizedPacket = normalizePacketView(packet);
  const packetGeneratedAt = packet?.generatedAt ?? packet?.createdAt ?? null;
  const latestCaseChangedAt = computeLatestCaseChangedAt({
    caseRow,
    task,
    historyRows: currentHistoryRows,
  });
  const currentAssignee = caseRow.assignedTo
    ? toCopilotOwnerContext(caseRow.assignedTo, data.users.find((user) => user.id === caseRow.assignedTo)?.displayName ?? null)
    : null;
  const rootCause = buildRootCause(packet, caseRow);
  const reopenRisk = buildReopenRisk(packet, { caseRow, latestConclusion: latestCurrentConclusion, now });
  const riskFlags = normalizeRiskFlags(packet, {
    caseRow,
    currentAssigneeId: caseRow.assignedTo ?? null,
    task,
    latestConclusion: latestCurrentConclusion,
    now,
  });
  const recommendedAction = buildRecommendedAction(packet, {
    caseRow,
    currentAssignee,
    task,
    riskFlags,
    rootCause,
    reopenRisk,
  });
  const blockerOwner = buildBlockerOwner(packet, { currentAssignee, task });

  return {
    packet: normalizedPacket,
    evidence: buildCopilotEvidence(packet, {
      caseRow,
      task,
      latestConclusion: latestCurrentConclusion,
    }),
    riskFlags,
    similarCases: buildSimilarCases({
      officeId: input.officeId,
      caseRow,
      cases: data.cases,
      latestConclusionByCase,
      historyRows: data.history,
    }),
    recommendedAction,
    rootCause,
    blockerOwner,
    reopenRisk,
    currentAssignee,
    isRefreshPending: Boolean(packet && packet.status && packet.status !== "ready"),
    isStale: Boolean(latestCaseChangedAt && packetGeneratedAt && latestCaseChangedAt.getTime() > packetGeneratedAt.getTime()),
    latestCaseChangedAt: toIsoString(latestCaseChangedAt),
    packetGeneratedAt: normalizePacketTime(packet),
    viewerFeedbackValue: normalizeViewerFeedbackValue(feedbackRows, packet?.id ?? null, input.viewerUserId ?? null),
  };
}

export const buildInterventionCopilotView = getInterventionCopilotView;

export async function regenerateInterventionCopilot(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    caseId: string;
    requestedBy: string;
    now?: Date;
  }
) {
  const data = await loadInterventionAnalyticsData(tenantDb, input.officeId);
  const caseRow = data.cases.find((row) => row.id === input.caseId && row.officeId === input.officeId);
  if (!caseRow) {
    throw new AppError(404, "Intervention case not found");
  }

  const now = input.now ?? new Date();
  const task = caseRow.generatedTaskId
    ? isInMemoryTenantDb(tenantDb)
      ? tenantDb.state.tasks.find((row) => row.id === caseRow.generatedTaskId) ?? null
      : (
          await tenantDb
            .select()
            .from(tasks)
            .where(eq(tasks.id, caseRow.generatedTaskId))
            .limit(1)
        )[0] ?? null
    : null;
  const { latestConclusionByCase } = buildLatestHistoryMap(data.history);
  const similarCases = buildSimilarCases({
    officeId: input.officeId,
    caseRow,
    cases: data.cases,
    latestConclusionByCase,
    historyRows: data.history,
  });

  const currentAssigneeName = data.users.find((user) => user.id === caseRow.assignedTo)?.displayName ?? null;
  const generatedTaskOwnerName = data.users.find((user) => user.id === task?.assignedTo)?.displayName ?? null;
  const ownerMismatch =
    Boolean(task?.assignedTo) && task?.assignedTo !== (caseRow.assignedTo ?? null);
  const rootCauseHints = [
    readMetadataString(caseRow.metadataJson as Record<string, unknown> | null, "disconnectSummary"),
    readMetadataString(caseRow.metadataJson as Record<string, unknown> | null, "disconnectDetails"),
    ownerMismatch ? "The generated task owner does not match the current case owner." : null,
  ].filter((value): value is string => Boolean(value));
  const riskHints = [
    caseRow.reopenCount > 1 ? "This case has reopened multiple times." : null,
    caseRow.reopenCount === 1 ? "This case has reopened before." : null,
    caseRow.status === "snoozed" ? "The case is snoozed and should be checked for breach risk." : null,
    !caseRow.assignedTo ? "The case does not have a clear owner." : null,
    caseRow.escalated ? "The case is already escalated." : null,
  ].filter((value): value is string => Boolean(value));

  const promptInput = {
    context: {
      caseId: caseRow.id,
      disconnectType: caseRow.disconnectType,
      severity: caseRow.severity,
      status: caseRow.status,
      currentAssigneeId: caseRow.assignedTo ?? null,
      assignedToName: currentAssigneeName,
      ownerTeamLabel:
        readMetadataString(caseRow.metadataJson as Record<string, unknown> | null, "stageName") ??
        readMetadataString(caseRow.metadataJson as Record<string, unknown> | null, "stageKey"),
      generatedTaskOwnerId: task?.assignedTo ?? null,
      generatedTaskOwnerName,
      generatedTaskStatus: task?.status ?? null,
      generatedTaskTitle: task?.title ?? null,
      reopenCount: caseRow.reopenCount,
      escalated: caseRow.escalated,
      stageKey: readMetadataString(caseRow.metadataJson as Record<string, unknown> | null, "stageKey"),
      stageName: readMetadataString(caseRow.metadataJson as Record<string, unknown> | null, "stageName"),
    },
    signals: {
      rootCauseHints,
      riskHints,
      similarCaseSummaries: similarCases.slice(0, 3).map((item) => ({
        label: item.businessKey,
        outcome: `${item.conclusionKind}${item.reasonCode ? `:${item.reasonCode}` : ""}`,
      })),
    },
    evidence: [
      {
        sourceType: "case",
        textSnippet:
          readMetadataString(caseRow.metadataJson as Record<string, unknown> | null, "evidenceSummary") ??
          readMetadataString(caseRow.metadataJson as Record<string, unknown> | null, "disconnectSummary") ??
          caseRow.businessKey,
      },
      {
        sourceType: "task",
        textSnippet: task ? `${task.title} (${task.status})` : "No generated task attached.",
      },
      ...similarCases.slice(0, 3).map((item) => ({
        sourceType: "similar_case",
        textSnippet: `${item.businessKey} -> ${item.conclusionKind}`,
      })),
    ],
  };

  const generated = await getAiCopilotProvider().generateInterventionCopilotPacket(promptInput);
  const packetId = crypto.randomUUID();
  const snapshotHash = crypto.createHash("sha256").update(JSON.stringify(promptInput)).digest("hex");

  if (isInMemoryTenantDb(tenantDb)) {
    tenantDb.state.packets = tenantDb.state.packets ?? [];
    tenantDb.state.packets.push({
      id: packetId,
      scopeType: "intervention_case",
      scopeId: caseRow.id,
      dealId: caseRow.dealId,
      packetKind: "intervention_case",
      snapshotHash,
      modelName: "heuristic",
      status: "ready",
      summaryText: generated.summary,
      nextStepJson: {
        ...generated.recommendedAction,
        rootCause: generated.rootCause,
        blockerOwner: generated.blockerOwner,
        reopenRisk: generated.reopenRisk,
      },
      blindSpotsJson: generated.blindSpotFlags,
      evidenceJson: generated.evidence,
      confidence: String(generated.confidence),
      generatedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
    } as AiCopilotPacketRow);
  } else {
    await tenantDb.insert(aiCopilotPackets).values({
      id: packetId,
      scopeType: "intervention_case",
      scopeId: caseRow.id,
      dealId: caseRow.dealId,
      packetKind: "intervention_case",
      snapshotHash,
      modelName: "heuristic",
      status: "ready",
      summaryText: generated.summary,
      nextStepJson: {
        ...generated.recommendedAction,
        rootCause: generated.rootCause,
        blockerOwner: generated.blockerOwner,
        reopenRisk: generated.reopenRisk,
      },
      blindSpotsJson: generated.blindSpotFlags,
      evidenceJson: generated.evidence,
      confidence: String(generated.confidence),
      generatedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
      updatedAt: now,
    });
  }

  return {
    queued: false,
    packetId,
    packetGeneratedAt: now.toISOString(),
    requestedBy: input.requestedBy,
  };
}

type MutationAction = "assign" | "snooze" | "resolve" | "escalate" | "reopened";

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

function getConclusionReasonFamilyForCase(
  row: { disconnectType: string },
  actionKind: "resolve" | "snooze" | "escalate"
) {
  switch (`${actionKind}:${row.disconnectType}`) {
    case "resolve:missing_next_task":
      return "resolve:task_execution";
    case "resolve:inbound_without_followup":
      return "resolve:follow_up_execution";
    case "snooze:estimating_gate_gap":
      return "snooze:estimating_wait";
    case "escalate:revision_loop":
      return "escalate:manager_intervention";
    default:
      return `${actionKind}:${row.disconnectType}`;
  }
}

export async function assertHomogeneousBatchConclusionCohort(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string,
  caseIds: string[],
  actionKind: "resolve" | "snooze" | "escalate"
) {
  const rows = await loadCasesForMutation(tenantDb, officeId, caseIds);
  if (rows.length === 0) {
    throw new AppError(400, "At least one intervention case is required");
  }

  const firstRow = rows[0];
  if (!firstRow) {
    throw new AppError(400, "At least one intervention case is required");
  }

  if (!rows.every((row) => row.disconnectType === firstRow.disconnectType)) {
    throw new AppError(400, "Batch conclusion requires a homogeneous cohort");
  }

  const expectedReasonFamily = getConclusionReasonFamilyForCase(firstRow, actionKind);
  if (!rows.every((row) => getConclusionReasonFamilyForCase(row, actionKind) === expectedReasonFamily)) {
    throw new AppError(400, "Batch conclusion requires a homogeneous cohort");
  }
}

function buildMutationError(caseId: string, message: string) {
  return { caseId, message };
}

function canAssignCase(row: DisconnectCaseRow) {
  if (row.status === "resolved") return "Cannot assign a resolved case";
  return null;
}

function canSnoozeCase(row: DisconnectCaseRow) {
  if (row.status === "resolved") return "Cannot snooze a resolved case";
  return null;
}

function canResolveCase(row: DisconnectCaseRow) {
  if (row.status === "resolved") return "Case is already resolved";
  return null;
}

function canEscalateCase(row: DisconnectCaseRow) {
  if (row.escalated) return "Case is already escalated";
  return null;
}

function dedupeCaseIds(caseIds: string[]) {
  const seen = new Set<string>();
  const uniqueCaseIds: string[] = [];
  for (const caseId of caseIds) {
    if (seen.has(caseId)) continue;
    seen.add(caseId);
    uniqueCaseIds.push(caseId);
  }
  return uniqueCaseIds;
}

function isTerminalTaskStatus(status: string | null | undefined) {
  return status === "completed" || status === "dismissed";
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

async function getLatestConclusionHistoryEvent(
  tenantDb: TenantDb | InMemoryTenantDb,
  caseId: string
): Promise<DisconnectCaseHistoryRow | null> {
  if (isInMemoryTenantDb(tenantDb)) {
    const row = [...tenantDb.state.history]
      .filter(
        (item) =>
          item.disconnectCaseId === caseId &&
          (item.actionType === "resolve" || item.actionType === "snooze" || item.actionType === "escalate")
      )
      .sort((left, right) => new Date(right.actedAt).getTime() - new Date(left.actedAt).getTime())[0];
    return row ?? null;
  }

  const row = await tenantDb
    .select()
    .from(aiDisconnectCaseHistory)
    .where(
      and(
        eq(aiDisconnectCaseHistory.disconnectCaseId, caseId),
        inArray(aiDisconnectCaseHistory.actionType, ["resolve", "snooze", "escalate"])
      )
    )
    .orderBy(desc(aiDisconnectCaseHistory.actedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return row;
}

async function hasReopenHistoryForConclusionAction(
  tenantDb: TenantDb | InMemoryTenantDb,
  caseId: string,
  priorConclusionActionId: string
) {
  if (isInMemoryTenantDb(tenantDb)) {
    return (
      tenantDb.state.history.find(
        (item) =>
          item.disconnectCaseId === caseId &&
          item.actionType === "reopened" &&
          readHistoryMetadata(item).priorConclusionActionId === priorConclusionActionId
      ) ?? null
    );
  }

  return tenantDb
    .select({ id: aiDisconnectCaseHistory.id })
    .from(aiDisconnectCaseHistory)
    .where(
      and(
        eq(aiDisconnectCaseHistory.disconnectCaseId, caseId),
        eq(aiDisconnectCaseHistory.actionType, "reopened"),
        sql`${aiDisconnectCaseHistory.metadataJson}->>'priorConclusionActionId' = ${priorConclusionActionId}`
      )
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function writeReopenedHistoryEvent(
  tenantDb: TenantDb | InMemoryTenantDb,
  row: DisconnectCaseRow,
  nextLifecycleStartedAt: Date
) {
  const latestConclusionEvent = await getLatestConclusionHistoryEvent(tenantDb, row.id);
  if (!latestConclusionEvent) return;
  const priorConclusionActionId = latestConclusionEvent.id;
  const existingReopen = await hasReopenHistoryForConclusionAction(tenantDb, row.id, priorConclusionActionId);
  if (existingReopen) return;

  await writeMutationArtifacts(tenantDb, row, {
    actionType: "reopened",
    actedBy: getSystemActorUserId(),
    comment: null,
    fromStatus: row.status,
    toStatus: "open",
    fromAssignee: row.assignedTo ?? null,
    toAssignee: row.assignedTo ?? null,
    metadataJson: buildReopenHistoryMetadata({
      priorConclusionActionId,
      priorConclusionKind: readHistoryConclusionKind(latestConclusionEvent),
      reopenReason: "signal_still_present",
      lifecycleStartedAt: nextLifecycleStartedAt.toISOString(),
    }),
  });
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
    if (task && !isTerminalTaskStatus(task.status)) task.assignedTo = assignedTo;
    return;
  }

  const [task] = await tenantDb
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, disconnectCase.generatedTaskId))
    .limit(1);
  if (!task || isTerminalTaskStatus(task.status)) return;

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
    if (task && !isTerminalTaskStatus(task.status)) task.dueDate = snoozedUntil.toISOString().slice(0, 10);
    return;
  }

  const [task] = await tenantDb
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, disconnectCase.generatedTaskId))
    .limit(1);
  if (!task || isTerminalTaskStatus(task.status)) return;

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

function validateResolveConclusion(
  conclusion: StructuredResolveConclusion | null | undefined,
  resolutionReason: keyof typeof resolutionToTaskOutcome,
  allowLegacyOutcomeWrites: boolean | undefined
) {
  if (!conclusion) {
    if (allowLegacyOutcomeWrites !== false) return;
    throw new AppError(400, "Structured resolve conclusion is required");
  }

  const validReasonCodes =
    RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES[
      conclusion.outcomeCategory as keyof typeof RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES
    ];
  if (!validReasonCodes || !validReasonCodes.includes(conclusion.reasonCode as never)) {
    throw new AppError(400, "Invalid resolve conclusion");
  }

  const mappedReason = mapStructuredResolveReasonToLegacyResolutionReason(conclusion.reasonCode);
  if (mappedReason !== resolutionReason) {
    throw new AppError(400, "Resolve conclusion does not match resolutionReason");
  }
}

function validateSnoozeConclusion(conclusion: StructuredSnoozeConclusion | null | undefined) {
  if (!conclusion) return;

  const validCombination =
    SNOOZE_REASON_TO_EXPECTED_OPTIONS[
      conclusion.snoozeReasonCode as keyof typeof SNOOZE_REASON_TO_EXPECTED_OPTIONS
    ];
  if (
    !validCombination ||
    !validCombination.ownerTypes.includes(conclusion.expectedOwnerType as never) ||
    !validCombination.nextStepCodes.includes(conclusion.expectedNextStepCode as never)
  ) {
    throw new AppError(400, "Invalid snooze conclusion");
  }
}

function validateEscalateConclusion(conclusion: StructuredEscalateConclusion | null | undefined) {
  if (!conclusion) return;
  if (!ESCALATION_TARGET_TYPES.includes(conclusion.escalationTargetType as never)) {
    throw new AppError(400, "Invalid escalate conclusion");
  }
}

function conclusionNotes(conclusion: StructuredInterventionConclusion | null | undefined) {
  return conclusion?.notes ?? null;
}

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
  const caseIds = dedupeCaseIds(input.caseIds);
  const rows = await loadCasesForMutation(tenantDb, input.officeId, caseIds);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const errors: Array<{ caseId: string; message: string }> = [];
  let updatedCount = 0;
  let skippedCount = 0;

  for (const caseId of caseIds) {
    const row = rowsById.get(caseId);
    if (!row) {
      skippedCount += 1;
      errors.push(buildMutationError(caseId, "Intervention case not found"));
      continue;
    }

    const validationError = canAssignCase(row);
    if (validationError) {
      skippedCount += 1;
      errors.push(buildMutationError(caseId, validationError));
      continue;
    }

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
    updatedCount += 1;
  }

  return {
    updatedCount,
    skippedCount,
    errors,
  };
}

export async function snoozeInterventionCases(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    caseIds: string[];
    snoozedUntil: Date | string;
    conclusion?: StructuredSnoozeConclusion | null;
    allowLegacyOutcomeWrites?: boolean;
    actorUserId: string;
    actorRole: string;
    notes?: string | null;
  }
): Promise<MutationResult> {
  validateSnoozeConclusion(input.conclusion);
  if (input.caseIds.length > 1 && input.conclusion) {
    await assertHomogeneousBatchConclusionCohort(tenantDb, input.officeId, input.caseIds, "snooze");
  }
  const caseIds = dedupeCaseIds(input.caseIds);
  const snoozedUntil = input.snoozedUntil instanceof Date
    ? input.snoozedUntil
    : new Date(input.snoozedUntil);
  const rows = await loadCasesForMutation(tenantDb, input.officeId, caseIds);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const errors: Array<{ caseId: string; message: string }> = [];
  let updatedCount = 0;
  let skippedCount = 0;

  for (const caseId of caseIds) {
    const row = rowsById.get(caseId);
    if (!row) {
      skippedCount += 1;
      errors.push(buildMutationError(caseId, "Intervention case not found"));
      continue;
    }

    const validationError = canSnoozeCase(row);
    if (validationError) {
      skippedCount += 1;
      errors.push(buildMutationError(caseId, validationError));
      continue;
    }

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
      comment: input.notes ?? conclusionNotes(input.conclusion),
      fromStatus,
      toStatus: "snoozed",
      fromAssignee: row.assignedTo ?? null,
      toAssignee: row.assignedTo ?? null,
      fromSnoozedUntil,
      toSnoozedUntil: snoozedUntil,
      metadataJson: input.conclusion
        ? {
            lifecycleStartedAt: row.currentLifecycleStartedAt.toISOString(),
            assigneeAtConclusion: row.assignedTo ?? null,
            disconnectTypeAtConclusion: row.disconnectType,
            conclusion: input.conclusion,
          }
        : undefined,
    });
    updatedCount += 1;
  }

  return {
    updatedCount,
    skippedCount,
    errors,
  };
}

export async function resolveInterventionCases(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    caseIds: string[];
    resolutionReason: keyof typeof resolutionToTaskOutcome;
    conclusion?: StructuredResolveConclusion | null;
    allowLegacyOutcomeWrites?: boolean;
    actorUserId: string;
    actorRole: string;
    notes?: string | null;
  }
): Promise<MutationResult> {
  validateResolveConclusion(input.conclusion, input.resolutionReason, input.allowLegacyOutcomeWrites);
  if (input.caseIds.length > 1 && input.conclusion) {
    await assertHomogeneousBatchConclusionCohort(tenantDb, input.officeId, input.caseIds, "resolve");
  }
  const caseIds = dedupeCaseIds(input.caseIds);
  const rows = await loadCasesForMutation(tenantDb, input.officeId, caseIds);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const errors: Array<{ caseId: string; message: string }> = [];
  const taskOutcome = resolutionToTaskOutcome[input.resolutionReason];
  let updatedCount = 0;
  let skippedCount = 0;

  for (const caseId of caseIds) {
    const row = rowsById.get(caseId);
    if (!row) {
      skippedCount += 1;
      errors.push(buildMutationError(caseId, "Intervention case not found"));
      continue;
    }

    const validationError = canResolveCase(row);
    if (validationError) {
      skippedCount += 1;
      errors.push(buildMutationError(caseId, validationError));
      continue;
    }

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
      comment: input.notes ?? conclusionNotes(input.conclusion),
      fromStatus,
      toStatus: "resolved",
      fromAssignee: row.assignedTo ?? null,
      toAssignee: row.assignedTo ?? null,
      metadataJson: {
        resolutionReason: input.resolutionReason,
        taskOutcome,
        lifecycleStartedAt: row.currentLifecycleStartedAt.toISOString(),
        assigneeAtConclusion: row.assignedTo ?? null,
        disconnectTypeAtConclusion: row.disconnectType,
        conclusion: input.conclusion ?? null,
      },
    });
    updatedCount += 1;
  }

  return {
    updatedCount,
    skippedCount,
    errors,
  };
}

export async function escalateInterventionCases(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    caseIds: string[];
    conclusion?: StructuredEscalateConclusion | null;
    allowLegacyOutcomeWrites?: boolean;
    actorUserId: string;
    actorRole: string;
    notes?: string | null;
  }
): Promise<MutationResult> {
  validateEscalateConclusion(input.conclusion);
  if (input.caseIds.length > 1 && input.conclusion) {
    await assertHomogeneousBatchConclusionCohort(tenantDb, input.officeId, input.caseIds, "escalate");
  }
  const caseIds = dedupeCaseIds(input.caseIds);
  const rows = await loadCasesForMutation(tenantDb, input.officeId, caseIds);
  const errors: Array<{ caseId: string; message: string }> = [];
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  let updatedCount = 0;
  let skippedCount = 0;

  for (const caseId of caseIds) {
    const row = rowsById.get(caseId);
    if (!row) {
      skippedCount += 1;
      errors.push(buildMutationError(caseId, "Intervention case not found"));
      continue;
    }

    const validationError = canEscalateCase(row);
    if (validationError) {
      skippedCount += 1;
      errors.push(buildMutationError(caseId, validationError));
      continue;
    }

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
      comment: input.notes ?? conclusionNotes(input.conclusion),
      fromStatus: row.status,
      toStatus: row.status,
      fromAssignee: row.assignedTo ?? null,
      toAssignee: row.assignedTo ?? null,
      metadataJson: {
        escalated: true,
        lifecycleStartedAt: row.currentLifecycleStartedAt.toISOString(),
        assigneeAtConclusion: row.assignedTo ?? null,
        disconnectTypeAtConclusion: row.disconnectType,
        conclusion: input.conclusion ?? null,
      },
    });
    updatedCount += 1;
  }

  return {
    updatedCount,
    skippedCount,
    errors,
  };
}
