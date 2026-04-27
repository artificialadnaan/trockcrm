import { describe, expect, it, vi } from "vitest";

// Mock the db import (public schema queries) so the service module loads.
vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn((resolve: any) => resolve([])),
  },
}));

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

// Promise.all order in getUnifiedWorkflowOverview:
// 0=leadPipeline, 1=routeRollup, 2=companyRollup, 3=repActivity,
// 4=staleLead, 5=staleDeal, 6=crmOwnedProgression, 7=mirroredDownstream,
// 8=disqualifications.
const CRM_OWNED_PROGRESSION_INDEX = 6;
const STALE_LEAD_INDEX = 4;

function makeTenantDb(progressionRows: unknown[] = []) {
  return {
    execute: vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // 0 leadPipeline
      .mockResolvedValueOnce({ rows: [] }) // 1 routeRollup
      .mockResolvedValueOnce({ rows: [] }) // 2 companyRollup
      .mockResolvedValueOnce({ rows: [] }) // 3 repActivity
      .mockResolvedValueOnce({ rows: [] }) // 4 staleLead
      .mockResolvedValueOnce({ rows: [] }) // 5 staleDeal
      .mockResolvedValueOnce({ rows: progressionRows }) // 6 crmOwnedProgression
      .mockResolvedValueOnce({ rows: [] }) // 7 mirroredDownstream
      .mockResolvedValueOnce({ rows: [] }), // 8 disqualifications
  } as any;
}

// Regression test for the dsi-alias bug shipped in commit 2589da3
// (2026-04-15 "feat: add unified workflow reporting").
//
// The leads-side branch of crm_owned_progression's UNION ALL had
// FROM `leads l` only — no `deal_scoping_intake dsi` join — but the
// shared `leadRepFilter` injected `AND (dsi.created_by = ... OR
// dsi.last_edited_by = ...)`. With repId set (the route handler
// auto-injects req.user.id for any rep loading the Reports page),
// Postgres throws "column dsi.created_by does not exist" and the
// entire Promise.all rejects — 500 response, broken Reports page
// for every rep on every load.
//
// The mock infra here returns canned rows from execute() rather
// than running real SQL, so the function will return 200 even with
// the broken code. The actual regression assertion is on the SQL
// STRING for the crm_owned_progression query: when repId is set,
// the leads branch must use `l.assigned_rep_id` and must NOT
// reference `dsi.created_by` / `dsi.last_edited_by` (which would
// resolve nowhere in that branch's FROM clause).
describe("getUnifiedWorkflowOverview rep-filter scoping (regression for 2589da3 dsi-alias bug)", () => {
  it("rep with no assigned leads: returns successfully and crm_owned_progression is empty", async () => {
    const { getUnifiedWorkflowOverview } = await import(
      "../../../src/modules/reports/service.js"
    );
    const tenantDb = makeTenantDb([]);

    const result = await getUnifiedWorkflowOverview(tenantDb, { repId: "rep-uuid-1" });

    expect(result.crmOwnedProgression).toEqual([]);
  });

  it("rep with one assigned open lead: returns successfully and the lead appears in crm_owned bucket", async () => {
    const { getUnifiedWorkflowOverview } = await import(
      "../../../src/modules/reports/service.js"
    );
    const tenantDb = makeTenantDb([
      {
        workflow_bucket: "crm_owned",
        workflow_route: "normal",
        stage_name: "New Lead",
        display_order: 1,
        item_count: "1",
        total_value: "0",
      },
    ]);

    const result = await getUnifiedWorkflowOverview(tenantDb, { repId: "rep-uuid-1" });

    expect(result.crmOwnedProgression).toEqual([
      {
        workflowBucket: "crm_owned",
        workflowRoute: "normal",
        stageName: "New Lead",
        itemCount: 1,
        totalValue: 0,
      },
    ]);
  });

  it("crm_owned_progression SQL: leads-side filter references l.assigned_rep_id, not dsi columns", async () => {
    const { getUnifiedWorkflowOverview } = await import(
      "../../../src/modules/reports/service.js"
    );
    const tenantDb = makeTenantDb([]);

    await getUnifiedWorkflowOverview(tenantDb, { repId: "rep-uuid-1" });

    const progressionSql = extractSqlText(
      tenantDb.execute.mock.calls[CRM_OWNED_PROGRESSION_INDEX][0]
    ).toLowerCase();

    // Positive assertion: the leads-side filter must use l.assigned_rep_id.
    expect(progressionSql).toContain("l.assigned_rep_id");

    // Negative assertion: the leads-side branch has no `dsi` join in scope,
    // so referencing dsi.* columns would throw at execution time.
    expect(progressionSql).not.toContain("dsi.created_by");
    expect(progressionSql).not.toContain("dsi.last_edited_by");
  });

  it("stale-lead SQL still uses the dsi-based filter (the other consumer of leadRepFilter is intentionally untouched)", async () => {
    const { getUnifiedWorkflowOverview } = await import(
      "../../../src/modules/reports/service.js"
    );
    const tenantDb = makeTenantDb([]);

    await getUnifiedWorkflowOverview(tenantDb, { repId: "rep-uuid-1" });

    const staleLeadSql = extractSqlText(
      tenantDb.execute.mock.calls[STALE_LEAD_INDEX][0]
    ).toLowerCase();

    // The stale-lead query has FROM deal_scoping_intake dsi in scope,
    // so the dsi-based filter is correct there. The fix must NOT have
    // replaced this consumer of leadRepFilter.
    expect(staleLeadSql).toContain("deal_scoping_intake dsi");
    expect(staleLeadSql).toContain("dsi.created_by");
  });

  it("with no repId set: leads-side filter compiles to empty SQL (no rep filter applied)", async () => {
    const { getUnifiedWorkflowOverview } = await import(
      "../../../src/modules/reports/service.js"
    );
    const tenantDb = makeTenantDb([]);

    await getUnifiedWorkflowOverview(tenantDb, {});

    const progressionSql = extractSqlText(
      tenantDb.execute.mock.calls[CRM_OWNED_PROGRESSION_INDEX][0]
    ).toLowerCase();

    // With no repId, neither leadAssignedRepFilter nor leadRepFilter
    // should leave a rep-id constraint on the leads-side branch.
    expect(progressionSql).not.toContain("l.assigned_rep_id =");
    expect(progressionSql).not.toContain("dsi.created_by =");
  });
});
