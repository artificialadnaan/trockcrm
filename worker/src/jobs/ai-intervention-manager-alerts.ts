import { pool, db } from "../db.js";
import {
  getOfficeLocalTimeParts,
  getOfficeTimezone,
  isOfficeLocalSendDue,
} from "../../../server/src/lib/office-timezone.js";
import {
  runManagerAlertPreview,
  sendManagerAlertSummary,
  type ManagerAlertSnapshotJson,
} from "../../../server/src/modules/ai-copilot/intervention-manager-alerts-service.js";

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

        const preview = await runManagerAlertPreview(db, {
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
            const result = await sendManagerAlertSummary(db, {
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
