import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  aiDisconnectCases,
  aiManagerAlertSendLedger,
  aiManagerAlertSnapshots,
  notifications,
  offices,
  users,
} from "@trock-crm/shared/schema";
import { getOfficeTimezone } from "../../lib/office-timezone.js";

type TenantDb = NodePgDatabase<typeof schema>;

type DisconnectCaseRow = typeof aiDisconnectCases.$inferSelect;
type ManagerAlertSnapshotRow = typeof aiManagerAlertSnapshots.$inferSelect;
type ManagerAlertSendLedgerRow = typeof aiManagerAlertSendLedger.$inferSelect;
type NotificationRow = typeof notifications.$inferSelect;
type UserRow = Pick<typeof users.$inferSelect, "id" | "displayName">;
type OfficeRow = Pick<typeof offices.$inferSelect, "id" | "timezone">;

type InMemoryTenantDb = {
  state: {
    cases: DisconnectCaseRow[];
    snapshots: ManagerAlertSnapshotRow[];
    sendLedger: ManagerAlertSendLedgerRow[];
    notifications: NotificationRow[];
    users?: UserRow[];
    offices?: OfficeRow[];
  };
};

export const MANAGER_ALERT_SNAPSHOT_KIND = "manager_alert_summary" as const;
export const MANAGER_ALERT_NOTIFICATION_TYPE = "manager_alert_summary" as const;
export const MANAGER_ALERT_FAMILY_LINK = "/admin/intervention-analytics" as const;
const ASSIGNEE_OVERLOAD_THRESHOLD = 15;
const MAX_OVERLOAD_ASSIGNEES = 5;

export interface ManagerAlertSnapshotJson {
  version: 1;
  officeId: string;
  timezone: string;
  officeLocalDate: string;
  generatedAt: string;
  link: typeof MANAGER_ALERT_FAMILY_LINK;
  families: {
    overdueHighCritical: {
      count: number;
      queueLink: string;
      caseIds: string[];
    };
    snoozeBreached: {
      count: number;
      queueLink: string;
      caseIds: string[];
    };
    escalatedOpen: {
      count: number;
      queueLink: string;
      caseIds: string[];
    };
    assigneeOverload: {
      count: number;
      threshold: number;
      queueLink: string | null;
      items: Array<{
        assigneeId: string;
        assigneeLabel: string;
        totalWeight: number;
        caseCount: number;
        queueLink: string;
      }>;
    };
  };
}

export interface ManagerAlertNotificationFactoryInput {
  tenantDb: TenantDb | InMemoryTenantDb;
  recipientUserId: string;
  snapshot: ManagerAlertSnapshotRow;
  title: string;
  body: string;
  link: typeof MANAGER_ALERT_FAMILY_LINK;
}

export type ManagerAlertNotificationFactory = (
  input: ManagerAlertNotificationFactoryInput
) => Promise<NotificationRow>;

export interface ManagerAlertSnapshotResult extends ManagerAlertSnapshotRow {
  snapshotJson: ManagerAlertSnapshotJson;
}

export interface ManagerAlertSendResult {
  claimed: boolean;
  snapshot: ManagerAlertSnapshotResult;
  notification: NotificationRow | null;
}

function isInMemoryTenantDb(value: unknown): value is InMemoryTenantDb {
  return Boolean(value && typeof value === "object" && "state" in value);
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
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
      elapsed += 1;
    }
  }

  return elapsed;
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

function severityWeight(value: string) {
  switch (value) {
    case "critical":
      return 5;
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

function isOverdueCase(row: DisconnectCaseRow, now: Date) {
  return row.status === "open" && calculateBusinessDaysElapsed(row.currentLifecycleStartedAt, now) > interventionSlaThresholdDays(row.severity);
}

function isSnoozeBreachedCase(row: DisconnectCaseRow, now: Date) {
  return row.status === "snoozed" && Boolean(row.snoozedUntil && row.snoozedUntil <= now);
}

function isEscalatedOpenCase(row: DisconnectCaseRow) {
  return row.escalated && row.status !== "resolved";
}

function getOfficeLocalDate(now: Date, timezone: string) {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: timezone });
}

