import { eq, and, or, desc, sql, isNull } from "drizzle-orm";
import { savedReports } from "@trock-crm/shared/schema";
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
    .where(
      or(
        // Locked reports: scoped to caller's office or global (officeId IS NULL)
        and(
          eq(savedReports.isLocked, true),
          or(
            eq(savedReports.officeId, officeId),
            isNull(savedReports.officeId)
          )
        ),
        // Own reports (private)
        eq(savedReports.createdBy, userId),
        // Office-shared reports in the same office
        and(
          eq(savedReports.officeId, officeId),
          eq(savedReports.visibility, "office")
        ),
        // Company-wide reports
        eq(savedReports.visibility, "company")
      )
    )
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
  const result = await db
    .select()
    .from(savedReports)
    .where(eq(savedReports.id, reportId))
    .limit(1);

  const report = result[0] ?? null;
  if (!report) return null;

  // Locked and company-wide reports are visible to everyone
  if (report.isLocked || report.visibility === "company") return report;

  // If no user context provided, deny access to restricted reports
  if (!userId || !officeId) return null;

  // Private reports: only visible to creator
  if (report.visibility === "private" && report.createdBy !== userId) return null;

  // Office reports: visible to users in the same office
  if (report.visibility === "office" && report.officeId !== officeId) return null;

  return report;
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

/**
 * Seed the locked company reports if they don't already exist.
 * Called once during server startup or via admin endpoint.
 */
export async function seedLockedReports(officeId: string) {
  // Check if locked reports already exist for this office
  const existing = await db
    .select({ id: savedReports.id })
    .from(savedReports)
    .where(and(eq(savedReports.isLocked, true), eq(savedReports.officeId, officeId)))
    .limit(1);

  if (existing.length > 0) return; // already seeded

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
      name: "Closed-Won Summary",
      entity: "deals",
      config: {
        reportType: "closed_won_summary",
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

  await db.insert(savedReports).values(
    lockedReports.map((r) => ({
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
