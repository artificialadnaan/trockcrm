import { eq, and, or, desc, sql, isNull } from "drizzle-orm";
import { reportRuns, reportSchedules, savedReports } from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import type { ReportConfig } from "./service.js";

export interface CreateSavedReportInput {
  name: string;
  entity: string;
  config: ReportConfig;
  visibility?: string;
  officeId: string;
  createdBy: string;
}

export interface UpdateSavedReportInput {
  name?: string;
  config?: ReportConfig;
  visibility?: string;
}

export type ReportRecipient = {
  user_id?: string;
  email?: string;
};

export interface CreateReportScheduleInput {
  reportId: string;
  userId: string;
  officeId: string;
  frequency: "daily" | "weekly" | "biweekly" | "monthly" | "quarterly";
  cronExpr: string;
  recipients?: ReportRecipient[];
  nextRunAt: string;
}

export interface CreateReportRunInput {
  reportId: string;
  userId: string;
  officeId: string;
  scheduleId?: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError(400, `${label} must be a valid UUID`);
  }
}

function visibleSavedReportWhere(userId: string, officeId: string) {
  return or(
    and(
      eq(savedReports.isLocked, true),
      or(
        eq(savedReports.officeId, officeId),
        isNull(savedReports.officeId)
      )
    ),
    eq(savedReports.createdBy, userId),
    and(
      eq(savedReports.officeId, officeId),
      eq(savedReports.visibility, "office")
    ),
    eq(savedReports.visibility, "company")
  );
}

/**
 * Get all reports visible to a user:
 * - locked reports scoped to the caller's office (or global locked reports with no office)
 * - reports created by the user (private)
 * - reports shared to their office
 * - reports shared company-wide
 */
export async function getSavedReports(
  userId: string,
  officeId: string
) {
  const reports = await db
    .select()
    .from(savedReports)
    .where(visibleSavedReportWhere(userId, officeId))
    .orderBy(desc(savedReports.isLocked), desc(savedReports.isDefault), desc(savedReports.updatedAt));

  return reports;
}

/**
 * Get a single report by ID with visibility check.
 * - Private reports: only visible to the creator
 * - Office reports: visible to users in the same office
 * - Company reports: visible to all
 * - Locked reports: visible to all
 */
export async function getSavedReportById(
  reportId: string,
  userId?: string,
  officeId?: string
) {
  if (!userId || !officeId) return null;

  const result = await db
    .select()
    .from(savedReports)
    .where(and(eq(savedReports.id, reportId), visibleSavedReportWhere(userId, officeId)))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Create a custom saved report.
 */
export async function createSavedReport(input: CreateSavedReportInput) {
  const result = await db
    .insert(savedReports)
    .values({
      name: input.name,
      entity: input.entity as any,
      config: input.config,
      isLocked: false,
      isDefault: false,
      createdBy: input.createdBy,
      officeId: input.officeId,
      visibility: (input.visibility as any) ?? "private",
    })
    .returning();

  return result[0];
}

/**
 * Update a custom saved report.
 * Locked reports cannot be updated.
 */
export async function updateSavedReport(
  reportId: string,
  input: UpdateSavedReportInput,
  userId: string
) {
  // Fetch without visibility check -- ownership is verified below
  const rows = await db
    .select()
    .from(savedReports)
    .where(eq(savedReports.id, reportId))
    .limit(1);
  const existing = rows[0] ?? null;
  if (!existing) throw new AppError(404, "Report not found");
  if (existing.isLocked) throw new AppError(403, "Cannot edit a locked report");
  if (existing.createdBy !== userId) throw new AppError(403, "You can only edit your own reports");

  const updates: Record<string, any> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.config !== undefined) updates.config = input.config;
  if (input.visibility !== undefined) updates.visibility = input.visibility;
  updates.updatedAt = new Date();

  if (Object.keys(updates).length === 0) return existing;

  const result = await db
    .update(savedReports)
    .set(updates)
    .where(eq(savedReports.id, reportId))
    .returning();

  return result[0];
}

/**
 * Delete a custom saved report.
 * Locked reports cannot be deleted.
 */
export async function deleteSavedReport(reportId: string, userId: string) {
  // Fetch without visibility check -- ownership is verified below
  const rows = await db
    .select()
    .from(savedReports)
    .where(eq(savedReports.id, reportId))
    .limit(1);
  const existing = rows[0] ?? null;
  if (!existing) throw new AppError(404, "Report not found");
  if (existing.isLocked) throw new AppError(403, "Cannot delete a locked report");
  if (existing.createdBy !== userId) throw new AppError(403, "You can only delete your own reports");

  await db.delete(savedReports).where(eq(savedReports.id, reportId));
  return { success: true };
}

export async function getReportSchedules(userId: string, officeId: string) {
  return db
    .select({
      id: reportSchedules.id,
      reportId: reportSchedules.reportId,
      reportName: savedReports.name,
      frequency: reportSchedules.frequency,
      cronExpr: reportSchedules.cronExpr,
      recipients: reportSchedules.recipients,
      anchorDay: reportSchedules.anchorDay,
      nextRunAt: reportSchedules.nextRunAt,
      lastRunAt: reportSchedules.lastRunAt,
      ownerId: reportSchedules.ownerId,
      isActive: reportSchedules.isActive,
      createdAt: reportSchedules.createdAt,
      updatedAt: reportSchedules.updatedAt,
    })
    .from(reportSchedules)
    .innerJoin(savedReports, eq(reportSchedules.reportId, savedReports.id))
    .where(visibleSavedReportWhere(userId, officeId))
    .orderBy(reportSchedules.nextRunAt);
}

