import { pool } from "../db.js";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";

const SERVER_OFFICE_TIMEZONE_MODULES = [
  "../../../server/dist/lib/office-timezone.js",
  "../../../server/src/lib/office-timezone.js",
] as const;

const SERVER_MANAGER_ALERT_SERVICE_MODULES = [
  "../../../server/dist/modules/ai-copilot/intervention-manager-alerts-service.js",
  "../../../server/src/modules/ai-copilot/intervention-manager-alerts-service.js",
] as const;

async function importFirstAvailable<T>(paths: readonly string[]): Promise<T> {
  let lastError: unknown;

  for (const path of paths) {
    try {
      return (await import(path)) as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to import server manager alert modules");
}

async function getOfficeTimeHelpers() {
  return importFirstAvailable<{
    getOfficeLocalTimeParts: (input: { timezone: string; nowUtc: Date }) => { weekday: string; isWeekend: boolean };
    getOfficeTimezone: (input?: { timezone?: string | null } | null) => string;
    isOfficeLocalSendDue: (input: { timezone: string; nowUtc: Date; targetHour: number }) => boolean;
  }>(SERVER_OFFICE_TIMEZONE_MODULES);
}

async function getManagerAlertService() {
  return importFirstAvailable<{
    runManagerAlertPreview: (
      tenantDb: unknown,
      input: { officeId: string; timezone?: string | null; now?: Date }
    ) => Promise<{ snapshotJson: ManagerAlertSnapshotJson }>;
    sendManagerAlertSummary: (
      tenantDb: unknown,
      input: { officeId: string; recipientUserId: string; timezone?: string | null; now?: Date }
    ) => Promise<{ claimed: boolean }>;
  }>(SERVER_MANAGER_ALERT_SERVICE_MODULES);
}

type ManagerAlertSnapshotJson = {
  families: {
    overdueHighCritical: { count: number };
    snoozeBreached: { count: number };
    escalatedOpen: { count: number };
    assigneeOverload: { count: number };
  };
};

function computeAdvisoryLockId(value: string) {
  let lockId = 0;
  for (const char of value) {
    lockId = ((lockId * 31) + char.charCodeAt(0)) >>> 0;
  }
  return lockId;
}

function hasActiveAlertFamilies(snapshotJson: ManagerAlertSnapshotJson) {
  return (
    snapshotJson.families.overdueHighCritical.count > 0 ||
    snapshotJson.families.snoozeBreached.count > 0 ||
    snapshotJson.families.escalatedOpen.count > 0 ||
    snapshotJson.families.assigneeOverload.count > 0
  );
}

export async function runAiInterventionManagerAlerts(input?: { now?: Date }): Promise<void> {
  const now = input?.now ?? new Date();
  console.log("[Worker:ai-intervention-manager-alerts] Starting manager alert scheduling...");
  const { getOfficeLocalTimeParts, getOfficeTimezone, isOfficeLocalSendDue } = await getOfficeTimeHelpers();
  const { runManagerAlertPreview, sendManagerAlertSummary } = await getManagerAlertService();

  const client = await pool.connect();
  try {
    const offices = await client.query(
      "SELECT id, slug, timezone FROM public.offices WHERE is_active = true"
    );

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:ai-intervention-manager-alerts] Invalid office slug: \"${office.slug}\" -- skipping`);
        continue;
      }

      let timezone: string;
      try {
        timezone = getOfficeTimezone({ timezone: office.timezone });
      } catch (error) {
        console.error(`[Worker:ai-intervention-manager-alerts] Invalid timezone for ${office.slug} -- skipping`, error);
        continue;
      }

      const localTime = getOfficeLocalTimeParts({ timezone, nowUtc: now });
      if (localTime.isWeekend) {
        console.log(
          `[Worker:ai-intervention-manager-alerts] Skipping office ${office.slug}: weekend in ${timezone} (${localTime.weekday})`
        );
        continue;
      }

      if (!isOfficeLocalSendDue({ timezone, nowUtc: now, targetHour: 8 })) {
        continue;
      }

      const schemaName = `office_${office.slug}`;
      const schemaCheck = await client.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1",
        [schemaName]
      );
      if (schemaCheck.rows.length === 0) {
        console.warn(`[Worker:ai-intervention-manager-alerts] Skipping office ${office.slug}: schema ${schemaName} does not exist`);
        continue;
      }

      const lockId = computeAdvisoryLockId(`manager_alerts:${office.id}`);
      const lockResult = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [lockId]);
      if (!lockResult.rows[0]?.acquired) continue;

      try {
        const recipients = await client.query(
          `SELECT id
           FROM public.users
           WHERE office_id = $1
             AND role IN ('admin', 'director')
             AND is_active = true`,
          [office.id]
        );

        if (recipients.rows.length === 0) {
          console.log(`[Worker:ai-intervention-manager-alerts] Skipping office ${office.slug}: no active admin/director recipients`);
          continue;
        }

        await client.query("SELECT set_config('search_path', $1, false)", [`${schemaName},public`]);
        const officeDb = drizzle(client, { schema });

        const preview = await runManagerAlertPreview(officeDb, {
          officeId: office.id,
          timezone,
          now,
        });

        if (!hasActiveAlertFamilies(preview.snapshotJson)) {
          console.log(`[Worker:ai-intervention-manager-alerts] Skipping office ${office.slug}: no active manager alerts`);
          continue;
        }

        let deliveredCount = 0;
        let suppressedCount = 0;
        for (const recipient of recipients.rows) {
          try {
            const result = await sendManagerAlertSummary(officeDb, {
              officeId: office.id,
              recipientUserId: recipient.id,
              timezone,
              now,
            });
            if (result.claimed) {
              deliveredCount += 1;
            } else {
              suppressedCount += 1;
            }
          } catch (error) {
            console.error(
              `[Worker:ai-intervention-manager-alerts] Failed to send manager alert to ${recipient.id} for office ${office.slug}:`,
              error
            );
          }
        }

        console.log(
          `[Worker:ai-intervention-manager-alerts] Sent manager alerts for office ${office.slug}: ${deliveredCount} delivered, ${suppressedCount} suppressed`
        );
      } catch (error) {
        console.error(`[Worker:ai-intervention-manager-alerts] Failed for office ${office.slug}:`, error);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => {});
      }
    }
  } finally {
    client.release();
  }
}
