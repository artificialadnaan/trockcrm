import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, getTableColumns, or } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { DEAL_SCOPING_INTAKE_STATUSES, WORKFLOW_ROUTES } from "@trock-crm/shared/types";
import { dealHistory, dealScopingIntake, deals, files, leads, users } from "@trock-crm/shared/schema";
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
  sourceLeadId?: string | null;
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
  leadId?: string | null;
  category?: string | null;
  originalFilename?: string | null;
  mimeType?: string | null;
  tags?: string[];
  r2Key?: string | null;
  r2Bucket?: string | null;
  parentFileId?: string | null;
  version?: number | null;
  intakeSection?: string | null;
  intakeRequirementKey: string | null;
  intakeSource?: string | null;
  isActive: boolean;
  updatedAt?: Date;
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
  leads: Array<Record<string, unknown>>;
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
    leads: [],
    files: [],
    dealScopingIntake: [],
    dealHistory: [],
    ...initialState,
  };

  function getRows(table: unknown) {
    const tableName = (table as { _: { name?: string } })?._?.name;

    if (table === deals || tableName === "deals") return state.deals;
    if (table === leads || tableName === "leads") return state.leads;
    if (table === users || tableName === "users") return state.users;
    if (table === files || tableName === "files") return state.files;
    if (table === dealScopingIntake || tableName === "deal_scoping_intake") return state.dealScopingIntake;
    if (table === dealHistory || tableName === "deal_history") return state.dealHistory;
    throw new Error("Unexpected table in fake tenant db");
  }

  function toPropertyName(columnName: string) {
    return columnName.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  }

  function getQueryChunks(condition: unknown) {
    const chunks = (condition as { queryChunks?: unknown[] } | null)?.queryChunks;
    if (!Array.isArray(chunks)) {
      throw new Error("Unsupported fake tenant db where condition");
    }

    return chunks;
  }

  function hasQueryChunks(chunk: unknown): chunk is { queryChunks: unknown[] } {
    return Array.isArray((chunk as { queryChunks?: unknown[] } | null)?.queryChunks);
  }

  function getStringChunkText(chunk: unknown) {
    if ((chunk as { constructor?: { name?: string } } | null)?.constructor?.name !== "StringChunk") {
      return null;
    }

    const value = (chunk as { value?: unknown }).value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
      return value.join("");
    }
    return typeof value === "string" ? value : null;
  }

  function getEvaluableChunks(condition: unknown) {
    let chunks = getQueryChunks(condition);

    for (;;) {
      const meaningfulChunks = chunks.filter((chunk) => {
        const text = getStringChunkText(chunk);
        return text == null || (text.trim() !== "" && text.trim() !== "(" && text.trim() !== ")");
      });
      const childConditions = meaningfulChunks.filter(hasQueryChunks);

      if (meaningfulChunks.length === 1 && childConditions.length === 1) {
        chunks = childConditions[0].queryChunks;
        continue;
      }

      return chunks;
    }
  }

  function isColumnChunk(chunk: unknown): chunk is { name: string } {
    return !hasQueryChunks(chunk) && typeof (chunk as { name?: unknown } | null)?.name === "string";
  }

  function isParamChunk(chunk: unknown): chunk is { value: unknown; constructor: { name: string } } {
    return (chunk as { constructor?: { name?: string } } | null)?.constructor?.name === "Param";
  }

  function getBooleanOperator(chunk: unknown) {
    const text = getStringChunkText(chunk)?.trim().toLowerCase();
    return text === "and" || text === "or" ? text : null;
  }

  function evaluateWhereCondition<T extends Record<string, unknown>>(row: T, condition: unknown): boolean {
    const chunks = getEvaluableChunks(condition);
    const operators = chunks.map(getBooleanOperator).filter((operator): operator is "and" | "or" => operator != null);
    const childConditions = chunks.filter(hasQueryChunks);

    if (operators.length > 0 || childConditions.length > 0) {
      const uniqueOperators = new Set(operators);
      if (childConditions.length === 1 && uniqueOperators.size === 0) {
        return evaluateWhereCondition(row, childConditions[0]);
      }
      if (childConditions.length < 2 || uniqueOperators.size !== 1) {
        throw new Error("Unsupported composite fake tenant db where condition");
      }

      const [operator] = uniqueOperators;
      return operator === "and"
        ? childConditions.every((childCondition) => evaluateWhereCondition(row, childCondition))
        : childConditions.some((childCondition) => evaluateWhereCondition(row, childCondition));
    }

    const columnChunks = chunks.filter(isColumnChunk);
    const paramChunks = chunks.filter(isParamChunk);
    const hasEqualsOperator = chunks.some((chunk) => getStringChunkText(chunk)?.includes("="));
    const hasIsNullOperator = chunks.some((chunk) => getStringChunkText(chunk)?.toLowerCase().includes("is null"));

    if (columnChunks.length === 1 && paramChunks.length === 0 && hasIsNullOperator) {
      return row[toPropertyName(columnChunks[0].name)] == null;
    }

    if (columnChunks.length !== 1 || paramChunks.length !== 1 || !hasEqualsOperator) {
      throw new Error("Unsupported equality fake tenant db where condition");
    }

    return row[toPropertyName(columnChunks[0].name)] === paramChunks[0].value;
  }

  function applySimpleWhere<T extends Record<string, unknown>>(rows: T[], condition: unknown) {
    if (condition == null) {
      return rows;
    }

    return rows.filter((row) => evaluateWhereCondition(row, condition));
  }

  return {
    state,
    select() {
      return {
        from(table: unknown) {
          const rows = getRows(table);
          return {
            where(condition?: unknown) {
              const filteredRows = applySimpleWhere(rows as Array<Record<string, unknown>>, condition);
              return {
                limit(limit: number) {
                  return Promise.resolve(filteredRows.slice(0, limit));
                },
                then(onfulfilled: (value: unknown[]) => unknown) {
                  return Promise.resolve(filteredRows).then(onfulfilled);
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
            where(condition: unknown) {
              const rows = getRows(table) as Array<Record<string, unknown>>;
              const matchedRows = applySimpleWhere(rows, condition);
              matchedRows.forEach((row) => Object.assign(row, values));
              return {
                returning() {
                  return Promise.resolve(matchedRows);
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

  it("filters fake tenant db rows through composite and/or where predicates", async () => {
    const tenantDb = createFakeTenantDb({
      files: [
        {
          id: "deal-active-file",
          dealId: "deal-1",
          leadId: null,
          category: "other",
          originalFilename: "deal.pdf",
          mimeType: "application/pdf",
          intakeRequirementKey: null,
          isActive: true,
        },
        {
          id: "lead-active-file",
          dealId: null,
          leadId: "lead-1",
          category: "photo",
          originalFilename: "lead.jpg",
          mimeType: "image/jpeg",
          intakeRequirementKey: null,
          isActive: true,
        },
        {
          id: "deal-inactive-file",
          dealId: "deal-1",
          leadId: null,
          category: "other",
          originalFilename: "inactive.pdf",
          mimeType: "application/pdf",
          intakeRequirementKey: null,
          isActive: false,
        },
        {
          id: "other-active-file",
          dealId: "deal-2",
          leadId: null,
          category: "other",
          originalFilename: "other.pdf",
          mimeType: "application/pdf",
          intakeRequirementKey: null,
          isActive: true,
        },
      ],
    });

    const selectedRows = (await tenantDb
      .select()
      .from(files)
      .where(and(eq(files.isActive, true), or(eq(files.dealId, "deal-1"), eq(files.leadId, "lead-1"))))
      .then((rows) => rows)) as FakeFileRow[];

    expect(selectedRows.map((row) => row.id)).toEqual(["deal-active-file", "lead-active-file"]);
  });

  it("returns rows matched before fake tenant db update mutations", async () => {
    const tenantDb = createFakeTenantDb({
      files: [
        {
          id: "file-1",
          dealId: "deal-1",
          leadId: null,
          category: "other",
          originalFilename: "scope.pdf",
          mimeType: "application/pdf",
          intakeRequirementKey: null,
          isActive: true,
        },
        {
          id: "file-2",
          dealId: "deal-2",
          leadId: null,
          category: "other",
          originalFilename: "other.pdf",
          mimeType: "application/pdf",
          intakeRequirementKey: null,
          isActive: true,
        },
      ],
    });

    const returnedRows = (await tenantDb
      .update(files)
      .set({ dealId: "deal-3" })
      .where(eq(files.dealId, "deal-1"))
      .returning()) as FakeFileRow[];

    expect(returnedRows).toHaveLength(1);
    expect(returnedRows[0]).toMatchObject({ id: "file-1", dealId: "deal-3" });
    expect(tenantDb.state.files.find((file) => file.id === "file-2")).toMatchObject({ dealId: "deal-2" });
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
      message: "Invalid project type",
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

  it("auto-populates existing deal documents into the Scope docs attachment bucket before readiness", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 1,
    });

    const tenantDb = createFakeTenantDb({
      files: [
        {
          id: "file-scope-doc",
          dealId: "deal-1",
          category: "rfp",
          originalFilename: "roof-plan.pdf",
          mimeType: "application/pdf",
          r2Key: "deals/deal-1/roof-plan.pdf",
          r2Bucket: "crm-files",
          intakeRequirementKey: null,
          intakeSource: null,
          isActive: true,
        },
        {
          id: "file-other-deal",
          dealId: "deal-2",
          category: "other",
          originalFilename: "other-deal.pdf",
          mimeType: "application/pdf",
          r2Key: "deals/deal-2/other-deal.pdf",
          r2Bucket: "crm-files",
          intakeRequirementKey: null,
          intakeSource: null,
          isActive: true,
        },
      ],
    });

    const readiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1", { persist: false });

    expect(readiness.attachmentRequirements).toContainEqual(
      expect.objectContaining({ key: "scope_docs", category: "other", satisfied: true })
    );
    expect(tenantDb.state.files[0]).toMatchObject({
      id: "file-scope-doc",
      dealId: "deal-1",
      category: "rfp",
      intakeSection: "attachments",
      intakeRequirementKey: "scope_docs",
      intakeSource: "scoping_intake",
    });
    expect(tenantDb.state.files.find((file) => file.id === "file-other-deal")).toMatchObject({
      dealId: "deal-2",
      intakeRequirementKey: null,
      intakeSource: null,
    });
    expect(tenantDb.state.files).toHaveLength(2);
  });

  it("does not auto-populate attachments (no write) when evaluated read-only for a non-owner observer", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 1,
    });

    const tenantDb = createFakeTenantDb({
      files: [
        {
          id: "file-scope-doc",
          dealId: "deal-1",
          category: "rfp",
          originalFilename: "roof-plan.pdf",
          mimeType: "application/pdf",
          r2Key: "deals/deal-1/roof-plan.pdf",
          r2Bucket: "crm-files",
          intakeRequirementKey: null,
          intakeSource: null,
          isActive: true,
        },
      ],
    });

    const readiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1", { readOnly: true });

    // The file is left untouched — a passive director/admin readiness check must not mutate the owner's
    // scoping intake (no attachment linking, no persisted readiness)...
    expect(tenantDb.state.files[0]).toMatchObject({
      id: "file-scope-doc",
      intakeRequirementKey: null,
      intakeSource: null,
    });
    // ...yet readiness is still ACCURATE: the would-be-auto-populated file is counted in memory, so a
    // non-owner director sees the same satisfied scope_docs requirement the owner would (button enables).
    expect(readiness.attachmentRequirements).toContainEqual(
      expect.objectContaining({ key: "scope_docs", category: "other", satisfied: true })
    );
  });

  it("read-only readiness counts a SOURCE-LEAD scope_docs file (dealId null) without attaching it to the deal", async () => {
    // The bug this guards: required attachments that live only on the source lead (dealId null) are
    // normally pulled onto the deal by auto-population — a WRITE. In read-only mode (a non-owner
    // director/admin observing the gate) that write is skipped, so resolveScopedAttachmentCandidates must
    // still reach the lead file in memory, or the director's Trigger RFP button would be stuck disabled.
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
          name: "Converted Lead Deal",
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
          sourceLeadId: "lead-1",
        },
      ],
      files: [
        {
          id: "file-lead-scope-doc",
          dealId: null,
          leadId: "lead-1",
          category: "rfp",
          originalFilename: "roof-plan.pdf",
          mimeType: "application/pdf",
          r2Key: "leads/lead-1/roof-plan.pdf",
          r2Bucket: "crm-files",
          intakeRequirementKey: null,
          intakeSource: null,
          isActive: true,
        },
      ],
    });

    const readiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1", { readOnly: true });

    // The lead's file is NOT pulled onto the deal and its intake fields stay null — no write occurs, even
    // through the source-lead path.
    expect(tenantDb.state.files[0]).toMatchObject({
      id: "file-lead-scope-doc",
      dealId: null,
      leadId: "lead-1",
      intakeRequirementKey: null,
      intakeSource: null,
    });
    // ...yet the would-be-auto-populated lead file is still counted in memory, so scope_docs is satisfied.
    expect(readiness.attachmentRequirements).toContainEqual(
      expect.objectContaining({ key: "scope_docs", category: "other", satisfied: true })
    );
  });

  it("auto-populates source-lead image files into the Site photos attachment bucket and attaches them to the deal", async () => {
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
          name: "Converted Lead Deal",
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
          sourceLeadId: "lead-1",
        },
      ],
      files: [
        {
          id: "file-site-photo",
          dealId: null,
          leadId: "lead-1",
          category: "other",
          originalFilename: "site-photo.heic",
          mimeType: "application/octet-stream",
          r2Key: "leads/lead-1/site-photo.heic",
          r2Bucket: "crm-files",
          intakeRequirementKey: null,
          intakeSource: null,
          isActive: true,
        },
        {
          id: "file-other-lead",
          dealId: null,
          leadId: "lead-2",
          category: "other",
          originalFilename: "other-lead-photo.jpg",
          mimeType: "image/jpeg",
          r2Key: "leads/lead-2/other-lead-photo.jpg",
          r2Bucket: "crm-files",
          intakeRequirementKey: null,
          intakeSource: null,
          isActive: true,
        },
      ],
    });

    const readiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1", { persist: false });

    expect(readiness.attachmentRequirements).toContainEqual(
      expect.objectContaining({ key: "site_photos", category: "photo", satisfied: true })
    );
    expect(tenantDb.state.files[0]).toMatchObject({
      id: "file-site-photo",
      dealId: "deal-1",
      leadId: "lead-1",
      category: "other",
      intakeSection: "attachments",
      intakeRequirementKey: "site_photos",
      intakeSource: "scoping_intake",
    });
    expect(tenantDb.state.files.find((file) => file.id === "file-other-lead")).toMatchObject({
      dealId: null,
      leadId: "lead-2",
      intakeRequirementKey: null,
      intakeSource: null,
    });
    expect(tenantDb.state.files).toHaveLength(2);
  });

  it("excludes foreign lead-linked files before version-chain attachment resolution", async () => {
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
          name: "Converted Lead Deal",
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
          sourceLeadId: "lead-1",
        },
      ],
      files: [
        {
          id: "lead-scope-root",
          dealId: null,
          leadId: "lead-1",
          category: "other",
          originalFilename: "lead-scope.pdf",
          mimeType: "application/pdf",
          r2Key: "leads/lead-1/lead-scope.pdf",
          r2Bucket: "crm-files",
          version: 1,
          intakeRequirementKey: null,
          intakeSource: null,
          isActive: true,
        },
        {
          id: "foreign-deal-newer-version",
          dealId: "deal-2",
          leadId: "lead-1",
          category: "photo",
          originalFilename: "foreign-version.jpg",
          mimeType: "image/jpeg",
          r2Key: "deals/deal-2/foreign-version.jpg",
          r2Bucket: "crm-files",
          parentFileId: "lead-scope-root",
          version: 2,
          intakeSection: "attachments",
          intakeRequirementKey: "site_photos",
          intakeSource: "scoping_intake",
          isActive: true,
        },
      ],
    });

    const readiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1", { persist: false });

    expect(readiness.attachmentRequirements).toContainEqual(
      expect.objectContaining({ key: "scope_docs", category: "other", satisfied: true })
    );
    expect(tenantDb.state.files.find((file) => file.id === "lead-scope-root")).toMatchObject({
      dealId: "deal-1",
      intakeSection: "attachments",
      intakeRequirementKey: "scope_docs",
      intakeSource: "scoping_intake",
    });
    expect(tenantDb.state.files.find((file) => file.id === "foreign-deal-newer-version")).toMatchObject({
      dealId: "deal-2",
      intakeRequirementKey: "site_photos",
      intakeSource: "scoping_intake",
    });
  });

  it("maps lead-scoping document keys before MIME fallback during converted deal scoping", async () => {
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
          name: "Converted Lead Deal",
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
          sourceLeadId: "lead-1",
        },
      ],
      files: [
        {
          id: "file-lead-scope-doc",
          dealId: null,
          leadId: "lead-1",
          category: "other",
          originalFilename: "lead-scoping-plan.jpg",
          mimeType: "image/jpeg",
          r2Key: "leads/lead-1/lead-scoping-plan.jpg",
          r2Bucket: "crm-files",
          intakeSection: "attachments",
          intakeRequirementKey: "plansDrawings",
          intakeSource: "lead_scoping_intake",
          isActive: true,
        },
      ],
    });

    const readiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1", { persist: false });

    expect(readiness.attachmentRequirements).toContainEqual(
      expect.objectContaining({ key: "scope_docs", category: "other", satisfied: false })
    );
    expect(tenantDb.state.files[0]).toMatchObject({
      id: "file-lead-scope-doc",
      dealId: "deal-1",
      leadId: "lead-1",
      category: "other",
      intakeSection: "attachments",
      intakeRequirementKey: "scope_docs",
      intakeSource: "scoping_intake",
    });
  });

  it("does not satisfy readiness when linked files are in the wrong scoping bucket", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 1,
    });

    const tenantDb = createFakeTenantDb({
      files: [
        {
          id: "photo-linked-as-scope-doc",
          dealId: "deal-1",
          category: "photo",
          originalFilename: "site-photo.jpg",
          mimeType: "image/jpeg",
          r2Key: "deals/deal-1/site-photo.jpg",
          r2Bucket: "crm-files",
          intakeSection: "attachments",
          intakeRequirementKey: "scope_docs",
          intakeSource: "scoping_intake",
          isActive: true,
        },
        {
          id: "pdf-linked-as-site-photo",
          dealId: "deal-1",
          category: "other",
          originalFilename: "scope.pdf",
          mimeType: "application/pdf",
          r2Key: "deals/deal-1/scope.pdf",
          r2Bucket: "crm-files",
          intakeSection: "attachments",
          intakeRequirementKey: "site_photos",
          intakeSource: "scoping_intake",
          isActive: true,
        },
      ],
    });

    const readiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1", { persist: false });

    expect(readiness.attachmentRequirements).toEqual([
      expect.objectContaining({ key: "scope_docs", category: "other", satisfied: false }),
      expect.objectContaining({ key: "site_photos", category: "photo", satisfied: false }),
    ]);
  });

  it("does not auto-populate attachments once the scope is locked by an RFP submission", async () => {
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
          name: "Submitted RFP Deal",
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
          rfpApprovalStatus: "pending",
        },
      ],
      files: [
        {
          id: "file-after-submit",
          dealId: "deal-1",
          category: "other",
          originalFilename: "late-scope.pdf",
          mimeType: "application/pdf",
          r2Key: "deals/deal-1/late-scope.pdf",
          r2Bucket: "crm-files",
          intakeRequirementKey: null,
          intakeSource: null,
          isActive: true,
        },
      ],
    });

    const readiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1", { persist: false });

    expect(readiness.attachmentRequirements).toContainEqual(
      expect.objectContaining({ key: "scope_docs", category: "other", satisfied: false })
    );
    expect(tenantDb.state.files[0].id).toBe("file-after-submit");
    expect(tenantDb.state.files[0].dealId).toBe("deal-1");
    expect(tenantDb.state.files[0].intakeSection).toBeUndefined();
    expect(tenantDb.state.files[0].intakeRequirementKey).toBeNull();
    expect(tenantDb.state.files[0].intakeSource).toBeNull();
  });

  it("auto-populates only the latest active file version into scoping attachments", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 1,
    });

    const tenantDb = createFakeTenantDb({
      files: [
        {
          id: "file-old-version",
          dealId: "deal-1",
          category: "other",
          originalFilename: "scope-old.pdf",
          mimeType: "application/pdf",
          r2Key: "deals/deal-1/scope-old.pdf",
          r2Bucket: "crm-files",
          version: 1,
          intakeRequirementKey: null,
          intakeSource: null,
          isActive: true,
        },
        {
          id: "file-version-2",
          dealId: "deal-1",
          category: "other",
          originalFilename: "scope-v2.pdf",
          mimeType: "application/pdf",
          r2Key: "deals/deal-1/scope-v2.pdf",
          r2Bucket: "crm-files",
          parentFileId: "file-old-version",
          version: 2,
          intakeRequirementKey: null,
          intakeSource: null,
          isActive: true,
        },
        {
          id: "file-version-3",
          dealId: "deal-1",
          category: "rfp",
          originalFilename: "scope-v3.pdf",
          mimeType: "application/pdf",
          r2Key: "deals/deal-1/scope-v3.pdf",
          r2Bucket: "crm-files",
          parentFileId: "file-old-version",
          version: 3,
          intakeRequirementKey: null,
          intakeSource: null,
          isActive: true,
        },
      ],
    });

    const readiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1", { persist: false });

    expect(readiness.attachmentRequirements).toContainEqual(
      expect.objectContaining({ key: "scope_docs", category: "other", satisfied: true })
    );
    expect(tenantDb.state.files.find((file) => file.id === "file-old-version")).toMatchObject({
      intakeRequirementKey: null,
      intakeSource: null,
    });
    expect(tenantDb.state.files.find((file) => file.id === "file-version-2")).toMatchObject({
      intakeRequirementKey: null,
      intakeSource: null,
    });
    expect(tenantDb.state.files.find((file) => file.id === "file-version-3")).toMatchObject({
      category: "rfp",
      intakeSection: "attachments",
      intakeRequirementKey: "scope_docs",
      intakeSource: "scoping_intake",
    });
  });

  it("keeps versioned locked scoping attachments visible from the latest active file", async () => {
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
          name: "Submitted RFP Deal",
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
          rfpApprovalStatus: "pending",
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
          firstReadyAt: new Date("2026-04-08T09:00:00.000Z"),
          activatedAt: new Date("2026-04-08T09:00:00.000Z"),
          lastAutosavedAt: new Date("2026-04-08T09:00:00.000Z"),
          createdBy: "user-1",
          lastEditedBy: "user-1",
          createdAt: new Date("2026-04-08T08:00:00.000Z"),
          updatedAt: new Date("2026-04-08T09:00:00.000Z"),
        },
      ],
      files: [
        {
          id: "file-linked-parent",
          dealId: "deal-1",
          category: "other",
          originalFilename: "scope-parent.pdf",
          mimeType: "application/pdf",
          r2Key: "deals/deal-1/scope-parent.pdf",
          r2Bucket: "crm-files",
          intakeSection: "attachments",
          intakeRequirementKey: "scope_docs",
          intakeSource: "scoping_intake",
          isActive: true,
        },
        {
          id: "file-version-child",
          dealId: "deal-1",
          category: "other",
          originalFilename: "scope-child.pdf",
          mimeType: "application/pdf",
          r2Key: "deals/deal-1/scope-child.pdf",
          r2Bucket: "crm-files",
          parentFileId: "file-linked-parent",
          intakeRequirementKey: null,
          intakeSource: null,
          isActive: true,
        },
      ],
    });

    const result = await getOrCreateDealScopingIntake(tenantDb as never, "deal-1", "user-1");

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      id: "file-version-child",
      category: "other",
      intakeSection: "attachments",
      intakeRequirementKey: "scope_docs",
      intakeSource: "scoping_intake",
    });
    expect(result.readiness.attachmentRequirements).toContainEqual(
      expect.objectContaining({ key: "scope_docs", category: "other", satisfied: true })
    );
    expect(tenantDb.state.files.find((file) => file.id === "file-version-child")).toMatchObject({
      intakeRequirementKey: null,
      intakeSource: null,
    });
  });

  it("does not auto-populate new files after service handoff activation", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "service_deal",
      displayOrder: 1,
    });
    pipelineMocks.getStageBySlug.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "service_deal",
      displayOrder: 1,
    });

    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          name: "Activated Service Deal",
          stageId: "stage-opportunity",
          workflowRoute: "service",
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
          workflowRouteSnapshot: "service",
          status: "activated",
          projectTypeId: null,
          sectionData: {},
          completionState: {},
          readinessErrors: {},
          firstReadyAt: new Date("2026-04-08T09:00:00.000Z"),
          activatedAt: new Date("2026-04-08T09:00:00.000Z"),
          lastAutosavedAt: new Date("2026-04-08T09:00:00.000Z"),
          createdBy: "user-1",
          lastEditedBy: "user-1",
          createdAt: new Date("2026-04-08T08:00:00.000Z"),
          updatedAt: new Date("2026-04-08T09:00:00.000Z"),
        },
      ],
      files: [
        {
          id: "file-after-service-handoff",
          dealId: "deal-1",
          category: "photo",
          originalFilename: "late-service-photo.jpg",
          mimeType: "image/jpeg",
          r2Key: "deals/deal-1/late-service-photo.jpg",
          r2Bucket: "crm-files",
          intakeRequirementKey: null,
          intakeSource: null,
          isActive: true,
        },
      ],
    });

    const readiness = await evaluateDealScopingReadiness(tenantDb as never, "deal-1", { persist: false });

    expect(readiness.status).toBe("activated");
    expect(readiness.attachmentRequirements).toContainEqual(
      expect.objectContaining({ key: "site_photos", category: "photo", satisfied: false })
    );
    expect(tenantDb.state.files[0]).toMatchObject({
      id: "file-after-service-handoff",
      dealId: "deal-1",
      intakeRequirementKey: null,
      intakeSource: null,
    });
  });

  it("leaves already-linked scoping attachments unchanged when readiness runs repeatedly", async () => {
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      workflowFamily: "standard_deal",
      displayOrder: 1,
    });

    const existingUpdatedAt = new Date("2026-04-01T12:00:00.000Z");
    const tenantDb = createFakeTenantDb({
      files: [
        {
          id: "file-linked-photo",
          dealId: "deal-1",
          category: "photo",
          originalFilename: "linked-photo.jpg",
          mimeType: "image/jpeg",
          r2Key: "deals/deal-1/linked-photo.jpg",
          r2Bucket: "crm-files",
          intakeSection: "attachments",
          intakeRequirementKey: "site_photos",
          intakeSource: "scoping_intake",
          isActive: true,
          updatedAt: existingUpdatedAt,
        },
      ],
    });

    await evaluateDealScopingReadiness(tenantDb as never, "deal-1", { persist: false });
    await evaluateDealScopingReadiness(tenantDb as never, "deal-1", { persist: false });

    expect(tenantDb.state.files).toHaveLength(1);
    expect(tenantDb.state.files[0]).toMatchObject({
      id: "file-linked-photo",
      dealId: "deal-1",
      category: "photo",
      intakeSection: "attachments",
      intakeRequirementKey: "site_photos",
      intakeSource: "scoping_intake",
      updatedAt: existingUpdatedAt,
    });
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
          category: "other",
          originalFilename: "uploaded-scope.pdf",
          mimeType: "application/pdf",
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
        intakeRequirementKey: "scope_docs",
      },
      "user-1"
    );

    expect(file.id).toBe("file-1");
    expect(file.dealId).toBe("deal-1");
    expect(file.intakeSection).toBe("attachments");
    expect(file.intakeRequirementKey).toBe("scope_docs");
    expect(file.intakeSource).toBe("scoping_intake");
    expect(tenantDb.state.files).toHaveLength(1);
  });
});