function buildQueueLink(input: {
  view?: "open" | "all" | "escalated" | "overdue" | "snooze-breached" | "repeat";
  severity?: "critical" | "high" | "medium" | "low";
  assigneeId?: string | null;
  caseId?: string | null;
  disconnectType?: string | null;
  repId?: string | null;
  companyId?: string | null;
  stageKey?: string | null;
}) {
  const params = new URLSearchParams();
  if (input.view && input.view !== "open") params.set("view", input.view);
  if (input.severity) params.set("severity", input.severity);
  if (input.assigneeId) params.set("assigneeId", input.assigneeId);
  if (input.caseId) params.set("caseId", input.caseId);
  if (input.disconnectType) params.set("disconnectType", input.disconnectType);
  if (input.repId) params.set("repId", input.repId);
  if (input.companyId) params.set("companyId", input.companyId);
  if (input.stageKey) params.set("stageKey", input.stageKey);
  const query = params.toString();
  return query ? `/admin/interventions?${query}` : "/admin/interventions";
}

function buildNotificationBody(snapshot: ManagerAlertSnapshotJson) {
  return [
    "High-priority intervention pressure needs attention today.",
    `Overdue high/critical: ${snapshot.families.overdueHighCritical.count}.`,
    `Expired snoozes: ${snapshot.families.snoozeBreached.count}.`,
    `Unresolved escalations: ${snapshot.families.escalatedOpen.count}.`,
    `Assignee overload: ${snapshot.families.assigneeOverload.count}.`,
  ].join(" ");
}

function buildNotificationTitle(snapshot: ManagerAlertSnapshotJson) {
  return `Manager alerts: ${snapshot.families.overdueHighCritical.count + snapshot.families.snoozeBreached.count + snapshot.families.escalatedOpen.count + snapshot.families.assigneeOverload.count} items need attention`;
}

function createSnapshotRow(input: {
  officeId: string;
  snapshotMode: "preview" | "sent";
  snapshotJson: ManagerAlertSnapshotJson;
  now: Date;
}) {
  return {
    id: "",
    officeId: input.officeId,
    snapshotKind: MANAGER_ALERT_SNAPSHOT_KIND,
    snapshotMode: input.snapshotMode,
    snapshotJson: input.snapshotJson,
    scannedAt: input.now,
    sentAt: input.snapshotMode === "sent" ? input.now : null,
    createdAt: input.now,
    updatedAt: input.now,
  } satisfies ManagerAlertSnapshotResult;
}

