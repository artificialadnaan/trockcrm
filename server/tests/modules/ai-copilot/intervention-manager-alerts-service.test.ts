import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_TYPES } from "../../../../shared/src/types/enums.js";
import {
  aiDisconnectCases,
  aiManagerAlertSendLedger,
  aiManagerAlertSnapshotModeEnum,
  aiManagerAlertSnapshots,
  notifications,
  offices,
  notificationTypeEnum,
  users,
} from "../../../../shared/src/schema/index.js";
import {
  getLatestManagerAlertSnapshot,
  runManagerAlertPreview,
  sendManagerAlertSummary,
} from "../../../src/modules/ai-copilot/intervention-manager-alerts-service.js";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));

const migrationSql = readFileSync(
  new URL("../../../../migrations/0029_ai_manager_alerts.sql", import.meta.url),
  "utf8"
);

type ManagerAlertCaseRecord = {
  id: string;
  officeId: string;
  severity: "critical" | "high" | "medium" | "low";
  status: "open" | "snoozed" | "resolved";
  assignedTo: string | null;
  disconnectType: string;
  escalated: boolean;
  snoozedUntil: Date | null;
  reopenCount: number;
  currentLifecycleStartedAt: Date;
  lastDetectedAt: Date;
  lastIntervenedAt: Date | null;
  resolvedAt: Date | null;
  companyId: string | null;
  dealId: string | null;
  metadataJson: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

type ManagerAlertSnapshotRecord = {
  id: string;
  officeId: string;
  snapshotKind: string;
  snapshotMode: "preview" | "sent";
  snapshotJson: Record<string, unknown>;
  scannedAt: Date;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ManagerAlertSendLedgerRecord = {
  id: string;
  officeId: string;
  recipientUserId: string;
  summaryType: string;
  officeLocalDate: string;
  claimedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type ManagerAlertNotificationRecord = {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
};

type ManagerAlertOfficeRecord = {
  id: string;
  timezone: string;
  slug?: string;
};

type ManagerAlertUserRecord = {
  id: string;
  displayName: string;
};

function makeCase(overrides: Partial<ManagerAlertCaseRecord> = {}): ManagerAlertCaseRecord {
  const now = new Date("2026-04-16T15:00:00.000Z");
  return {
    id: "case-1",
    officeId: "office-1",
    severity: "high",
    status: "open",
    assignedTo: "user-a",
    disconnectType: "missing_next_task",
    escalated: false,
    snoozedUntil: null,
    reopenCount: 0,
    currentLifecycleStartedAt: new Date("2026-04-10T15:00:00.000Z"),
    lastDetectedAt: now,
    lastIntervenedAt: null,
    resolvedAt: null,
    companyId: "company-1",
    dealId: "deal-1",
    metadataJson: {
      companyName: "Acme Property Group",
      dealName: "Alpha Plaza",
      stageName: "Estimating",
      stageKey: "estimating",
      assignedRepId: "rep-1",
      assignedRepName: "Rep One",
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createTenantDb(state?: {
  cases?: ManagerAlertCaseRecord[];
  snapshots?: ManagerAlertSnapshotRecord[];
  sendLedger?: ManagerAlertSendLedgerRecord[];
  notifications?: ManagerAlertNotificationRecord[];
  offices?: ManagerAlertOfficeRecord[];
  users?: ManagerAlertUserRecord[];
}) {
  return {
    state: {
      cases: state?.cases ? state.cases.map((row) => ({ ...row })) : [],
      snapshots: state?.snapshots ? state.snapshots.map((row) => ({ ...row })) : [],
      sendLedger: state?.sendLedger ? state.sendLedger.map((row) => ({ ...row })) : [],
      notifications: state?.notifications ? state.notifications.map((row) => ({ ...row })) : [],
      offices: state?.offices ? state.offices.map((row) => ({ ...row })) : [],
      users: state?.users ? state.users.map((row) => ({ ...row })) : [],
    },
  };
}

function createTransactionalDbHarness(state?: {
  cases?: ManagerAlertCaseRecord[];
  snapshots?: ManagerAlertSnapshotRecord[];
  sendLedger?: ManagerAlertSendLedgerRecord[];
  notifications?: ManagerAlertNotificationRecord[];
  offices?: ManagerAlertOfficeRecord[];
  users?: ManagerAlertUserRecord[];
}, options?: { failNotificationInsert?: boolean }) {
  const tableNames = {
    cases: getTableConfig(aiDisconnectCases).name,
    snapshots: getTableConfig(aiManagerAlertSnapshots).name,
    sendLedger: getTableConfig(aiManagerAlertSendLedger).name,
    notifications: getTableConfig(notifications).name,
    offices: getTableConfig(offices).name,
    users: getTableConfig(users).name,
  } as const;

  let currentState = {
    cases: state?.cases ? state.cases.map((row) => ({ ...row })) : [],
    snapshots: state?.snapshots ? state.snapshots.map((row) => ({ ...row })) : [],
    sendLedger: state?.sendLedger ? state.sendLedger.map((row) => ({ ...row })) : [],
    notifications: state?.notifications ? state.notifications.map((row) => ({ ...row })) : [],
    offices: state?.offices ? state.offices.map((row) => ({ ...row })) : [],
    users: state?.users ? state.users.map((row) => ({ ...row })) : [],
  };

  function resolveTableName(table: unknown) {
    if (!table || typeof table !== "object") return "unknown";
    try {
      return getTableConfig(table as never).name;
    } catch {
      return (table as { name?: string }).name ?? "unknown";
    }
  }

  function getRowsForSelect(table: unknown) {
    const tableName = resolveTableName(table);
    if (tableName === tableNames.cases) return currentState.cases;
    if (tableName === tableNames.snapshots) {
      return currentState.snapshots
        .slice()
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime());
    }
    if (tableName === tableNames.sendLedger) return currentState.sendLedger;
    if (tableName === tableNames.notifications) return currentState.notifications;
    if (tableName === tableNames.offices) return currentState.offices;
    if (tableName === tableNames.users) return currentState.users;
    return [];
  }

  function cloneValue<T>(value: T): T {
    return structuredClone(value);
  }

  function resolveInsertTable(table: unknown, values: Record<string, any>) {
    const tableName = resolveTableName(table);
    if (tableName !== "unknown") return tableName;
    if ("snapshotJson" in values && "snapshotKind" in values) return tableNames.snapshots;
    if ("officeLocalDate" in values && "summaryType" in values) return tableNames.sendLedger;
    if ("title" in values && "link" in values && "userId" in values) return tableNames.notifications;
    return tableName;
  }

  function applyInsert(table: unknown, values: Record<string, any>, mode: "plain" | "do-nothing" | "do-update", set?: Record<string, any>) {
    const tableName = resolveInsertTable(table, values);

    if (tableName === tableNames.snapshots) {
      const next = {
        id: `snapshot-${currentState.snapshots.length + 1}`,
        officeId: values.officeId,
        snapshotKind: values.snapshotKind,
        snapshotMode: values.snapshotMode,
        snapshotJson: cloneValue(values.snapshotJson),
        scannedAt: values.scannedAt ?? new Date(),
        sentAt: values.sentAt ?? null,
        createdAt: values.createdAt ?? values.scannedAt ?? new Date(),
        updatedAt: values.updatedAt ?? values.scannedAt ?? new Date(),
      } as ManagerAlertSnapshotRecord;
      const index = currentState.snapshots.findIndex(
        (row) => row.officeId === next.officeId && row.snapshotKind === next.snapshotKind
      );
      if (index >= 0 && mode === "do-update") {
        currentState.snapshots[index] = { ...currentState.snapshots[index], ...next };
        return [cloneValue(currentState.snapshots[index])];
      }
      if (index >= 0) {
        currentState.snapshots[index] = { ...currentState.snapshots[index], ...next };
        return [cloneValue(currentState.snapshots[index])];
      }
      currentState.snapshots.push(next);
      return [cloneValue(next)];
    }

    if (tableName === tableNames.sendLedger) {
      const existing = currentState.sendLedger.find(
        (row) =>
          row.officeId === values.officeId &&
          row.recipientUserId === values.recipientUserId &&
          row.summaryType === values.summaryType &&
          row.officeLocalDate === values.officeLocalDate
      );
      if (existing) return [];
      const next = {
        id: `ledger-${currentState.sendLedger.length + 1}`,
        officeId: values.officeId,
        recipientUserId: values.recipientUserId,
        summaryType: values.summaryType,
        officeLocalDate: values.officeLocalDate,
        claimedAt: values.claimedAt ?? new Date(),
        createdAt: values.createdAt ?? values.claimedAt ?? new Date(),
        updatedAt: values.updatedAt ?? values.claimedAt ?? new Date(),
      } as ManagerAlertSendLedgerRecord;
      currentState.sendLedger.push(next);
      return [cloneValue(next)];
    }

    if (tableName === tableNames.notifications) {
      if (options?.failNotificationInsert) {
        throw new Error("notification send failed");
      }
      const next = {
        id: `notification-${currentState.notifications.length + 1}`,
        userId: values.userId,
        type: values.type,
        title: values.title,
        body: values.body ?? null,
        link: values.link ?? null,
        isRead: values.isRead ?? false,
        readAt: values.readAt ?? null,
        createdAt: values.createdAt ?? new Date(),
      } as ManagerAlertNotificationRecord;
      currentState.notifications.push(next);
      return [cloneValue(next)];
    }

    throw new Error(`Unsupported insert table for test harness: ${resolveTableName(table)}`);
  }

  const db: any = {
    select: vi.fn(() => {
      const chain: any = {
        from: vi.fn((table: unknown) => {
          const query: { limitValue?: number } = {};
          const queryChain: any = {
            where: vi.fn(() => queryChain),
            orderBy: vi.fn(() => queryChain),
            limit: vi.fn((limit: number) => {
              query.limitValue = limit;
              return queryChain;
            }),
            then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => {
              const rows = getRowsForSelect(table);
              const limited = typeof query.limitValue === "number" ? rows.slice(0, query.limitValue) : rows;
              return Promise.resolve(cloneValue(limited)).then(resolve, reject);
            },
          };
          return queryChain;
        }),
      };
      return chain;
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, any>) => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => applyInsert(table, values, "do-nothing")),
        })),
        onConflictDoUpdate: vi.fn(({ set }: { set: Record<string, any> }) => ({
          returning: vi.fn(async () => applyInsert(table, values, "do-update", set)),
        })),
        returning: vi.fn(async () => applyInsert(table, values, "plain")),
      })),
    })),
    transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => {
      const checkpoint = cloneValue(currentState);
      try {
        return await fn(db);
      } catch (error) {
        currentState = checkpoint;
        throw error;
      }
    }),
    execute: vi.fn(async () => ({ rows: [] })),
  };

  return {
    db,
    get state() {
      return currentState;
    },
  };
}

