import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

function createMockTenantDb(rows: any[] = []) {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
  } as any;
}

function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return "";
}

describe("runReportBuilder", () => {
  it("builds an allowlisted aggregate report from dimensions and measures", async () => {
    const { runReportBuilder } = await import("../../../src/modules/reports/report-builder-service.js");
    const tenantDb = createMockTenantDb([
      {
        stage: "Contract Signed",
        rep: "Rep One",
        deal_count: "3",
        total_value: "300000.00",
        avg_value: "100000.00",
        win_rate: "66.67",
        avg_cycle_time: "22.5",
        avg_age_in_stage: "7.2",
      },
    ]);

    const result = await runReportBuilder(tenantDb, {
      dimensions: ["stage", "rep"],
      measures: ["deal_count", "total_value", "avg_value", "win_rate", "avg_cycle_time", "avg_age_in_stage"],
      filters: { source: ["Referral"], from: "2026-01-01", to: "2026-12-31" },
      dateField: "created_at",
      role: "admin",
      userId: "admin-1",
    });

    expect(result.columns.map((column) => column.key)).toEqual([
      "stage",
      "rep",
      "deal_count",
      "total_value",
      "avg_value",
      "win_rate",
      "avg_cycle_time",
      "avg_age_in_stage",
    ]);
    expect(result.rows[0]).toMatchObject({
      stage: "Contract Signed",
      rep: "Rep One",
      deal_count: 3,
      total_value: 300000,
      avg_value: 100000,
    });
    expect(extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase()).toContain("group by");
  });

  it("rejects dimensions, measures, filters, and date fields outside the allowlist", async () => {
    const { runReportBuilder } = await import("../../../src/modules/reports/report-builder-service.js");
    const tenantDb = createMockTenantDb();

    await expect(runReportBuilder(tenantDb, {
      dimensions: ["stage; drop table deals"],
      measures: ["deal_count"],
      filters: {},
      dateField: "created_at",
      role: "admin",
      userId: "admin-1",
    })).rejects.toBeInstanceOf(AppError);
  });

  it("scopes rep users to their own deals", async () => {
    const { effectiveReportRepId, runReportBuilder } = await import("../../../src/modules/reports/report-builder-service.js");
    const tenantDb = createMockTenantDb([]);
    const input = {
      dimensions: ["rep"],
      measures: ["deal_count"],
      filters: { rep: ["rep-other"] },
      dateField: "created_at",
      role: "rep" as const,
      userId: "rep-self",
    };

    await runReportBuilder(tenantDb, input);

    expect(effectiveReportRepId(input)).toBe("rep-self");
    expect(extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase()).toContain("d.assigned_rep_id =");
  });

  it("excludes active on-hold deals from generated report row populations", async () => {
    const { runReportBuilder } = await import("../../../src/modules/reports/report-builder-service.js");
    const tenantDb = createMockTenantDb([]);

    await runReportBuilder(tenantDb, {
      dimensions: ["stage"],
      measures: ["deal_count", "total_value"],
      filters: {},
      dateField: "created_at",
      role: "admin",
      userId: "admin-1",
    });

    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(queryText).toContain("where");
    expect(queryText).toContain("d.is_active = true");
    expect(queryText).toContain("coalesce(d.on_hold, false) = false");
  });

  it("uses won/lost canonical slugs plus historical aliases for win rate", async () => {
    const { runReportBuilder } = await import("../../../src/modules/reports/report-builder-service.js");
    const tenantDb = createMockTenantDb([]);

    await runReportBuilder(tenantDb, {
      dimensions: ["month"],
      measures: ["win_rate"],
      filters: { from: "2026-01-01", to: "2026-12-31" },
      dateField: "contract_signed_at",
      role: "admin",
      userId: "admin-1",
    });

    const queryText = extractSqlText(tenantDb.execute.mock.calls[0][0]).toLowerCase();
    expect(queryText).toContain("contract_signed_at");
    expect(queryText).toContain("contract_signed_date");
    expect(queryText).toContain("won");
    expect(queryText).toContain("lost");
    expect(queryText).toContain("sent_to_production");
    expect(queryText).toContain("service_sent_to_production");
    expect(queryText).toContain("closed_won");
    expect(queryText).toContain("production_lost");
    expect(queryText).toContain("service_lost");
    expect(queryText).toContain("closed_lost");
  });
});
