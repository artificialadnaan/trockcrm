import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { DEAL_SCOPING_INTAKE_STATUSES, WORKFLOW_ROUTES } from "@trock-crm/shared/types";
import { dealHistory, dealScopingIntake, deals, files, users } from "@trock-crm/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertDealScopingWriteAllowed,
  evaluateDealScopingReadiness,
  getOrCreateDealScopingIntake,
  linkDealFileToScopingRequirement,
  upsertDealScopingIntake,
} from "../../../src/modules/deals/scoping-service.js";
import { AppError } from "../../../src/middleware/error-handler.js";

const pipelineMocks = vi.hoisted(() => ({
  getStageById: vi.fn(),
  getStageBySlug: vi.fn(),
  getActiveProjectTypes: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
}));

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageById: pipelineMocks.getStageById,
  getStageBySlug: pipelineMocks.getStageBySlug,
  getActiveProjectTypes: pipelineMocks.getActiveProjectTypes,
}));
vi.mock("../../../src/lib/audit-log.js", () => ({
  writeAuditLog: auditMocks.writeAuditLog,
}));

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
  stageId: string;
  workflowRoute: "normal" | "service";
  expectedCloseDate: string | null;
  propertyAddress: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyZip: string | null;
  description: string | null;
  projectTypeId: string | null;
  assignedRepId: string;
  rfpApprovalRequestedAt?: Date | null;
  rfpApprovalStatus?: string | null;
  bidBoardLinkedAt?: Date | null;
  bidBoardProjectNumber?: string | null;
  bidBoardStageSlug?: string | null;
  isBidBoardOwned?: boolean;
  isReadOnlyMirror?: boolean;
  readOnlySyncedAt?: Date | null;
  bidBoardStageEnteredAt?: Date | null;
  bidBoardMirrorSourceEnteredAt?: Date | null;
}

interface FakeUserRow {
  id: string;
  officeId: string;
  role?: string;
}

interface FakeFileRow {
  id: string;
  dealId: string | null;
  category?: string | null;
  r2Key?: string | null;
  r2Bucket?: string | null;
  intakeRequirementKey: string | null;
  intakeSource?: string | null;
  isActive: boolean;
}

interface FakeDealScopingIntakeRow {
  id: string;
  dealId: string;
  officeId: string;
  workflowRouteSnapshot: "normal" | "service";
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
  dealHistory: Array<Record<string, unknown>>;
}

function createFakeTenantDb(initialState?: Partial<FakeTenantState>) {
  const state: FakeTenantState = {
    deals: [
        {
          id: "deal-1",
          name: "Original Deal",
          stageId: "stage-opportunity",
          workflowRoute: "normal",
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
    dealHistory: [],
    ...initialState,
  };

  function getRows(table: unknown) {
    const tableName = (table as { _: { name?: string } })?._?.name;

    if (table === deals || tableName === "deals") return state.deals;
    if (table === users || tableName === "users") return state.users;
    if (table === files || tableName === "files") return state.files;
    if (table === dealScopingIntake || tableName === "deal_scoping_intake") return state.dealScopingIntake;
    if (table === dealHistory || tableName === "deal_history") return state.dealHistory;
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
    expect(WORKFLOW_ROUTES).toEqual(["normal", "service"]);
    expect(DEAL_SCOPING_INTAKE_STATUSES).toEqual(["draft", "ready", "activated"]);
  });

  it("adds canonical workflow routing to deals", () => {
    const columns = getTableColumns(deals);

    expect(columns.workflowRoute.name).toBe("workflow_route");
    expect(columns.workflowRoute.notNull).toBe(true);
    expect(columns.workflowRoute.hasDefault).toBe(true);
    expect(columns.workflowRoute.default).toBe("normal");
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
    const disableAuditTriggerIndex = migrationSql.indexOf("ALTER TABLE %I.deals DISABLE TRIGGER USER");
    const workflowRouteBackfillIndex = migrationSql.indexOf("UPDATE %I.deals");
    const enableAuditTriggerIndex = migrationSql.indexOf("ALTER TABLE %I.deals ENABLE TRIGGER USER");
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
    expect(migrationSql).toContain("ALTER TABLE %I.deals DISABLE TRIGGER USER");
    expect(migrationSql).toContain("ALTER TABLE %I.deals ENABLE TRIGGER USER");
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
    expect(disableAuditTriggerIndex).toBeGreaterThan(-1);
    expect(workflowRouteBackfillIndex).toBeGreaterThan(-1);
    expect(enableAuditTriggerIndex).toBeGreaterThan(-1);
    expect(disableAuditTriggerIndex).toBeLessThan(workflowRouteBackfillIndex);
    expect(workflowRouteBackfillIndex).toBeLessThan(enableAuditTriggerIndex);
    expect(notNullIndex).toBeGreaterThan(-1);
    expect(fkIndex).toBeGreaterThan(-1);
    expect(nullGuardIndex).toBeLessThan(notNullIndex);
    expect(nullGuardIndex).toBeLessThan(fkIndex);
  });
});

