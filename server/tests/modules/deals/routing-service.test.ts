import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");

const workflowAlignmentMigrationPath = resolve(
  repoRoot,
  "migrations/0028_pipeline_workflow_alignment.sql"
);
const workflowAlignmentMigrationSql = existsSync(workflowAlignmentMigrationPath)
  ? readFileSync(workflowAlignmentMigrationPath, "utf8")
  : "";
const servicePipelineSeedMigrationPath = resolve(
  repoRoot,
  "migrations/0045_service_pipeline_stage_seed.sql"
);
const servicePipelineSeedMigrationSql = existsSync(servicePipelineSeedMigrationPath)
  ? readFileSync(servicePipelineSeedMigrationPath, "utf8")
  : "";

const leadQualificationSchemaPath = resolve(
  repoRoot,
  "shared/src/schema/tenant/lead-qualification.ts"
);
const dealRoutingHistorySchemaPath = resolve(
  repoRoot,
  "shared/src/schema/tenant/deal-routing-history.ts"
);
const dealDepartmentHandoffsSchemaPath = resolve(
  repoRoot,
  "shared/src/schema/tenant/deal-department-handoffs.ts"
);
const sharedSchemaIndexPath = resolve(repoRoot, "shared/src/schema/index.ts");
const sharedSchemaIndexSource = readFileSync(sharedSchemaIndexPath, "utf8");

async function loadRoutingServiceModule() {
  try {
    return await import("../../../src/modules/deals/routing-service.js");
  } catch {
    return null;
  }
}

describe("Workflow Alignment Routing Contract", () => {
  it("creates schema files for lead qualification and routing ownership tables", () => {
    expect(existsSync(leadQualificationSchemaPath)).toBe(true);
    expect(existsSync(dealRoutingHistorySchemaPath)).toBe(true);
    expect(existsSync(dealDepartmentHandoffsSchemaPath)).toBe(true);
  });

  it("exports the new tenant schema tables from the shared schema index", () => {
    expect(sharedSchemaIndexSource).toContain("leadQualification");
    expect(sharedSchemaIndexSource).toContain("dealRoutingHistory");
    expect(sharedSchemaIndexSource).toContain("dealDepartmentHandoffs");
  });

  it("creates workflow alignment tenant tables and routing metadata in migration 0028", () => {
    expect(workflowAlignmentMigrationSql).toContain(
      "CREATE TABLE IF NOT EXISTS %I.lead_qualification"
    );
    expect(workflowAlignmentMigrationSql).toContain(
      "CREATE TABLE IF NOT EXISTS %I.deal_routing_history"
    );
    expect(workflowAlignmentMigrationSql).toContain(
      "CREATE TABLE IF NOT EXISTS %I.deal_department_handoffs"
    );
    expect(workflowAlignmentMigrationSql).toContain("pipeline_disposition");
    expect(workflowAlignmentMigrationSql).toContain("value_source");
    expect(workflowAlignmentMigrationSql).toContain("from_workflow_route");
    expect(workflowAlignmentMigrationSql).toContain("to_workflow_route");
  });

  it("adds active service-deal stages so under-threshold routing has an entry stage", () => {
    expect(existsSync(servicePipelineSeedMigrationPath)).toBe(true);
    expect(servicePipelineSeedMigrationSql).toContain("'service_deal'");
    expect(servicePipelineSeedMigrationSql).toContain("'service_review'");
    expect(servicePipelineSeedMigrationSql).toContain("'service_scheduled'");
    expect(servicePipelineSeedMigrationSql).toContain("'service_complete'");
    expect(servicePipelineSeedMigrationSql).toContain("is_active_pipeline");
  });

  it("routes deals under 50k into service and 50k+ into the deals path", async () => {
    const mod = await loadRoutingServiceModule();

    expect(mod).not.toBeNull();
    expect(mod!.routeForAmount("42000.00")).toBe("service");
    expect(mod!.routeForAmount("50000.00")).toBe("normal");
    expect(mod!.routeForAmount("65000.00")).toBe("normal");
  });
});
