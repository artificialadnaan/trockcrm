import type pg from "pg";
import {
  runPerOfficeTransactionalStep,
  validateOfficeSchemaName,
} from "./per-office-step.js";

export const WEEKLY_REPORT_DELIVERY_RECORDED_AT_MIGRATION =
  "0242_weekly_report_delivery_recorded_at.sql";

const TENANT_START = "-- TENANT_SCHEMA_START";
const TENANT_END = "-- TENANT_SCHEMA_END";

function markerBounds(migrationSql: string): { start: number; end: number } {
  const start = migrationSql.indexOf(TENANT_START);
  const end = migrationSql.indexOf(TENANT_END, start + TENANT_START.length);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `${WEEKLY_REPORT_DELIVERY_RECORDED_AT_MIGRATION} is missing its tenant-schema markers`,
    );
  }
  return { start, end };
}

/** Public trigger functions only; safe to install once before any tenant table is touched. */
export function extractWeeklyReportDeliveryBoundaryGlobals(migrationSql: string): string {
  const { start } = markerBounds(migrationSql);
  const globals = migrationSql.slice(0, start).trim();
  if (
    !globals.includes("public.weekly_report_delivery_boundary_lock_v1") ||
    !globals.includes("public.weekly_report_delivery_boundary_try_lock_v1") ||
    !globals.includes("public.weekly_report_delivery_recorded_guard_v1") ||
    !globals.includes("public.install_weekly_report_delivery_boundary_v1") ||
    !globals.includes("weekly_report_delivery_boundary_on_office_provision")
  ) {
    throw new Error(
      `${WEEKLY_REPORT_DELIVERY_RECORDED_AT_MIGRATION} is missing its boundary functions`,
    );
  }
  return globals;
}

/**
 * Render the same tenant template used by office provisioning for one validated existing office.
 * `runPerOfficeTransactionalStep` validates schemaName before this callback can run.
 */
export function renderWeeklyReportDeliveryTenantStep(
  migrationSql: string,
  schemaName: string,
): string {
  const safeSchemaName = validateOfficeSchemaName(schemaName);
  const { start, end } = markerBounds(migrationSql);
  const template = migrationSql.slice(start + TENANT_START.length, end).trim();
  if (!template.includes("office_dallas")) {
    throw new Error(
      `${WEEKLY_REPORT_DELIVERY_RECORDED_AT_MIGRATION} tenant template has no Dallas anchor`,
    );
  }
  return template.replace(/office_dallas/g, safeSchemaName);
}

/**
 * Install migration 0242 without accumulating tenant-table locks across offices.
 *
 * The global trigger functions commit first. Each existing office then receives the exact new-office
 * template inside its own short transaction; its column backfill, trigger cutover and CHECK validation
 * commit before discovery advances to the next office.
 */
export async function runWeeklyReportDeliveryRecordedAtMigration(
  client: pg.Client,
  migrationSql: string,
): Promise<void> {
  await client.query(extractWeeklyReportDeliveryBoundaryGlobals(migrationSql));
  await runPerOfficeTransactionalStep(client, {
    label: "0242 weekly-report delivery receipt boundary",
    table: "weekly_reports",
    // Stable pre-0242 capability. The template itself adds the new receipt column.
    requiredColumn: "id",
    capabilityColumns: [
      "send_delivered_at",
      "send_delivery_status",
      "send_delivery_status_at",
      "send_delivery_detail",
    ],
    buildStatements: (_schema, schemaName) => [
      renderWeeklyReportDeliveryTenantStep(migrationSql, schemaName),
    ],
  });
}