function cloneSnapshotRow(row: ManagerAlertSnapshotResult): ManagerAlertSnapshotResult {
  return {
    ...row,
    snapshotJson: structuredClone(row.snapshotJson),
    scannedAt: new Date(row.scannedAt),
    sentAt: row.sentAt ? new Date(row.sentAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function cloneNotification(row: NotificationRow): NotificationRow {
  return {
    ...row,
    readAt: row.readAt ? new Date(row.readAt) : null,
    createdAt: new Date(row.createdAt),
  };
}

function toManagerAlertSnapshotResult(row: ManagerAlertSnapshotRow): ManagerAlertSnapshotResult {
  return {
    ...row,
    snapshotJson: row.snapshotJson as ManagerAlertSnapshotJson,
    scannedAt: new Date(row.scannedAt),
    sentAt: row.sentAt ? new Date(row.sentAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function buildManagerAlertSnapshotFromCases(input: {
  officeId: string;
  timezone: string;
  now: Date;
  cases: DisconnectCaseRow[];
  usersById: Map<string, string>;
}): ManagerAlertSnapshotJson {
  const overdueHighCriticalCaseIds: string[] = [];
  const snoozeBreachedCaseIds: string[] = [];
  const escalatedOpenCaseIds: string[] = [];
  const assigneeBuckets = new Map<
    string,
    {
      assigneeId: string;
      assigneeLabel: string;
      totalWeight: number;
      caseCount: number;
    }
  >();

  for (const row of input.cases) {
    const isActive = row.status !== "resolved";
    const overdue = isOverdueCase(row, input.now);
    const snoozeBreached = isSnoozeBreachedCase(row, input.now);
    const escalatedOpen = isEscalatedOpenCase(row);

    if (overdue && (row.severity === "critical" || row.severity === "high")) {
      overdueHighCriticalCaseIds.push(row.id);
    }
    if (snoozeBreached) snoozeBreachedCaseIds.push(row.id);
    if (escalatedOpen) escalatedOpenCaseIds.push(row.id);

    if (row.assignedTo && isActive) {
      const existing =
        assigneeBuckets.get(row.assignedTo) ??
        {
          assigneeId: row.assignedTo,
          assigneeLabel: input.usersById.get(row.assignedTo) ?? row.assignedTo,
          totalWeight: 0,
          caseCount: 0,
        };
      existing.caseCount += 1;
      existing.totalWeight += severityWeight(row.severity);
      if (escalatedOpen) existing.totalWeight += 2;
      if (overdue) existing.totalWeight += 1;
      if (snoozeBreached) existing.totalWeight += 1;
      assigneeBuckets.set(row.assignedTo, existing);
    }
  }

  const overloadedAssignees = [...assigneeBuckets.values()]
    .filter((item) => item.totalWeight >= ASSIGNEE_OVERLOAD_THRESHOLD)
    .sort((a, b) => {
      if (b.totalWeight !== a.totalWeight) return b.totalWeight - a.totalWeight;
      if (b.caseCount !== a.caseCount) return b.caseCount - a.caseCount;
      return a.assigneeLabel.localeCompare(b.assigneeLabel);
    })
    .slice(0, MAX_OVERLOAD_ASSIGNEES)
    .map((item) => ({
      assigneeId: item.assigneeId,
      assigneeLabel: item.assigneeLabel,
      totalWeight: item.totalWeight,
      caseCount: item.caseCount,
      queueLink: buildQueueLink({ view: "all", assigneeId: item.assigneeId }),
    }));

  return {
    version: 1,
    officeId: input.officeId,
    timezone: input.timezone,
    officeLocalDate: getOfficeLocalDate(input.now, input.timezone),
    generatedAt: input.now.toISOString(),
    link: MANAGER_ALERT_FAMILY_LINK,
    families: {
      overdueHighCritical: {
        count: overdueHighCriticalCaseIds.length,
        queueLink: buildQueueLink({ view: "overdue" }),
        caseIds: overdueHighCriticalCaseIds,
      },
      snoozeBreached: {
        count: snoozeBreachedCaseIds.length,
        queueLink: buildQueueLink({ view: "snooze-breached" }),
        caseIds: snoozeBreachedCaseIds,
      },
      escalatedOpen: {
        count: escalatedOpenCaseIds.length,
        queueLink: buildQueueLink({ view: "escalated" }),
        caseIds: escalatedOpenCaseIds,
      },
      assigneeOverload: {
        count: overloadedAssignees.length,
        threshold: ASSIGNEE_OVERLOAD_THRESHOLD,
        queueLink: overloadedAssignees.length > 0 ? buildQueueLink({ view: "all" }) : null,
        items: overloadedAssignees,
      },
    },
  };
}

async function loadManagerAlertContext(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: { officeId: string; timezone?: string | null; now: Date }
) {
  const timezone = await resolveOfficeTimezone(tenantDb, input.officeId, input.timezone);

  if (isInMemoryTenantDb(tenantDb)) {
    const cases = tenantDb.state.cases.filter((row) => row.officeId === input.officeId);
    const usersById = new Map((tenantDb.state.users ?? []).map((user) => [user.id, user.displayName]));
    return { timezone, cases, usersById };
  }

  const cases = await tenantDb.select().from(aiDisconnectCases).where(eq(aiDisconnectCases.officeId, input.officeId));
  const assigneeIds = [...new Set(cases.map((row) => row.assignedTo).filter((value): value is string => Boolean(value)))];
  const userRows = assigneeIds.length
    ? await tenantDb.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, assigneeIds))
    : [];
  const usersById = new Map(userRows.map((user) => [user.id, user.displayName]));

  return { timezone, cases, usersById };
}

async function resolveOfficeTimezone(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string,
  fallbackTimezone?: string | null
) {
  if (fallbackTimezone) return getOfficeTimezone({ timezone: fallbackTimezone });

  if (isInMemoryTenantDb(tenantDb)) {
    const office = tenantDb.state.offices?.find((row) => row.id === officeId) ?? null;
    return getOfficeTimezone({ timezone: office?.timezone ?? null });
  }

  const rows = await tenantDb.select({ timezone: offices.timezone }).from(offices).where(eq(offices.id, officeId)).limit(1);
  return getOfficeTimezone(rows[0] ?? null);
}

async function resolveOfficeSchemaName(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string
) {
  if (isInMemoryTenantDb(tenantDb)) {
    return null;
  }

  const rows = await tenantDb.select({ slug: offices.slug }).from(offices).where(eq(offices.id, officeId)).limit(1);
  const slug = rows[0]?.slug;
  if (!slug) {
    throw new Error(`Office ${officeId} is missing`);
  }
  return `office_${slug}`;
}

async function applyOfficeSearchPath(
  tenantDb: TenantDb | InMemoryTenantDb,
  officeId: string
) {
  if (isInMemoryTenantDb(tenantDb)) {
    return;
  }

  const schemaName = await resolveOfficeSchemaName(tenantDb, officeId);
  await tenantDb.execute(sql`SELECT set_config('search_path', ${`${schemaName},public`}, true)`);
}

async function persistSnapshot(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    snapshotMode: "preview" | "sent";
    snapshotJson: ManagerAlertSnapshotJson;
    now: Date;
  }
): Promise<ManagerAlertSnapshotResult> {
  if (isInMemoryTenantDb(tenantDb)) {
    const existing = tenantDb.state.snapshots.find(
      (row) => row.officeId === input.officeId && row.snapshotKind === MANAGER_ALERT_SNAPSHOT_KIND
    );
    if (!existing) {
      const created = createSnapshotRow(input);
      created.id = `snapshot-${tenantDb.state.snapshots.length + 1}`;
      tenantDb.state.snapshots.push(cloneSnapshotRow(created));
      return created;
    }

    existing.snapshotMode = input.snapshotMode;
    existing.snapshotJson = structuredClone(input.snapshotJson);
    existing.scannedAt = input.now;
    existing.sentAt = input.snapshotMode === "sent" ? input.now : null;
    existing.updatedAt = input.now;
    return toManagerAlertSnapshotResult(existing);
  }

  const [row] = await tenantDb
    .insert(aiManagerAlertSnapshots)
    .values({
      officeId: input.officeId,
      snapshotKind: MANAGER_ALERT_SNAPSHOT_KIND,
      snapshotMode: input.snapshotMode,
      snapshotJson: input.snapshotJson as never,
      scannedAt: input.now,
      sentAt: input.snapshotMode === "sent" ? input.now : null,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [aiManagerAlertSnapshots.officeId, aiManagerAlertSnapshots.snapshotKind],
      set: {
        snapshotMode: input.snapshotMode,
        snapshotJson: input.snapshotJson as never,
        scannedAt: input.now,
        sentAt: input.snapshotMode === "sent" ? input.now : null,
        updatedAt: input.now,
      },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to persist manager alert snapshot");
  }

  return toManagerAlertSnapshotResult(row);
}

async function claimSendLedgerRow(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    recipientUserId: string;
    officeLocalDate: string;
    now: Date;
  }
) {
  if (isInMemoryTenantDb(tenantDb)) {
    const existing = tenantDb.state.sendLedger.find(
      (row) =>
        row.officeId === input.officeId &&
        row.recipientUserId === input.recipientUserId &&
        row.summaryType === MANAGER_ALERT_NOTIFICATION_TYPE &&
        row.officeLocalDate === input.officeLocalDate
    );
    if (existing) return null;

    const claimed: ManagerAlertSendLedgerRow = {
      id: `ledger-${tenantDb.state.sendLedger.length + 1}`,
      officeId: input.officeId,
      recipientUserId: input.recipientUserId,
      summaryType: MANAGER_ALERT_NOTIFICATION_TYPE,
      officeLocalDate: input.officeLocalDate,
      claimedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    };
    tenantDb.state.sendLedger.push(claimed);
    return claimed;
  }

  const claimedRows = await tenantDb
    .insert(aiManagerAlertSendLedger)
    .values({
      officeId: input.officeId,
      recipientUserId: input.recipientUserId,
      summaryType: MANAGER_ALERT_NOTIFICATION_TYPE,
      officeLocalDate: input.officeLocalDate,
      claimedAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();

  return claimedRows[0] ?? null;
}

async function defaultNotificationFactory(
  input: ManagerAlertNotificationFactoryInput
): Promise<NotificationRow> {
  if (isInMemoryTenantDb(input.tenantDb)) {
    const notification: NotificationRow = {
      id: `notification-${input.tenantDb.state.notifications.length + 1}`,
      userId: input.recipientUserId,
      type: MANAGER_ALERT_NOTIFICATION_TYPE,
      title: input.title,
      body: input.body,
      link: input.link,
      isRead: false,
      readAt: null,
      createdAt: new Date(input.snapshot.sentAt ?? input.snapshot.scannedAt),
    } as NotificationRow;
    input.tenantDb.state.notifications.push(cloneNotification(notification));
    return notification;
  }

  const [row] = await (input.tenantDb as TenantDb)
    .insert(notifications)
    .values({
      userId: input.recipientUserId,
      type: MANAGER_ALERT_NOTIFICATION_TYPE,
      title: input.title,
      body: input.body,
      link: input.link,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to persist manager alert notification");
  }

  return row as NotificationRow;
}

export async function getLatestManagerAlertSnapshot(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: { officeId: string }
): Promise<ManagerAlertSnapshotResult | null> {
  if (isInMemoryTenantDb(tenantDb)) {
    const row = tenantDb.state.snapshots
      .filter((snapshot) => snapshot.officeId === input.officeId && snapshot.snapshotKind === MANAGER_ALERT_SNAPSHOT_KIND)
      .slice()
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime())[0];
    return row ? toManagerAlertSnapshotResult(row) : null;
  }

  const rows = await tenantDb
    .select()
    .from(aiManagerAlertSnapshots)
    .where(and(eq(aiManagerAlertSnapshots.officeId, input.officeId), eq(aiManagerAlertSnapshots.snapshotKind, MANAGER_ALERT_SNAPSHOT_KIND)))
    .orderBy(desc(aiManagerAlertSnapshots.updatedAt), desc(aiManagerAlertSnapshots.createdAt))
    .limit(1);

  return rows[0] ? toManagerAlertSnapshotResult(rows[0]) : null;
}

export async function runManagerAlertPreview(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: { officeId: string; timezone?: string | null; now?: Date }
): Promise<ManagerAlertSnapshotResult> {
  const now = input.now ?? new Date();
  const context = await loadManagerAlertContext(tenantDb, { officeId: input.officeId, timezone: input.timezone, now });
  const snapshotJson = buildManagerAlertSnapshotFromCases({
    officeId: input.officeId,
    timezone: context.timezone,
    now,
    cases: context.cases,
    usersById: context.usersById,
  });

  return persistSnapshot(tenantDb, {
    officeId: input.officeId,
    snapshotMode: "preview",
    snapshotJson,
    now,
  });
}

export async function sendManagerAlertSummary(
  tenantDb: TenantDb | InMemoryTenantDb,
  input: {
    officeId: string;
    recipientUserId: string;
    timezone?: string | null;
    now?: Date;
  },
  options?: {
    notificationFactory?: ManagerAlertNotificationFactory;
  }
): Promise<ManagerAlertSendResult> {
  const now = input.now ?? new Date();
  const notificationFactory = options?.notificationFactory ?? defaultNotificationFactory;

  if (isInMemoryTenantDb(tenantDb)) {
    const checkpoint = {
      snapshots: tenantDb.state.snapshots.map((row) => ({ ...row, snapshotJson: structuredClone(row.snapshotJson) })),
      sendLedger: tenantDb.state.sendLedger.map((row) => ({ ...row })),
      notifications: tenantDb.state.notifications.map((row) => ({ ...row })),
    };

    try {
      const context = await loadManagerAlertContext(tenantDb, { officeId: input.officeId, timezone: input.timezone, now });
      const snapshotJson = buildManagerAlertSnapshotFromCases({
        officeId: input.officeId,
        timezone: context.timezone,
        now,
        cases: context.cases,
        usersById: context.usersById,
      });
      const officeLocalDate = getOfficeLocalDate(now, context.timezone);
      const claimed = await claimSendLedgerRow(tenantDb, {
        officeId: input.officeId,
        recipientUserId: input.recipientUserId,
        officeLocalDate,
        now,
      });
      if (!claimed) {
        const latest = await getLatestManagerAlertSnapshot(tenantDb, { officeId: input.officeId });
        if (!latest) throw new Error("Manager alert snapshot is missing");
        return { claimed: false, snapshot: latest, notification: null };
      }

      const snapshot = await persistSnapshot(tenantDb, {
        officeId: input.officeId,
        snapshotMode: "sent",
        snapshotJson,
        now,
      });
      const notification = await notificationFactory({
        tenantDb,
        recipientUserId: input.recipientUserId,
        snapshot,
        title: buildNotificationTitle(snapshot.snapshotJson),
        body: buildNotificationBody(snapshot.snapshotJson),
        link: MANAGER_ALERT_FAMILY_LINK,
      });
      return { claimed: true, snapshot, notification };
    } catch (error) {
      tenantDb.state.snapshots = checkpoint.snapshots.map((row) => ({ ...row, snapshotJson: structuredClone(row.snapshotJson) }));
      tenantDb.state.sendLedger = checkpoint.sendLedger.map((row) => ({ ...row }));
      tenantDb.state.notifications = checkpoint.notifications.map((row) => ({ ...row }));
      throw error;
    }
  }

  return tenantDb.transaction(async (tx) => {
    await applyOfficeSearchPath(tx as TenantDb, input.officeId);
    const context = await loadManagerAlertContext(tx, { officeId: input.officeId, timezone: input.timezone, now });
    const snapshotJson = buildManagerAlertSnapshotFromCases({
      officeId: input.officeId,
      timezone: context.timezone,
      now,
      cases: context.cases,
      usersById: context.usersById,
    });
    const officeLocalDate = getOfficeLocalDate(now, context.timezone);
    const claimed = await claimSendLedgerRow(tx, {
      officeId: input.officeId,
      recipientUserId: input.recipientUserId,
      officeLocalDate,
      now,
    });
    if (!claimed) {
      const latest = await getLatestManagerAlertSnapshot(tx, { officeId: input.officeId });
      if (!latest) throw new Error("Manager alert snapshot is missing");
      return { claimed: false, snapshot: latest, notification: null };
    }

    const snapshot = await persistSnapshot(tx, {
      officeId: input.officeId,
      snapshotMode: "sent",
      snapshotJson,
      now,
    });
    const notification = await notificationFactory({
      tenantDb: tx as TenantDb,
      recipientUserId: input.recipientUserId,
      snapshot,
      title: buildNotificationTitle(snapshot.snapshotJson),
      body: buildNotificationBody(snapshot.snapshotJson),
      link: MANAGER_ALERT_FAMILY_LINK,
    });

    return {
      claimed: true,
      snapshot,
      notification,
    };
  });
}