export async function getReportRuns(userId: string, officeId: string) {
  return db
    .select({
      id: reportRuns.id,
      reportId: reportRuns.reportId,
      reportName: savedReports.name,
      scheduleId: reportRuns.scheduleId,
      startedAt: reportRuns.startedAt,
      finishedAt: reportRuns.finishedAt,
      status: reportRuns.status,
      resultUri: reportRuns.resultUri,
      error: reportRuns.error,
      runtimeMs: reportRuns.runtimeMs,
    })
    .from(reportRuns)
    .innerJoin(savedReports, eq(reportRuns.reportId, savedReports.id))
    .where(visibleSavedReportWhere(userId, officeId))
    .orderBy(desc(reportRuns.startedAt));
}

async function getSavedReportForOfficeWrite(reportId: string, userId: string, officeId: string) {
  assertUuid(reportId, "reportId");

  const rows = await db
    .select()
    .from(savedReports)
    .where(and(eq(savedReports.id, reportId), visibleSavedReportWhere(userId, officeId)))
    .limit(1);

  return rows[0] ?? null;
}

export async function createReportSchedule(input: CreateReportScheduleInput) {
  assertUuid(input.reportId, "reportId");

  const report = await getSavedReportForOfficeWrite(input.reportId, input.userId, input.officeId);
  if (!report) throw new AppError(404, "Report not found");

  const result = await db
    .insert(reportSchedules)
    .values({
      reportId: input.reportId,
      frequency: input.frequency,
      cronExpr: input.cronExpr,
      recipients: input.recipients ?? [],
      anchorDay: new Date(input.nextRunAt).getUTCDate(),
      nextRunAt: new Date(input.nextRunAt),
      ownerId: input.userId,
    })
    .returning();

  return result[0];
}

export async function createReportRun(input: CreateReportRunInput) {
  assertUuid(input.reportId, "reportId");
  if (input.scheduleId) {
    assertUuid(input.scheduleId, "scheduleId");
  }

  const report = await getSavedReportForOfficeWrite(input.reportId, input.userId, input.officeId);
  if (!report) throw new AppError(404, "Report not found");

  if (input.scheduleId) {
    const scheduleRows = await db
      .select({ reportId: reportSchedules.reportId })
      .from(reportSchedules)
      .where(eq(reportSchedules.id, input.scheduleId))
      .limit(1);
    const schedule = scheduleRows[0] ?? null;
    if (!schedule) throw new AppError(404, "Schedule not found");
    if (schedule.reportId !== input.reportId) {
      throw new AppError(400, "scheduleId does not belong to reportId");
    }
  }

  const result = await db
    .insert(reportRuns)
    .values({
      reportId: input.reportId,
      scheduleId: input.scheduleId ?? null,
      status: "queued",
    })
    .returning();

  return result[0];
}

/**
 * Seed the locked company reports if they don't already exist.
 * Called once during server startup or via admin endpoint.
 */
export async function seedLockedReports(officeId: string) {
  const existing = await db
    .select({ name: savedReports.name })
    .from(savedReports)
    .where(and(eq(savedReports.isLocked, true), eq(savedReports.officeId, officeId)));

  const existingNames = new Set(existing.map((report: { name: string }) => report.name));

  const lockedReports: Array<{
    name: string;
    entity: string;
    config: object;
  }> = [
    {
      name: "Unified Workflow Overview",
      entity: "deals",
      config: {
        reportType: "workflow_overview",
        chart_type: "table",
      },
    },
    {
      name: "Pipeline Summary (Excluding DD)",
      entity: "deals",
      config: {
        reportType: "pipeline_summary",
        includeDd: false,
        chart_type: "bar",
      },
    },
    {
      name: "Pipeline Summary (With DD)",
      entity: "deals",
      config: {
        reportType: "pipeline_summary",
        includeDd: true,
        chart_type: "bar",
      },
    },
    {
      name: "Weighted Pipeline Forecast",
      entity: "deals",
      config: {
        reportType: "weighted_forecast",
        chart_type: "bar",
      },
    },
    {
      name: "Win/Loss Ratio by Rep",
      entity: "deals",
      config: {
        reportType: "win_loss_ratio",
        chart_type: "bar",
      },
    },
    {
      name: "Activity Summary by Rep",
      entity: "activities",
      config: {
        reportType: "activity_summary",
        chart_type: "bar",
      },
    },
    {
      name: "Stale Deals Report",
      entity: "deals",
      config: {
        reportType: "stale_deals",
        chart_type: "table",
      },
    },
    {
      name: "Lost Deals by Reason",
      entity: "deals",
      config: {
        reportType: "lost_by_reason",
        chart_type: "bar",
      },
    },
    {
      name: "Revenue by Project Type",
      entity: "deals",
      config: {
        reportType: "revenue_by_project_type",
        chart_type: "pie",
      },
    },
    {
      name: "Lead Source ROI",
      entity: "deals",
      config: {
        reportType: "lead_source_roi",
        chart_type: "bar",
      },
    },
    {
      name: "Won Deals Summary",
      entity: "deals",
      config: {
        reportType: "won_summary",
        chart_type: "bar",
      },
    },
    {
      name: "Pipeline by Rep",
      entity: "deals",
      config: {
        reportType: "pipeline_by_rep",
        chart_type: "bar",
      },
    },
  ];

  const missingReports = lockedReports.filter((report) => !existingNames.has(report.name));
  if (missingReports.length === 0) return;

  await db.insert(savedReports).values(
    missingReports.map((r) => ({
      name: r.name,
      entity: r.entity as any,
      config: r.config,
      isLocked: true,
      isDefault: true,
      officeId,
      visibility: "company" as const,
    }))
  );
}
