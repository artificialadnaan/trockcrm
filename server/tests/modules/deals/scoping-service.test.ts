import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { DEAL_SCOPING_INTAKE_STATUSES, WORKFLOW_ROUTES } from "@trock-crm/shared/types";
import {
  assertDealScopingIntakeMigrationGuard,
  dealScopingIntake,
  deals,
} from "@trock-crm/shared/schema";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0016_sales_scoping_intake.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

describe("Scoping Service Shared Contract", () => {
  it("defines workflow routes and intake statuses", () => {
    expect(WORKFLOW_ROUTES).toEqual(["estimating", "service"]);
    expect(DEAL_SCOPING_INTAKE_STATUSES).toEqual(["draft", "ready", "activated"]);
  });

  it("adds canonical workflow routing to deals", () => {
    const columns = getTableColumns(deals);

    expect(columns.workflowRoute.name).toBe("workflow_route");
    expect(columns.workflowRoute.notNull).toBe(true);
    expect(columns.workflowRoute.hasDefault).toBe(true);
    expect(columns.workflowRoute.default).toBe("estimating");
  });

  it("defines deal scoping intake defaults, uniqueness, and foreign keys", () => {
    const columns = getTableColumns(dealScopingIntake);
    const config = getTableConfig(dealScopingIntake);

    expect(columns.dealId.name).toBe("deal_id");
    expect(columns.dealId.notNull).toBe(true);
    expect(columns.dealId.isUnique).toBe(true);
    expect(columns.officeId.notNull).toBe(true);
    expect(columns.projectTypeId.notNull).toBe(false);
    expect(columns.status.hasDefault).toBe(true);
    expect(columns.status.default).toBe("draft");
    expect(columns.sectionData.hasDefault).toBe(true);
    expect(columns.sectionData.default).toEqual({});
    expect(columns.completionState.default).toEqual({});
    expect(columns.readinessErrors.default).toEqual({});
    expect(columns.lastAutosavedAt.hasDefault).toBe(true);
    expect(columns.createdBy.notNull).toBe(true);
    expect(columns.lastEditedBy.notNull).toBe(true);
    expect(config.foreignKeys.map((fk) => fk.getName()).sort()).toEqual([
      "deal_scoping_intake_created_by_users_id_fk",
      "deal_scoping_intake_deal_id_deals_id_fk",
      "deal_scoping_intake_last_edited_by_users_id_fk",
      "deal_scoping_intake_office_id_offices_id_fk",
      "deal_scoping_intake_project_type_id_project_type_config_id_fk",
    ]);
  });

  it("fails fast on partial rerun rows before later constraint enforcement", () => {
    let reachedNotNullEnforcement = false;
    let reachedForeignKeyEnforcement = false;

    expect(() => {
      assertDealScopingIntakeMigrationGuard("office_partial", [
        {
          dealId: null,
          officeId: "office-1",
          createdBy: null,
          lastEditedBy: "user-2",
        },
      ]);

      reachedNotNullEnforcement = true;
      reachedForeignKeyEnforcement = true;
    }).toThrowError(
      "Migration 0016 cannot enforce deal_scoping_intake constraints for schema office_partial because existing rows have NULL values in required columns: deal_id, created_by. Backfill these columns before rerunning this migration."
    );

    expect(reachedNotNullEnforcement).toBe(false);
    expect(reachedForeignKeyEnforcement).toBe(false);
  });

  it("keeps the migration rerunnable and constraint-complete for partial application", () => {
    const nullGuardIndex = migrationSql.indexOf("existing rows have NULL values in required columns");
    const notNullIndex = migrationSql.indexOf("ALTER COLUMN deal_id SET NOT NULL");
    const fkIndex = migrationSql.indexOf("ADD CONSTRAINT deal_scoping_intake_deal_id_deals_id_fk");

    expect(migrationSql).toContain("ALTER TABLE %I.deal_scoping_intake");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS deal_id UUID");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS office_id UUID");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS workflow_route_snapshot %I.workflow_route");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS status %I.deal_scoping_intake_status");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS created_by UUID");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS last_edited_by UUID");
    expect(migrationSql).toContain("ADD CONSTRAINT deal_scoping_intake_deal_id_deals_id_fk");
    expect(migrationSql).toContain("ADD CONSTRAINT deal_scoping_intake_office_id_offices_id_fk");
    expect(migrationSql).toContain("ADD CONSTRAINT deal_scoping_intake_project_type_id_project_type_config_id_fk");
    expect(migrationSql).toContain("ADD CONSTRAINT deal_scoping_intake_created_by_users_id_fk");
    expect(migrationSql).toContain("ADD CONSTRAINT deal_scoping_intake_last_edited_by_users_id_fk");
    expect(migrationSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS deal_scoping_intake_deal_id_uidx");
    expect(migrationSql).toContain("WHERE deal_id IS NULL");
    expect(migrationSql).toContain("WHERE office_id IS NULL");
    expect(migrationSql).toContain("WHERE created_by IS NULL");
    expect(migrationSql).toContain("WHERE last_edited_by IS NULL");
    expect(migrationSql).toContain("RAISE EXCEPTION");
    expect(migrationSql).toContain(
      "Migration 0016 cannot enforce deal_scoping_intake constraints for schema % because existing rows have NULL values in required columns: %."
    );
    expect(migrationSql).toContain("Backfill these columns before rerunning this migration.");
    expect(nullGuardIndex).toBeGreaterThan(-1);
    expect(notNullIndex).toBeGreaterThan(-1);
    expect(fkIndex).toBeGreaterThan(-1);
    expect(nullGuardIndex).toBeLessThan(notNullIndex);
    expect(nullGuardIndex).toBeLessThan(fkIndex);
  });
});