describe("manager alert schema contract", () => {
  it("adds the manager alert summary notification type", () => {
    expect(NOTIFICATION_TYPES).toContain("manager_alert_summary");
  });

  it("defines one snapshot row per office and snapshot kind", () => {
    const columns = getTableColumns(aiManagerAlertSnapshots);
    const config = getTableConfig(aiManagerAlertSnapshots);

    expect(columns.officeId.notNull).toBe(true);
    expect(columns.snapshotKind.notNull).toBe(true);
    expect(columns.snapshotMode.notNull).toBe(true);
    expect(columns.snapshotMode.hasDefault).toBe(true);
    expect(columns.snapshotMode.default).toBe("preview");
    expect(aiManagerAlertSnapshotModeEnum.enumValues).toEqual(["preview", "sent"]);
    expect(columns.snapshotJson.notNull).toBe(true);
    expect(columns.snapshotJson.hasDefault).toBe(true);
    expect(columns.snapshotJson.default).toEqual({});
    expect(columns.scannedAt.notNull).toBe(true);
    expect(columns.scannedAt.hasDefault).toBe(true);
    expect(columns.sentAt.notNull).toBe(false);
    expect(
      config.indexes.map((index) => ({
        name: index.config.name,
        columns: index.config.columns.map((column) => column.name),
      }))
    ).toEqual([
      {
        name: "ai_manager_alert_snapshots_office_id_snapshot_kind_uidx",
        columns: ["office_id", "snapshot_kind"],
      },
    ]);
  });

  it("defines a send ledger dedupe key for one send per office local day", () => {
    const columns = getTableColumns(aiManagerAlertSendLedger);
    const config = getTableConfig(aiManagerAlertSendLedger);

    expect(columns.officeId.notNull).toBe(true);
    expect(columns.recipientUserId.notNull).toBe(true);
    expect(columns.summaryType.notNull).toBe(true);
    expect(columns.summaryType.enumValues).toEqual(notificationTypeEnum.enumValues);
    expect(NOTIFICATION_TYPES).toContain("manager_alert_summary");
    expect(columns.officeLocalDate.notNull).toBe(true);
    expect(columns.claimedAt.notNull).toBe(true);
    expect(columns.claimedAt.hasDefault).toBe(true);
    expect(
      config.indexes.map((index) => ({
        name: index.config.name,
        columns: index.config.columns.map((column) => column.name),
      }))
    ).toEqual([
      {
        name: "ai_manager_alert_send_ledger_office_id_recipient_user_id_summary_type_office_local_date_uidx",
        columns: ["office_id", "recipient_user_id", "summary_type", "office_local_date"],
      },
    ]);
  });

  it("creates the manager alert tables inside the tenant schema loop", () => {
    expect(migrationSql).toContain("ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'manager_alert_summary'");
    expect(migrationSql).toContain("DO $tenant$");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS ai_manager_alert_snapshots");
    expect(migrationSql).toContain("snapshot_mode ai_manager_alert_snapshot_mode NOT NULL DEFAULT 'preview'");
    expect(migrationSql).toContain("scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    expect(migrationSql).toContain("sent_at TIMESTAMPTZ");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS ai_manager_alert_send_ledger");
    expect(migrationSql).toContain("summary_type notification_type NOT NULL");
    expect(migrationSql).toContain("claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    expect(migrationSql).toContain("FOR schema_name IN");
    expect(migrationSql).toContain("WHERE nspname LIKE 'office\\_%' ESCAPE '\\'");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.ai_manager_alert_snapshots");
    expect(migrationSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS ai_manager_alert_snapshots_office_id_snapshot_kind_uidx");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.ai_manager_alert_send_ledger");
    expect(migrationSql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS ai_manager_alert_send_ledger_office_id_recipient_user_id_summary_type_office_local_date_uidx"
    );
  });
});

describe("manager alert service", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("builds and persists the manager alert families from intervention case state", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          id: "case-1",
          severity: "critical",
          currentLifecycleStartedAt: new Date("2026-04-10T15:00:00.000Z"),
        }),
        makeCase({
          id: "case-2",
          severity: "high",
          escalated: true,
          currentLifecycleStartedAt: new Date("2026-04-09T15:00:00.000Z"),
        }),
        makeCase({
          id: "case-3",
          severity: "medium",
          status: "snoozed",
          assignedTo: "user-b",
          snoozedUntil: new Date("2026-04-15T15:00:00.000Z"),
          currentLifecycleStartedAt: new Date("2026-04-01T15:00:00.000Z"),
        }),
        makeCase({
          id: "case-4",
          severity: "critical",
          currentLifecycleStartedAt: new Date("2026-04-11T15:00:00.000Z"),
        }),
        makeCase({
          id: "case-5",
          severity: "low",
          assignedTo: "user-c",
          currentLifecycleStartedAt: new Date("2026-04-15T15:00:00.000Z"),
        }),
      ],
      offices: [{ id: "office-1", slug: "one", timezone: "America/Chicago" }],
      users: [
        { id: "user-a", displayName: "Manager A" },
        { id: "user-b", displayName: "Manager B" },
        { id: "user-c", displayName: "Manager C" },
      ],
    });

    const snapshot = await runManagerAlertPreview(tenantDb as any, {
      officeId: "office-1",
      timezone: "America/Chicago",
      now: new Date("2026-04-16T15:00:00.000Z"),
    });

    expect(snapshot.snapshotMode).toBe("preview");
    expect(snapshot.snapshotKind).toBe("manager_alert_summary");
    expect(snapshot.snapshotJson.families.overdueHighCritical.count).toBe(3);
    expect(snapshot.snapshotJson.families.snoozeBreached.count).toBe(1);
    expect(snapshot.snapshotJson.families.escalatedOpen.count).toBe(1);
    expect(snapshot.snapshotJson.families.assigneeOverload.count).toBe(1);
    expect(snapshot.snapshotJson.families.assigneeOverload.items[0]).toMatchObject({
      assigneeId: "user-a",
      assigneeLabel: "Manager A",
      totalWeight: 18,
    });

    const latest = await getLatestManagerAlertSnapshot(tenantDb as any, {
      officeId: "office-1",
    });

    expect(latest?.snapshotMode).toBe("preview");
    expect(latest?.snapshotJson).toEqual(snapshot.snapshotJson);
    expect(tenantDb.state.snapshots).toHaveLength(1);
  });

  it("treats a snooze that expires at now as breached", async () => {
    const now = new Date("2026-04-16T15:00:00.000Z");
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          id: "case-1",
          severity: "medium",
          status: "snoozed",
          snoozedUntil: now,
          currentLifecycleStartedAt: new Date("2026-04-10T15:00:00.000Z"),
        }),
      ],
      offices: [{ id: "office-1", slug: "one", timezone: "America/Chicago" }],
      users: [{ id: "user-a", displayName: "Manager A" }],
    });

    const snapshot = await runManagerAlertPreview(tenantDb as any, {
      officeId: "office-1",
      timezone: "America/Chicago",
      now,
    });

    expect(snapshot.snapshotJson.families.snoozeBreached.count).toBe(1);
    expect(snapshot.snapshotJson.families.snoozeBreached.caseIds).toEqual(["case-1"]);
  });

  it("sends manager alerts using the persisted sent snapshot as the notification source", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          id: "case-1",
          severity: "critical",
          currentLifecycleStartedAt: new Date("2026-04-10T15:00:00.000Z"),
        }),
        makeCase({
          id: "case-2",
          severity: "high",
          escalated: true,
          currentLifecycleStartedAt: new Date("2026-04-09T15:00:00.000Z"),
        }),
        makeCase({
          id: "case-3",
          severity: "medium",
          status: "snoozed",
          assignedTo: "user-b",
          snoozedUntil: new Date("2026-04-15T15:00:00.000Z"),
          currentLifecycleStartedAt: new Date("2026-04-01T15:00:00.000Z"),
        }),
        makeCase({
          id: "case-4",
          severity: "critical",
          currentLifecycleStartedAt: new Date("2026-04-11T15:00:00.000Z"),
        }),
      ],
      offices: [{ id: "office-1", slug: "one", timezone: "America/Chicago" }],
      users: [{ id: "user-a", displayName: "Manager A" }],
    });

    const notificationFactory = vi.fn(async ({ snapshot, title, body, link }) => ({
      id: "notification-1",
      snapshot,
      title,
      body,
      link,
    }));

    const result = await sendManagerAlertSummary(
      tenantDb as any,
      {
        officeId: "office-1",
        recipientUserId: "user-a",
        timezone: "America/Chicago",
        now: new Date("2026-04-16T15:00:00.000Z"),
      },
      { notificationFactory }
    );

    expect(result.claimed).toBe(true);
    expect(result.snapshot.snapshotMode).toBe("sent");
    expect(result.snapshot.sentAt).not.toBeNull();
    expect(notificationFactory).toHaveBeenCalledTimes(1);
    expect(notificationFactory.mock.calls[0][0].snapshot).toEqual(result.snapshot);
    expect(notificationFactory.mock.calls[0][0].link).toBe("/admin/intervention-analytics");
    expect(notificationFactory.mock.calls[0][0].body).toContain("Overdue high/critical: 3.");
    expect(notificationFactory.mock.calls[0][0].body).toContain("Expired snoozes: 1.");
    expect(notificationFactory.mock.calls[0][0].body).toContain("Unresolved escalations: 1.");
    expect(notificationFactory.mock.calls[0][0].body).toContain("Assignee overload: 1.");
    expect(tenantDb.state.sendLedger).toHaveLength(1);
    expect(tenantDb.state.notifications).toHaveLength(0);
    expect(await getLatestManagerAlertSnapshot(tenantDb as any, { officeId: "office-1" })).toMatchObject({
      snapshotMode: "sent",
    });
  });

  it("uses the transactional db branch to persist, dedupe, and roll back manager alerts", async () => {
    const now = new Date("2026-04-16T15:00:00.000Z");
    const harness = createTransactionalDbHarness({
      cases: [
        makeCase({
          id: "case-1",
          severity: "critical",
          currentLifecycleStartedAt: new Date("2026-04-10T15:00:00.000Z"),
        }),
        makeCase({
          id: "case-2",
          severity: "high",
          escalated: true,
          currentLifecycleStartedAt: new Date("2026-04-09T15:00:00.000Z"),
        }),
      ],
      offices: [{ id: "office-1", slug: "one", timezone: "America/Chicago" }],
      users: [{ id: "user-a", displayName: "Manager A" }],
    });

    const first = await sendManagerAlertSummary(harness.db, {
      officeId: "office-1",
      recipientUserId: "user-a",
      timezone: "America/Chicago",
      now,
    });

    expect(harness.db.transaction).toHaveBeenCalledTimes(1);
    expect(harness.db.execute).toHaveBeenCalledTimes(1);
    expect(first.claimed).toBe(true);
    expect(first.snapshot.snapshotMode).toBe("sent");
    expect(harness.state.sendLedger).toHaveLength(1);
    expect(harness.state.notifications).toHaveLength(1);
    expect(harness.state.snapshots).toHaveLength(1);

    const second = await sendManagerAlertSummary(harness.db, {
      officeId: "office-1",
      recipientUserId: "user-a",
      timezone: "America/Chicago",
      now,
    });

    expect(harness.db.transaction).toHaveBeenCalledTimes(2);
    expect(second.claimed).toBe(false);
    expect(harness.state.sendLedger).toHaveLength(1);
    expect(harness.state.notifications).toHaveLength(1);
    expect(harness.state.snapshots).toHaveLength(1);
    expect(second.snapshot.snapshotMode).toBe("sent");

    const preview = await runManagerAlertPreview(harness.db, {
      officeId: "office-1",
      timezone: "America/Chicago",
      now,
    });
    expect(preview.snapshotMode).toBe("preview");

    const third = await sendManagerAlertSummary(harness.db, {
      officeId: "office-1",
      recipientUserId: "user-a",
      timezone: "America/Chicago",
      now,
    });

    expect(third.claimed).toBe(false);
    expect(third.snapshot.snapshotMode).toBe("sent");
    expect(third.snapshot.sentAt).not.toBeNull();

    const rollbackHarness = createTransactionalDbHarness(
      {
        cases: [
          makeCase({
            id: "case-1",
            severity: "critical",
            currentLifecycleStartedAt: new Date("2026-04-10T15:00:00.000Z"),
          }),
        ],
        offices: [{ id: "office-1", slug: "one", timezone: "America/Chicago" }],
        users: [{ id: "user-a", displayName: "Manager A" }],
      },
      { failNotificationInsert: true }
    );

    await expect(
      sendManagerAlertSummary(rollbackHarness.db, {
        officeId: "office-1",
        recipientUserId: "user-a",
        timezone: "America/Chicago",
        now,
      })
    ).rejects.toThrow("notification send failed");

    expect(rollbackHarness.db.transaction).toHaveBeenCalledTimes(1);
    expect(rollbackHarness.state.sendLedger).toHaveLength(0);
    expect(rollbackHarness.state.notifications).toHaveLength(0);
    expect(rollbackHarness.state.snapshots).toHaveLength(0);
  });

  it("rolls back the send ledger claim when notification creation fails", async () => {
    const tenantDb = createTenantDb({
      cases: [
        makeCase({
          id: "case-1",
          severity: "critical",
          currentLifecycleStartedAt: new Date("2026-04-10T15:00:00.000Z"),
        }),
      ],
      offices: [{ id: "office-1", slug: "one", timezone: "America/Chicago" }],
      users: [{ id: "user-a", displayName: "Manager A" }],
    });

    await expect(
      sendManagerAlertSummary(
        tenantDb as any,
        {
          officeId: "office-1",
          recipientUserId: "user-a",
          timezone: "America/Chicago",
          now: new Date("2026-04-16T15:00:00.000Z"),
        },
        {
          notificationFactory: vi.fn(async () => {
            throw new Error("notification send failed");
          }),
        }
      )
    ).rejects.toThrow("notification send failed");

    expect(tenantDb.state.sendLedger).toHaveLength(0);
    expect(tenantDb.state.snapshots).toHaveLength(0);
    expect(tenantDb.state.notifications).toHaveLength(0);
  });
});