describe("Scoping Service", () => {
  beforeEach(() => {
    auditMocks.writeAuditLog.mockReset();
    pipelineMocks.getStageBySlug.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      displayOrder: 1,
      workflowFamily: "standard_deal",
    });
    pipelineMocks.getActiveProjectTypes.mockResolvedValue([
      { id: "project-type-1", name: "Roofing", slug: "roofing", code: "3" },
    ]);
  });

  it("allows cleanup mode to bypass only the post-RFP scope lock", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 1,
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Submitted Scope Deal",
          stageId: "stage-opportunity",
          workflowRoute: "normal",
          expectedCloseDate: null,
          propertyAddress: null,
          propertyCity: null,
          propertyState: null,
          propertyZip: null,
          description: null,
          projectTypeId: null,
          assignedRepId: "rep-1",
          rfpApprovalRequestedAt: new Date("2026-04-08T09:00:00.000Z"),
          rfpApprovalStatus: "submitted",
        },
      ],
    });

    await expect(
      assertDealScopingWriteAllowed(tenantDb as never, "deal-1", {
        role: "rep",
        forceEditAfterRfp: false,
        cleanupMode: true,
      })
    ).resolves.toMatchObject({
      adminOverride: false,
    });
  });

  it("still blocks cleanup mode on bid board-owned deals", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-contract",
      slug: "contract",
      workflowFamily: "standard_deal",
      displayOrder: 5,
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Bid Board Owned Deal",
          stageId: "stage-contract",
          workflowRoute: "normal",
          expectedCloseDate: null,
          propertyAddress: null,
          propertyCity: null,
          propertyState: null,
          propertyZip: null,
          description: null,
          projectTypeId: null,
          assignedRepId: "rep-1",
          bidBoardLinkedAt: new Date("2026-04-08T09:00:00.000Z"),
          bidBoardProjectNumber: "ATL-1-10026-aa",
          bidBoardStageSlug: "contract",
          isBidBoardOwned: true,
        },
      ],
    });

    await expect(
      assertDealScopingWriteAllowed(tenantDb as never, "deal-1", {
        role: "rep",
        forceEditAfterRfp: false,
        cleanupMode: true,
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });
  });

  it("still blocks cleanup mode on past-opportunity read-only stages", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-estimating",
      slug: "estimating",
      workflowFamily: "standard_deal",
      displayOrder: 2,
    });
    pipelineMocks.getStageBySlug.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      displayOrder: 1,
      workflowFamily: "standard_deal",
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Past Opportunity Deal",
          stageId: "stage-estimating",
          workflowRoute: "normal",
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
    });

    await expect(
      assertDealScopingWriteAllowed(tenantDb as never, "deal-1", {
        role: "rep",
        forceEditAfterRfp: false,
        cleanupMode: true,
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });
  });

  it("still blocks cleanup mode when RFP submission and past-opportunity locks both apply", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-site-visit",
      slug: "site_visit",
      workflowFamily: "standard_deal",
      displayOrder: 2,
    });
    pipelineMocks.getStageBySlug.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      displayOrder: 1,
      workflowFamily: "standard_deal",
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Mixed Lock Deal",
          stageId: "stage-site-visit",
          workflowRoute: "normal",
          expectedCloseDate: null,
          propertyAddress: null,
          propertyCity: null,
          propertyState: null,
          propertyZip: null,
          description: null,
          projectTypeId: null,
          assignedRepId: "rep-1",
          rfpApprovalRequestedAt: new Date("2026-04-08T09:00:00.000Z"),
          rfpApprovalStatus: "submitted",
        },
      ],
    });

    await expect(
      assertDealScopingWriteAllowed(tenantDb as never, "deal-1", {
        role: "rep",
        forceEditAfterRfp: false,
        cleanupMode: true,
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
    });
  });

  it("loads an existing submitted scope for read-only viewing after RFP submission", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-estimating",
      slug: "estimate_in_progress",
      workflowFamily: "standard_deal",
      displayOrder: 3,
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Submitted Scope Deal",
          stageId: "stage-estimating",
          workflowRoute: "normal",
          expectedCloseDate: null,
          propertyAddress: "123 Scope Way",
          propertyCity: "Dallas",
          propertyState: "TX",
          propertyZip: "75201",
          description: "Submitted exterior scope",
          projectTypeId: "project-type-1",
          assignedRepId: "rep-1",
          rfpApprovalRequestedAt: new Date("2026-05-12T12:00:00.000Z"),
          rfpApprovalStatus: "pending_outbox",
        },
      ],
      dealScopingIntake: [
        {
          id: "intake-1",
          dealId: "deal-1",
          officeId: "office-1",
          workflowRouteSnapshot: "normal",
          status: "activated",
          projectTypeId: "project-type-1",
          sectionData: {
            scopeSummary: { summary: "Submitted exterior scope" },
          },
          completionState: {},
          readinessErrors: {},
          firstReadyAt: new Date("2026-05-12T11:00:00.000Z"),
          activatedAt: new Date("2026-05-12T12:00:00.000Z"),
          lastAutosavedAt: new Date("2026-05-12T12:00:00.000Z"),
          createdBy: "user-1",
          lastEditedBy: "user-1",
          createdAt: new Date("2026-05-12T11:00:00.000Z"),
          updatedAt: new Date("2026-05-12T12:00:00.000Z"),
        },
      ],
    });

    const result = await getOrCreateDealScopingIntake(tenantDb as never, "deal-1", "user-1");

    expect(result.intake.sectionData).toMatchObject({
      scopeSummary: { summary: "Submitted exterior scope" },
    });
    expect(result.readiness.status).toBe("activated");
  });

  it("returns a read-only seeded snapshot for locked deals that do not yet have an intake row", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 1,
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Submitted Scope Deal",
          stageId: "stage-opportunity",
          workflowRoute: "normal",
          expectedCloseDate: null,
          propertyAddress: "123 Scope Way",
          propertyCity: "Dallas",
          propertyState: "TX",
          propertyZip: "75201",
          description: "Submitted exterior scope",
          projectTypeId: "project-type-1",
          assignedRepId: "rep-1",
          rfpApprovalRequestedAt: new Date("2026-05-12T12:00:00.000Z"),
          rfpApprovalStatus: "pending_outbox",
        },
      ],
    });

    const result = await getOrCreateDealScopingIntake(tenantDb as never, "deal-1", "user-1");

    expect(result.intake.id).toBe("readonly-deal-1");
    expect(result.intake.sectionData).toMatchObject({
      scopeSummary: { summary: "Submitted exterior scope" },
    });
    expect(tenantDb.state.dealScopingIntake).toHaveLength(0);
  });

  it("does not persist readiness refreshes while a submitted scope is locked", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 1,
    });
    const originalUpdatedAt = new Date("2026-05-12T11:00:00.000Z");

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Submitted Scope Deal",
          stageId: "stage-opportunity",
          workflowRoute: "normal",
          expectedCloseDate: null,
          propertyAddress: "123 Scope Way",
          propertyCity: "Dallas",
          propertyState: "TX",
          propertyZip: "75201",
          description: "Submitted exterior scope",
          projectTypeId: "project-type-1",
          assignedRepId: "rep-1",
          rfpApprovalRequestedAt: new Date("2026-05-12T12:00:00.000Z"),
          rfpApprovalStatus: "pending_outbox",
        },
      ],
      dealScopingIntake: [
        {
          id: "intake-1",
          dealId: "deal-1",
          officeId: "office-1",
          workflowRouteSnapshot: "normal",
          status: "draft",
          projectTypeId: "project-type-1",
          sectionData: { scopeSummary: { summary: "Submitted exterior scope" } },
          completionState: {},
          readinessErrors: {},
          firstReadyAt: null,
          activatedAt: null,
          lastAutosavedAt: originalUpdatedAt,
          createdBy: "user-1",
          lastEditedBy: "user-1",
          createdAt: originalUpdatedAt,
          updatedAt: originalUpdatedAt,
        },
      ],
    });

    await evaluateDealScopingReadiness(tenantDb as never, "deal-1");

    expect(tenantDb.state.dealScopingIntake[0]?.updatedAt).toBe(originalUpdatedAt);
    expect(tenantDb.state.dealScopingIntake[0]?.lastAutosavedAt).toBe(originalUpdatedAt);
  });

  it("allows non-admin operational metadata writes after RFP submission", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 1,
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Submitted Scope Deal",
          stageId: "stage-opportunity",
          workflowRoute: "normal",
          expectedCloseDate: null,
          propertyAddress: "123 Scope Way",
          propertyCity: "Dallas",
          propertyState: "TX",
          propertyZip: "75201",
          description: "Submitted exterior scope",
          projectTypeId: "project-type-1",
          assignedRepId: "rep-1",
          rfpApprovalRequestedAt: new Date("2026-05-12T12:00:00.000Z"),
          rfpApprovalStatus: "pending_outbox",
        },
      ],
      users: [{ id: "user-1", officeId: "office-1", role: "rep" }],
    });

    await expect(
      upsertDealScopingIntake(
        tenantDb as never,
        "deal-1",
        {
          scopeSummary: { summary: "Changed after RFP" },
        },
        "user-1"
      )
    ).resolves.toMatchObject({
      intake: expect.any(Object),
    });

    expect(tenantDb.state.deals[0]?.description).toBe("Changed after RFP");
  });

  it("allows explicit admin override edits for locked scope fields after RFP submission and writes an audit row", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 1,
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Submitted Scope Deal",
          stageId: "stage-opportunity",
          workflowRoute: "normal",
          expectedCloseDate: null,
          propertyAddress: "123 Scope Way",
          propertyCity: "Dallas",
          propertyState: "TX",
          propertyZip: "75201",
          description: "Submitted exterior scope",
          projectTypeId: "project-type-1",
          assignedRepId: "rep-1",
          rfpApprovalRequestedAt: new Date("2026-05-12T12:00:00.000Z"),
          rfpApprovalStatus: "pending_outbox",
        },
      ],
      users: [{ id: "admin-1", officeId: "office-1", role: "admin" }],
    });

    await upsertDealScopingIntake(
      tenantDb as never,
      "deal-1",
      {
        forceEditAfterRfp: true,
        opportunity: { siteVisitDecision: "scheduled" },
      },
      "admin-1"
    );

    expect(
      (tenantDb.state.dealScopingIntake[0]?.sectionData as Record<string, unknown>)?.opportunity
    ).toMatchObject({ siteVisitDecision: "scheduled" });
    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        tableName: "deal_scoping_intake",
        recordId: "deal-1",
        action: "update",
        changedBy: "admin-1",
        fullRow: expect.objectContaining({
          override: "admin_force_edit_after_rfp",
        }),
      })
    );
  });

  it("allows admin override edits for legacy Bid Board deals identified only by bidBoardStageSlug", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 1,
    });
    pipelineMocks.getStageBySlug.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 1,
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Legacy Bid Board Deal",
          stageId: "stage-opportunity",
          workflowRoute: "normal",
          expectedCloseDate: null,
          propertyAddress: "123 Scope Way",
          propertyCity: "Dallas",
          propertyState: "TX",
          propertyZip: "75201",
          description: "Legacy Bid Board scope",
          projectTypeId: "project-type-1",
          assignedRepId: "rep-1",
          bidBoardStageSlug: "estimate_in_progress",
        },
      ],
      users: [{ id: "admin-1", officeId: "office-1", role: "admin" }],
    });

    await upsertDealScopingIntake(
      tenantDb as never,
      "deal-1",
      {
        forceEditAfterRfp: true,
        projectOverview: { propertyName: "Admin legacy correction" },
      },
      "admin-1"
    );

    expect(tenantDb.state.deals[0]?.name).toBe("Admin legacy correction");
    expect(auditMocks.writeAuditLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        tableName: "deal_scoping_intake",
        recordId: "deal-1",
        action: "update",
        changedBy: "admin-1",
        fullRow: expect.objectContaining({
          override: "admin_force_edit_after_rfp",
          reason: "bid_board_handoff",
        }),
      })
    );
  });

  it("blocks scoping reopen/edit flows for legacy downstream Bid Board-owned stages even without mirror metadata", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-production",
      slug: "in_production",
      workflowFamily: "standard_deal",
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Palm Villas",
          stageId: "stage-production",
          workflowRoute: "normal",
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
      dealScopingIntake: [
        {
          id: "intake-1",
          dealId: "deal-1",
          officeId: "office-1",
          workflowRouteSnapshot: "normal",
          status: "activated",
          projectTypeId: null,
          sectionData: {},
          completionState: {},
          readinessErrors: {},
          firstReadyAt: null,
          activatedAt: new Date("2026-04-08T09:00:00.000Z"),
          lastAutosavedAt: new Date("2026-04-08T09:00:00.000Z"),
          createdBy: "user-1",
          lastEditedBy: "user-1",
          createdAt: new Date("2026-04-08T09:00:00.000Z"),
          updatedAt: new Date("2026-04-08T09:00:00.000Z"),
        },
      ],
    });

    await expect(
      upsertDealScopingIntake(
        tenantDb as never,
        "deal-1",
        {
          projectOverview: { propertyName: "Palm Villas Reopened" },
        },
        "user-1"
      )
    ).rejects.toMatchObject<AppError>({
      statusCode: 403,
      code: "SCOPE_READ_ONLY_AFTER_RFP",
      message: "Scope is read-only after RFP submission",
    });

    expect(tenantDb.state.dealScopingIntake[0]?.sectionData).toEqual({});
    expect(tenantDb.state.deals[0]?.name).toBe("Palm Villas");
  });

  it("seeds a new scoping intake from canonical deal data", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "lead",
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Palm Villas",
          stageId: "stage-opportunity",
          workflowRoute: "normal",
          expectedCloseDate: null,
          propertyAddress: "123 Palm Way",
          propertyCity: "Miami",
          propertyState: "FL",
          propertyZip: "33101",
          description: "Exterior refresh",
          projectTypeId: "project-type-1",
          assignedRepId: "rep-1",
        },
      ],
    });

    const result = await getOrCreateDealScopingIntake(tenantDb as never, "deal-1", "user-1");

    expect(result.intake.projectTypeId).toBe("project-type-1");
    expect(result.intake.sectionData).toMatchObject({
      projectOverview: { propertyName: "Palm Villas" },
      propertyDetails: {
        propertyAddress: "123 Palm Way",
        propertyCity: "Miami",
        propertyState: "FL",
        propertyZip: "33101",
      },
      scopeSummary: { summary: "Exterior refresh" },
    });
  });

  it("initializes a legacy opportunity scoping intake without clearing a null project type", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 2,
    });
    pipelineMocks.getStageBySlug.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 2,
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Legacy Opportunity",
          stageId: "stage-opportunity",
          workflowRoute: "normal",
          expectedCloseDate: null,
          propertyAddress: "123 Legacy Way",
          propertyCity: "Dallas",
          propertyState: "TX",
          propertyZip: "75201",
          description: "Legacy imported opportunity",
          projectTypeId: null,
          assignedRepId: "rep-1",
        },
      ],
    });

    const result = await getOrCreateDealScopingIntake(tenantDb as never, "deal-1", "user-1");

    expect(result.intake.projectTypeId).toBeNull();
    expect(result.intake.sectionData).toMatchObject({
      projectOverview: { propertyName: "Legacy Opportunity" },
      propertyDetails: {
        propertyAddress: "123 Legacy Way",
        propertyCity: "Dallas",
        propertyState: "TX",
        propertyZip: "75201",
      },
      scopeSummary: { summary: "Legacy imported opportunity" },
    });
    expect(tenantDb.state.deals[0]?.projectTypeId).toBeNull();
  });

  it("still rejects explicitly clearing project type on an opportunity scoping write", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 2,
    });
    pipelineMocks.getStageBySlug.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 2,
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Typed Opportunity",
          stageId: "stage-opportunity",
          workflowRoute: "normal",
          expectedCloseDate: null,
          propertyAddress: "123 Typed Way",
          propertyCity: "Dallas",
          propertyState: "TX",
          propertyZip: "75201",
          description: "Typed opportunity",
          projectTypeId: "project-type-1",
          assignedRepId: "rep-1",
        },
      ],
      users: [{ id: "user-1", officeId: "office-1", role: "admin" }],
    });

    await expect(
      upsertDealScopingIntake(
        tenantDb as never,
        "deal-1",
        {
          projectTypeId: null,
          sectionData: {
            projectOverview: { propertyName: "Typed Opportunity" },
          },
        },
        "user-1"
      )
    ).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: "projectType cannot be cleared after Opportunity",
    });
  });

  it("writes deal-owned scoping fields back to canonical deal columns", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "lead",
    });

    const tenantDb = createFakeTenantDb();

    const result = await upsertDealScopingIntake(
      tenantDb as never,
      "deal-1",
      {
        workflowRoute: "normal",
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
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "lead",
    });

    const tenantDb = createFakeTenantDb();

    await upsertDealScopingIntake(
      tenantDb as never,
      "deal-1",
      {
        workflowRoute: "normal",
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

  it("ignores manual workflow route overrides in the opportunity scoping workspace", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "lead",
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Palm Villas",
          stageId: "stage-opportunity",
          workflowRoute: "normal",
          expectedCloseDate: null,
          propertyAddress: "123 Palm Way",
          propertyCity: "Miami",
          propertyState: "FL",
          propertyZip: "33101",
          description: "Exterior refresh",
          projectTypeId: "project-type-1",
          assignedRepId: "rep-1",
        },
      ],
    });

    const result = await upsertDealScopingIntake(
      tenantDb as never,
      "deal-1",
      {
        workflowRoute: "service",
        projectOverview: { propertyName: "Palm Villas" },
        propertyDetails: { propertyAddress: "123 Palm Way" },
        scopeSummary: { summary: "Exterior refresh" },
      },
      "user-1"
    );

    expect(tenantDb.state.deals[0]?.workflowRoute).toBe("normal");
    expect(result.intake.workflowRouteSnapshot).toBe("normal");
    expect(result.readiness.requiredAttachmentKeys).toEqual([]);
  });

  it("stores assign percent in scoping data without deriving readiness from it", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "lead",
    });

    const tenantDb = createFakeTenantDb();

    const result = await upsertDealScopingIntake(
      tenantDb as never,
      "deal-1",
      {
        projectOverview: {
          propertyName: "Palm Villas",
          bidDueDate: "2026-04-30",
          assignPercent: "35",
        },
        propertyDetails: { propertyAddress: "123 Palm Way" },
        scopeSummary: { summary: "Exterior refresh" },
      },
      "user-1"
    );

    expect(result.intake.sectionData).toMatchObject({
      projectOverview: {
        propertyName: "Palm Villas",
        bidDueDate: "2026-04-30",
        assignPercent: "35",
      },
    });
    expect(result.readiness.errors.sections.projectOverview ?? []).not.toContain("assignPercent");
  });

  it("marks intake ready when required sections and scope are satisfied without requiring attachments", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "lead",
    });

    const tenantDb = createFakeTenantDb({
      dealScopingIntake: [
        {
          id: "intake-1",
          dealId: "deal-1",
          officeId: "office-1",
          workflowRouteSnapshot: "normal",
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
    expect(readiness.errors.sections.scope).toContain("selectedProjectTypeIds");
    expect(readiness.errors.sections.projectOverview).toContain("bidDueDate");
    expect(readiness.errors.attachments).toEqual({});
    expect(readiness.completionState.projectOverview.isComplete).toBe(false);

    await upsertDealScopingIntake(
      tenantDb as never,
      "deal-1",
      {
        projectTypeId: "project-type-1",
        projectOverview: { propertyName: "Palm Villas", bidDueDate: "2026-04-30" },
        opportunity: { preBidMeetingCompleted: "yes", siteVisitDecision: "not_required" },
        propertyDetails: { propertyAddress: "123 Palm Way" },
        scopeSummary: { summary: "Exterior refresh" },
      },
      "user-1"
    );

    const readyReadiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1");

    expect(readyReadiness.status).toBe("ready");
    expect(readyReadiness.errors.sections).toEqual({});
    expect(readyReadiness.errors.attachments).toEqual({});
    expect(readyReadiness.completionState.attachments.isComplete).toBe(true);
    expect(readyReadiness.attachmentRequirements).toEqual([
      expect.objectContaining({ key: "scope_docs", satisfied: false }),
      expect.objectContaining({ key: "site_photos", satisfied: false }),
    ]);

    const [savedIntake] = tenantDb.state.dealScopingIntake;
    expect(savedIntake.status).toBe("ready");
    expect(savedIntake.firstReadyAt).toBeInstanceOf(Date);
  });

  it("links an existing deal file into a scoping requirement without duplicating the file row", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "lead",
    });

    const tenantDb = createFakeTenantDb({
      files: [
        {
          id: "file-1",
          dealId: "deal-1",
          intakeRequirementKey: null,
          isActive: true,
        },
      ],
    });

    const file = await linkDealFileToScopingRequirement(
      tenantDb as never,
      "deal-1",
      {
        fileId: "file-1",
        intakeSection: "attachments",
        intakeRequirementKey: "site_photos",
      },
      "user-1"
    );

    expect(file.id).toBe("file-1");
    expect(file.intakeSection).toBe("attachments");
    expect(file.intakeRequirementKey).toBe("site_photos");
    expect(file.intakeSource).toBe("scoping_intake");
    expect(tenantDb.state.files).toHaveLength(1);
  });
});
