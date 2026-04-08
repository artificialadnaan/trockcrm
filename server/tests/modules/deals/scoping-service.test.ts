import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { DEAL_SCOPING_INTAKE_STATUSES, WORKFLOW_ROUTES } from "@trock-crm/shared/types";
import { dealScopingIntake, deals, files, users } from "@trock-crm/shared/schema";
import { describe, expect, it } from "vitest";
import { evaluateDealScopingReadiness, upsertDealScopingIntake } from "../../../src/modules/deals/scoping-service.js";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0016_sales_scoping_intake.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

interface DealScopingIntakePartialRow {
  dealId?: string | null;
  officeId?: string | null;
  createdBy?: string | null;
  lastEditedBy?: string | null;
}

function runDealScopingIntakeMigrationGuardFromSql(
  sql: string,
  schemaName: string,
  rows: DealScopingIntakePartialRow[]
): void {
  const guardedColumns = [...sql.matchAll(/CASE WHEN has_null_[a-z_]+ THEN '([a-z_]+)' END/g)].map(
    (match) => match[1]
  );
  const raiseExceptionMatch = sql.match(
    /RAISE EXCEPTION\s+'([^']*(?:''[^']*)*)',\s*tenant_schema,\s*array_to_string/
  );

  if (guardedColumns.length === 0 || !raiseExceptionMatch) {
    throw new Error("Could not derive deal_scoping_intake migration guard from SQL");
  }

  const invalidRequiredColumns = guardedColumns.filter((columnName) => {
    const propertyName = columnName.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    return rows.some((row) => row[propertyName as keyof DealScopingIntakePartialRow] == null);
  });

  if (invalidRequiredColumns.length === 0) {
    return;
  }

  const errorTemplate = raiseExceptionMatch[1].replace(/''/g, "'");
  const errorMessage = errorTemplate
    .replace("%", schemaName)
    .replace("%", invalidRequiredColumns.join(", "));

  throw new Error(errorMessage);
}

interface FakeDealRow {
  id: string;
  name: string;
  workflowRoute: "estimating" | "service";
  expectedCloseDate: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  description: string | null;
  projectTypeId: string | null;
  assignedRepId: string;
}

interface FakeUserRow {
  id: string;
  officeId: string;
}

interface FakeFileRow {
  id: string;
  dealId: string | null;
  intakeRequirementKey: string | null;
  isActive: boolean;
}

interface FakeDealScopingIntakeRow {
  id: string;
  dealId: string;
  officeId: string;
  workflowRouteSnapshot: "estimating" | "service";
  status: "draft" | "ready" | "activated";
  projectTypeId: string | null;
  sectionData: Record<string, unknown>;
  completionState: Record<string, unknown>;
  readinessErrors: Record<string, unknown>;
  firstReadyAt: Date | null;
  activatedAt: Date | null;
  lastAutosavedAt: Date;
  createdBy: string;
  lastEditedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeTenantState {
  deals: FakeDealRow[];
  users: FakeUserRow[];
  files: FakeFileRow[];
  dealScopingIntake: FakeDealScopingIntakeRow[];
}

function createFakeTenantDb(initialState?: Partial<FakeTenantState>) {
  const state: FakeTenantState = {
    deals: [
      {
        id: "deal-1",
        name: "Original Deal",
        workflowRoute: "estimating",
        expectedCloseDate: null,
        propertyAddress: null,
        propertyCity: null,
        propertyState: null,
        propertyZip: null,
        description: null,
        projectTypeId: null,
        assignedRepId: "rep-1",
      },
    ],
    users: [{ id: "user-1", officeId: "office-1" }],
    files: [],
    dealScopingIntake: [],
    ...initialState,
  };

  function getRows(table: unknown) {
    if (table === deals) return state.deals;
    if (table === users) return state.users;
    if (table === files) return state.files;
    if (table === dealScopingIntake) return state.dealScopingIntake;
    throw new Error("Unexpected table in fake tenant db");
  }

  return {
    state,
    select() {
      return {
        from(table: unknown) {
          const rows = getRows(table);
          return {
            where() {
              return {
                limit(limit: number) {
                  return Promise.resolve(rows.slice(0, limit));
                },
                then(onfulfilled: (value: unknown[]) => unknown) {
                  return Promise.resolve(rows).then(onfulfilled);
                },
              };
            },
            limit(limit: number) {
              return Promise.resolve(rows.slice(0, limit));
            },
            then(onfulfilled: (value: unknown[]) => unknown) {
              return Promise.resolve(rows).then(onfulfilled);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(value: Record<string, unknown>) {
          const rows = getRows(table) as Array<Record<string, unknown>>;
          const insertedRow = {
            id: value.id ?? `${String((table as { _: { name: string } })._?.name ?? "row")}-${rows.length + 1}`,
            ...value,
          };
          rows.push(insertedRow);
          return {
            returning() {
              return Promise.resolve([insertedRow]);
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              const rows = getRows(table) as Array<Record<string, unknown>>;
              rows.forEach((row) => Object.assign(row, values));
              return {
                returning() {
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  };
}

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
      runDealScopingIntakeMigrationGuardFromSql(migrationSql, "office_partial", [
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

describe("Scoping Service", () => {
  it("writes deal-owned scoping fields back to canonical deal columns", async () => {
    const tenantDb = createFakeTenantDb();

    const result = await upsertDealScopingIntake(
      tenantDb as never,
      "deal-1",
      {
        workflowRoute: "estimating",
        projectOverview: { propertyName: "Palm Villas", bidDueDate: "2026-04-30" },
        propertyDetails: { propertyAddress: "123 Palm Way" },
        scopeSummary: { summary: "Exterior refresh" },
      },
      "user-1"
    );

    expect(result.intake.status).toBe("draft");
    expect(result.intake.sectionData).toMatchObject({
      projectOverview: { propertyName: "Palm Villas", bidDueDate: "2026-04-30" },
      propertyDetails: { propertyAddress: "123 Palm Way" },
      scopeSummary: { summary: "Exterior refresh" },
    });

    const [updatedDeal] = tenantDb.state.deals;
    expect(updatedDeal.name).toBe("Palm Villas");
    expect(updatedDeal.propertyAddress).toBe("123 Palm Way");
    expect(updatedDeal.description).toBe("Exterior refresh");
    expect(updatedDeal.expectedCloseDate).toBeNull();
  });

  it("writes canonical deal fields when autosave sections arrive through sectionData", async () => {
    const tenantDb = createFakeTenantDb();

    await upsertDealScopingIntake(
      tenantDb as never,
      "deal-1",
      {
        workflowRoute: "estimating",
        sectionData: {
          projectOverview: { propertyName: "Palm Villas Phase II", bidDueDate: "2026-05-15" },
          propertyDetails: {
            propertyAddress: "456 Palm Way",
            propertyCity: "Miami",
            propertyState: "FL",
            propertyZip: "33101",
          },
          scopeSummary: { summary: "Interior refresh" },
        },
      },
      "user-1"
    );

    const [updatedDeal] = tenantDb.state.deals;
    const [savedIntake] = tenantDb.state.dealScopingIntake;

    expect(updatedDeal.name).toBe("Palm Villas Phase II");
    expect(updatedDeal.propertyAddress).toBe("456 Palm Way");
    expect(updatedDeal.propertyCity).toBe("Miami");
    expect(updatedDeal.propertyState).toBe("FL");
    expect(updatedDeal.propertyZip).toBe("33101");
    expect(updatedDeal.description).toBe("Interior refresh");
    expect(savedIntake.sectionData).toMatchObject({
      projectOverview: { propertyName: "Palm Villas Phase II", bidDueDate: "2026-05-15" },
      propertyDetails: {
        propertyAddress: "456 Palm Way",
        propertyCity: "Miami",
        propertyState: "FL",
        propertyZip: "33101",
      },
      scopeSummary: { summary: "Interior refresh" },
    });
  });

  it("marks intake ready only when required sections and attachments are satisfied", async () => {
    const tenantDb = createFakeTenantDb({
      dealScopingIntake: [
        {
          id: "intake-1",
          dealId: "deal-1",
          officeId: "office-1",
          workflowRouteSnapshot: "estimating",
          status: "draft",
          projectTypeId: null,
          sectionData: {},
          completionState: {},
          readinessErrors: {},
          firstReadyAt: null,
          activatedAt: null,
          lastAutosavedAt: new Date("2026-04-08T09:00:00.000Z"),
          createdBy: "user-1",
          lastEditedBy: "user-1",
          createdAt: new Date("2026-04-08T09:00:00.000Z"),
          updatedAt: new Date("2026-04-08T09:00:00.000Z"),
        },
      ],
    });

    const readiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1");

    expect(readiness.status).toBe("draft");
    expect(readiness.errors.sections.projectOverview).toContain("bidDueDate");
    expect(readiness.errors.attachments.site_photos).toContain("site_photos");
    expect(readiness.completionState.projectOverview.isComplete).toBe(false);

    await upsertDealScopingIntake(
      tenantDb as never,
      "deal-1",
      {
        projectOverview: { propertyName: "Palm Villas", bidDueDate: "2026-04-30" },
        propertyDetails: { propertyAddress: "123 Palm Way" },
        scopeSummary: { summary: "Exterior refresh" },
      },
      "user-1"
    );
    tenantDb.state.files.push(
      {
        id: "file-1",
        dealId: "deal-1",
        intakeRequirementKey: "scope_docs",
        isActive: true,
      },
      {
        id: "file-2",
        dealId: "deal-1",
        intakeRequirementKey: "site_photos",
        isActive: true,
      }
    );

    const readyReadiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1");

    expect(readyReadiness.status).toBe("ready");
    expect(readyReadiness.errors.sections).toEqual({});
    expect(readyReadiness.errors.attachments).toEqual({});
    expect(readyReadiness.completionState.attachments.isComplete).toBe(true);

    const [savedIntake] = tenantDb.state.dealScopingIntake;
    expect(savedIntake.status).toBe("ready");
    expect(savedIntake.firstReadyAt).toBeInstanceOf(Date);
  });
});
