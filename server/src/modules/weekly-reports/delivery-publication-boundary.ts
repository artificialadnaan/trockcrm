import type { QueryExecutor } from "./projects-service.js";

/**
 * Serializes the first page of a Core client-history walk with delivery-webhook verdict writes.
 *
 * A provider event carries its own occurrence time, but a delayed webhook can be received much later.
 * The portal pagination boundary therefore has to linearize against when CRM learned the verdict, not
 * against the provider clock. Both the webhook writer and the first-page reader take this transaction
 * lock; the reader samples its boundary only after the lock is held.
 */
export const CORE_WEEKLY_REPORT_DELIVERY_BOUNDARY_LOCK =
  "weekly-report-core-client-delivery-boundary:v1" as const;

export async function lockCoreWeeklyReportDeliveryBoundary(
  client: QueryExecutor,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || current_schema(), 0))",
    [CORE_WEEKLY_REPORT_DELIVERY_BOUNDARY_LOCK],
  );
}

/** Capture a full-precision UTC boundary after all publication writers that arrived first committed. */
export async function captureCoreWeeklyReportDeliveryBoundary(
  client: QueryExecutor,
): Promise<string> {
  await lockCoreWeeklyReportDeliveryBoundary(client);
  const result = await client.query(
    `SELECT to_char(
              clock_timestamp() AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS captured_at`,
  );
  const value = result.rows[0]?.captured_at;
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) {
    throw new Error("Weekly-report delivery boundary clock is unavailable");
  }
  return value;
}
