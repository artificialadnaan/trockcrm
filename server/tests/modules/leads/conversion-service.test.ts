import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  companies,
  contacts,
  deals,
  leadStageHistory,
  leads,
  properties,
  tasks,
  userOfficeAccess,
  users,
} from "../../../../shared/src/schema/index.js";
import {
  BID_BOARD_MIRRORED_STAGE_SLUGS,
  CRM_OWNED_LEAD_STAGE_SLUGS,
  SALES_WORKFLOW_DISQUALIFICATION_REASONS,
  SALES_WORKFLOW_PIPELINE_TYPES,
} from "../../../../shared/src/types/sales-workflow.js";
import { LEAD_STATUSES } from "../../helpers/worktree-shared-contracts.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";
import { createLeadConversionService } from "../../../src/modules/leads/conversion-service.js";
import { createDeal, updateDeal } from "../../../src/modules/deals/service.js";
import { createLeadService } from "../../../src/modules/leads/service.js";

const pipelineMocks = vi.hoisted(() => ({
  getAllStages: vi.fn(),
  getStageById: vi.fn(),
  getStageBySlug: vi.fn(),
  getActiveProjectTypes: vi.fn(async () => []),
}));

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getAllStages: pipelineMocks.getAllStages,
  getStageById: pipelineMocks.getStageById,
  getStageBySlug: pipelineMocks.getStageBySlug,
  getActiveProjectTypes: pipelineMocks.getActiveProjectTypes,
}));

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("../../../src/db.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0019_properties_and_leads.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");
const pipelineFamilyMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0020_pipeline_workflow_families.sql"
);
const pipelineFamilyMigrationSql = readFileSync(pipelineFamilyMigrationPath, "utf8");
const salesWorkflowRealignmentMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0028_sales_workflow_realignment.sql"
);
const salesWorkflowRealignmentMigrationSql = readFileSync(salesWorkflowRealignmentMigrationPath, "utf8");

function expectSqlToMatch(pattern: RegExp): void {
  expect(migrationSql).toMatch(pattern);
}

function expectPipelineFamilySqlToMatch(pattern: RegExp): void {
  expect(pipelineFamilyMigrationSql).toMatch(pattern);
}

function expectSalesWorkflowRealignmentSqlToMatch(pattern: RegExp): void {
  expect(salesWorkflowRealignmentMigrationSql).toMatch(pattern);
}

describe("Sales workflow shared contract", () => {
  it("publishes the canonical CRM-owned lead stages and pipeline split", () => {
    expect(CRM_OWNED_LEAD_STAGE_SLUGS).toEqual([
      "new_lead",
      "qualified_lead",
      "sales_validation_stage",
      "opportunity",
    ]);
    expect(SALES_WORKFLOW_PIPELINE_TYPES).toEqual(["service", "normal"]);
  });

  it("publishes the terminal CRM disqualification taxonomy and mirrored bid board stages", () => {
    expect(SALES_WORKFLOW_DISQUALIFICATION_REASONS).toEqual([
      "no_budget",
      "not_a_fit",
      "no_authority",
      "no_timeline",
      "duplicate",
      "unresponsive",
      "customer_declined",
      "other",
    ]);
    expect(BID_BOARD_MIRRORED_STAGE_SLUGS).toEqual([
      "estimating",
      "bid_sent",
      "in_production",
      "close_out",
      "closed_won",
      "closed_lost",
    ]);
  });

  it("adds the CRM-owned pre-estimating fields to leads", () => {
    const columns = getTableColumns(leads);

    expect(columns.pipelineType.name).toBe("pipeline_type");
    expect(columns.pipelineType.hasDefault).toBe(true);
    expect(columns.pipelineType.default).toBe("normal");
    expect(columns.existingCustomerResolution.name).toBe("existing_customer_resolution");
    expect(columns.existingCustomerResolvedAt.name).toBe("existing_customer_resolved_at");
    expect(columns.existingCustomerResolvedBy.name).toBe("existing_customer_resolved_by");
    expect(columns.projectTypeId.name).toBe("project_type_id");
    expect(columns.qualificationPayload.name).toBe("qualification_payload");
    expect(columns.projectTypeQuestionPayload.name).toBe("project_type_question_payload");
    expect(columns.preQualValue.name).toBe("pre_qual_value");
    expect(columns.submissionStartedAt.name).toBe("submission_started_at");
    expect(columns.submissionCompletedAt.name).toBe("submission_completed_at");
    expect(columns.submissionDurationSeconds.name).toBe("submission_duration_seconds");
    expect(columns.executiveDecision.name).toBe("executive_decision");
    expect(columns.executiveDecisionAt.name).toBe("executive_decision_at");
    expect(columns.executiveDecisionBy.name).toBe("executive_decision_by");
    expect(columns.disqualificationReason.name).toBe("disqualification_reason");
    expect(columns.disqualificationReasonNotes.name).toBe("disqualification_reason_notes");
    expect(columns.disqualifiedAt.name).toBe("disqualified_at");
    expect(columns.disqualifiedBy.name).toBe("disqualified_by");
  });

  it("adds read-only bid board mirror metadata to deals", () => {
    const columns = getTableColumns(deals);

    expect(columns.isBidBoardOwned.name).toBe("is_bid_board_owned");
    expect(columns.isBidBoardOwned.hasDefault).toBe(true);
    expect(columns.isBidBoardOwned.default).toBe(false);
    expect(columns.bidBoardStageSlug.name).toBe("bid_board_stage_slug");
    expect(columns.bidBoardStageStatus.name).toBe("bid_board_stage_status");
    expect(columns.bidBoardStageEnteredAt.name).toBe("bid_board_stage_entered_at");
    expect(columns.bidBoardStageExitedAt.name).toBe("bid_board_stage_exited_at");
    expect(columns.bidBoardStageDuration.name).toBe("bid_board_stage_duration");
    expect(columns.bidBoardMirrorSourceEnteredAt.name).toBe("bid_board_mirror_source_entered_at");
    expect(columns.bidBoardMirrorSourceExitedAt.name).toBe("bid_board_mirror_source_exited_at");
    expect(columns.pipelineTypeSnapshot.name).toBe("pipeline_type_snapshot");
    expect(columns.pipelineTypeSnapshot.hasDefault).toBe(true);
    expect(columns.pipelineTypeSnapshot.default).toBe("normal");
    expect(columns.regionClassification.name).toBe("region_classification");
    expect(columns.isReadOnlyMirror.name).toBe("is_read_only_mirror");
    expect(columns.isReadOnlySyncDirty.name).toBe("is_read_only_sync_dirty");
    expect(columns.readOnlySyncedAt.name).toBe("read_only_synced_at");
  });

  it("backfills the sales workflow realignment migration contract", () => {
    expect(salesWorkflowRealignmentMigrationSql).toContain(
      "CREATE TYPE lead_pipeline_type AS ENUM ('service', 'normal')"
    );
    expect(salesWorkflowRealignmentMigrationSql).toContain("CREATE TYPE lead_disqualification_reason AS ENUM");
    expect(salesWorkflowRealignmentMigrationSql).toContain("'no_budget'");
    expect(salesWorkflowRealignmentMigrationSql).toContain("'other'");
    expect(salesWorkflowRealignmentMigrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS pipeline_type lead_pipeline_type"
    );
    expect(salesWorkflowRealignmentMigrationSql).toContain(
      "SET pipeline_type = COALESCE("
    );
    expect(salesWorkflowRealignmentMigrationSql).toContain(
      "pipeline_type, ''normal''::lead_pipeline_type"
    );
    expect(salesWorkflowRealignmentMigrationSql).toContain(
      "ALTER COLUMN pipeline_type SET DEFAULT ''normal''::lead_pipeline_type"
    );
    expect(salesWorkflowRealignmentMigrationSql).toContain(
      "ALTER COLUMN pipeline_type SET NOT NULL"
    );
    expect(salesWorkflowRealignmentMigrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS pipeline_type_snapshot deal_pipeline_type_snapshot"
    );
    expect(salesWorkflowRealignmentMigrationSql).toContain("workflow_route = ''service''");
    expect(salesWorkflowRealignmentMigrationSql).toContain(
      "ALTER COLUMN pipeline_type_snapshot SET DEFAULT ''normal''::deal_pipeline_type_snapshot"
    );
    expect(salesWorkflowRealignmentMigrationSql).toContain(
      "ALTER COLUMN pipeline_type_snapshot SET NOT NULL"
    );
  });
});

type RouteServiceMocks = {
  createDeal: ReturnType<typeof vi.fn>;
  updateDeal: ReturnType<typeof vi.fn>;
};

async function loadDealRoutesWithServiceMocks() {
  vi.resetModules();

  const routeServiceMocks: RouteServiceMocks = {
    createDeal: vi.fn(),
    updateDeal: vi.fn(),
  };

  vi.doMock("../../../src/modules/deals/service.js", async () => {
    const actual = await vi.importActual<typeof import("../../../src/modules/deals/service.js")>(
      "../../../src/modules/deals/service.js"
    );

    return {
      ...actual,
      getDealById: vi.fn(async () => ({ id: "deal-1", assignedRepId: "rep-1" })),
      getDeals: vi.fn(),
      getDealDetail: vi.fn(),
      createDeal: routeServiceMocks.createDeal,
      updateDeal: routeServiceMocks.updateDeal,
      deleteDeal: vi.fn(),
      getDealsForPipeline: vi.fn(),
      getDealSources: vi.fn(),
    };
  });

  vi.doMock("../../../src/modules/deals/stage-change.js", () => ({
    changeDealStage: vi.fn(),
    activateServiceHandoff: vi.fn(),
  }));

  vi.doMock("../../../src/modules/deals/stage-gate.js", () => ({
    preflightStageCheck: vi.fn(),
  }));

  vi.doMock("../../../src/modules/contacts/association-service.js", () => ({
    getContactsForDeal: vi.fn(),
  }));

  vi.doMock("../../../src/modules/deals/scoping-service.js", () => ({
    evaluateDealScopingReadiness: vi.fn(),
    getOrCreateDealScopingIntake: vi.fn(),
    linkDealFileToScopingRequirement: vi.fn(),
    upsertDealScopingIntake: vi.fn(),
  }));

  vi.doMock("../../../src/events/bus.js", () => ({
    eventBus: {
      emitLocal: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
      setMaxListeners: vi.fn(),
    },
  }));

  const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
  return { dealRoutes, routeServiceMocks };
}

function findDealRouteHandler(
  dealRoutes: unknown,
  method: "post" | "patch",
  path: string
) {
  const layer = (dealRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method]
  );

  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }

  const routeLayer = layer.route.stack.find((entry: any) => entry.method === method);
  if (!routeLayer) {
    throw new Error(`Route handler ${method.toUpperCase()} ${path} not found`);
  }

  return routeLayer.handle as (req: any, res: any, next: (err?: unknown) => void) => unknown;
}

async function invokeDealRoute({
  dealRoutes,
  method,
  path,
  params = {},
  body = {},
  userRole = "director",
}: {
  dealRoutes: unknown;
  method: "post" | "patch";
  path: "/" | "/:id";
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  userRole?: "admin" | "director" | "rep";
}) {
  const handler = findDealRouteHandler(dealRoutes, method, path);
  const req = {
    params,
    body,
    tenantDb: {
      insert: vi.fn(() => ({
        values: vi.fn(async () => ({})),
      })),
    },
    user: {
      id: userRole === "rep" ? "rep-1" : "director-1",
      role: userRole,
      officeId: "office-1",
      activeOfficeId: "office-1",
    },
    commitTransaction: vi.fn(async () => {}),
  } as any;
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  } as any;
  const next = vi.fn((err?: unknown) => {
    if (err) {
      throw err;
    }
  });

  await handler(req, res, next);
  return { req, res, next };
}

interface FakeCompanyRow {
  id: string;
  name: string;
  slug: string;
  category: "other";
  isActive: boolean;
}

interface FakePropertyRow {
  id: string;
  companyId: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  isActive: boolean;
}

interface FakeContactRow {
  id: string;
  companyId: string;
  isActive: boolean;
}

interface FakeUserRow {
  id: string;
  officeId: string;
  isActive: boolean;
}

interface FakeLeadRow {
  id: string;
  companyId: string;
  propertyId: string;
  primaryContactId: string | null;
  name: string;
  stageId: string;
  assignedRepId: string;
  status: "open" | "converted" | "disqualified";
  pipelineType?: "normal" | "service";
  preQualValue?: string | null;
  source: string | null;
  description: string | null;
  stageEnteredAt: Date;
  convertedAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeDealRow {
  id: string;
  dealNumber: string;
  name: string;
  stageId: string;
  assignedRepId: string;
  primaryContactId: string | null;
  companyId: string | null;
  propertyId: string | null;
  sourceLeadId: string | null;
  source: string | null;
  workflowRoute: "normal" | "service";
}

interface FakeUserOfficeAccessRow {
  userId: string;
  officeId: string;
}

interface FakeLeadStageHistoryRow {
  id: string;
  leadId: string;
  fromStageId: string | null;
  toStageId: string;
  changedBy: string;
  isBackwardMove: boolean;
  durationInPreviousStage: unknown;
  createdAt: Date;
}

interface FakeTenantState {
  companies: FakeCompanyRow[];
  properties: FakePropertyRow[];
  contacts: FakeContactRow[];
  users: FakeUserRow[];
  userOfficeAccess: FakeUserOfficeAccessRow[];
  leads: FakeLeadRow[];
  deals: FakeDealRow[];
  leadStageHistory: FakeLeadStageHistoryRow[];
}

function createFakeTenantDb(initialState?: Partial<FakeTenantState>) {
  const now = new Date("2026-04-15T15:00:00.000Z");
  const state: FakeTenantState = {
    companies: [
      {
        id: "company-1",
        name: "Palm Villas",
        slug: "palm-villas",
        category: "other",
        isActive: true,
      },
    ],
    properties: [
      {
        id: "property-1",
        companyId: "company-1",
        name: "Palm Villas North",
        address: "123 Palm Way",
        city: "Miami",
        state: "FL",
        zip: "33101",
        isActive: true,
      },
    ],
    contacts: [
      {
        id: "contact-1",
        companyId: "company-1",
        isActive: true,
      },
    ],
    users: [
      {
        id: "rep-1",
        officeId: "office-1",
        isActive: true,
      },
      {
        id: "rep-2",
        officeId: "office-1",
        isActive: true,
      },
      {
        id: "director-1",
        officeId: "office-1",
        isActive: true,
      },
    ],
    userOfficeAccess: [],
    leads: [],
    deals: [],
    tasks: [],
    leadStageHistory: [],
    ...initialState,
  };

  function getRows(table: unknown) {
    const tableName = (table as { _: { name?: string } })?._?.name;
    const candidate = table as Record<string, unknown>;

    if (table === companies || tableName === "companies") return state.companies;
    if (table === properties || tableName === "properties") return state.properties;
    if (table === contacts || tableName === "contacts") return state.contacts;
    if (table === users || tableName === "users") return state.users;
    if (table === userOfficeAccess || tableName === "user_office_access") return state.userOfficeAccess;
    if (table === leads || tableName === "leads") return state.leads;
    if (table === deals || tableName === "deals") return state.deals;
    if (table === tasks || tableName === "tasks") return state.tasks;
    if (table === leadStageHistory || tableName === "lead_stage_history") return state.leadStageHistory;
    if ("slug" in candidate && "category" in candidate && "website" in candidate) return state.companies;
    if ("lat" in candidate && "lng" in candidate && "companyId" in candidate) return state.properties;
    if ("companyId" in candidate && "firstName" in candidate && "lastName" in candidate) return state.contacts;
    if ("email" in candidate && "role" in candidate && "officeId" in candidate) return state.users;
    if ("userId" in candidate && "roleOverride" in candidate) return state.userOfficeAccess;
    if ("convertedAt" in candidate && "stageEnteredAt" in candidate && "assignedRepId" in candidate) return state.leads;
    if ("dealNumber" in candidate && "workflowRoute" in candidate && "sourceLeadId" in candidate) return state.deals;
    if ("assignedTo" in candidate && "entitySnapshot" in candidate && "dueDate" in candidate) return state.tasks;
    if ("leadId" in candidate && "changedBy" in candidate && "toStageId" in candidate) return state.leadStageHistory;
    throw new Error("Unexpected table in fake tenant db");
  }

  function camelCase(name: string) {
    return name.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
  }

  function getObjectPropertyByName(object: Record<string, unknown>, key: string) {
    if (key in object) {
      return object[key];
    }

    const camelKey = camelCase(key);
    if (camelKey in object) {
      return object[camelKey];
    }

    return undefined;
  }

  function isSqlChunk(value: unknown): value is { queryChunks: unknown[] } {
    return Boolean(value) && typeof value === "object" && Array.isArray((value as { queryChunks?: unknown[] }).queryChunks);
  }

  function isParamChunk(value: unknown): value is { value: unknown } {
    return Boolean(value) && typeof value === "object" && "encoder" in (value as Record<string, unknown>);
  }

  function isColumnChunk(value: unknown): value is { name: string } {
    return Boolean(value) && typeof value === "object" && typeof (value as { name?: unknown }).name === "string";
  }

  function getStringChunkValue(value: unknown) {
    if (!value || typeof value !== "object" || !("value" in (value as Record<string, unknown>))) {
      return "";
    }

    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) {
      return chunkValue.join("");
    }

    return typeof chunkValue === "string" ? chunkValue : "";
  }

  function parsePredicate(condition: unknown): (row: Record<string, unknown>) => boolean {
    if (!condition || !isSqlChunk(condition)) {
      return () => true;
    }

    const nestedSqlChunks = condition.queryChunks.filter(isSqlChunk);
    if (nestedSqlChunks.length > 0) {
      const separators = condition.queryChunks
        .map(getStringChunkValue)
        .filter((value) => value.includes(" and ") || value.includes(" or "));

      if (separators.some((value) => value.includes(" or "))) {
        const predicates = nestedSqlChunks.map(parsePredicate);
        return (row) => predicates.some((predicate) => predicate(row));
      }

      const predicates = nestedSqlChunks.map(parsePredicate);
      return (row) => predicates.every((predicate) => predicate(row));
    }

    const joinedChunks = condition.queryChunks.map(getStringChunkValue).join("").toLowerCase();
    const column = condition.queryChunks.find(isColumnChunk);
    const param = condition.queryChunks.find(isParamChunk);

    if (column && param && joinedChunks.includes(" ilike ")) {
      const propertyName = camelCase(column.name);
      const rawPattern = String(param.value ?? "").toLowerCase();
      const startsWithWildcard = rawPattern.startsWith("%");
      const endsWithWildcard = rawPattern.endsWith("%");
      const pattern = rawPattern.replace(/^%|%$/g, "");

      return (row) => {
        const value = String(row[propertyName] ?? "").toLowerCase();

        if (startsWithWildcard && endsWithWildcard) {
          return value.includes(pattern);
        }

        if (startsWithWildcard) {
          return value.endsWith(pattern);
        }

        if (endsWithWildcard) {
          return value.startsWith(pattern);
        }

        return value === pattern;
      };
    }

    if (column && param && joinedChunks.includes(" = ")) {
      const propertyName = camelCase(column.name);
      return (row) => row[propertyName] === param.value;
    }

    if (column && joinedChunks.includes(" is null")) {
      const propertyName = camelCase(column.name);
      return (row) => row[propertyName] == null;
    }

    if (column && joinedChunks.includes(" is not null")) {
      const propertyName = camelCase(column.name);
      return (row) => row[propertyName] != null;
    }

    return () => true;
  }

  function cloneRow<T>(row: T): T {
    return { ...row };
  }

  function applyWhere<T extends Record<string, unknown>>(rows: T[], condition: unknown) {
    const predicate = parsePredicate(condition);
    return rows.filter((row) => predicate(row));
  }

  return {
    state,
    execute() {
      return Promise.resolve();
    },
    select(selectedFields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          const rows = getRows(table) as Array<Record<string, unknown>>;
          return createQueryBuilder(rows, selectedFields);
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
            then(onfulfilled: (value: unknown) => unknown) {
              return Promise.resolve(insertedRow).then(onfulfilled);
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
              const matchingRows = applyWhere(rows, condition);
              matchingRows.forEach((row) => {
                for (const [key, value] of Object.entries(values)) {
                  row[key] = value;
                }
              });
              return {
                returning() {
                  return Promise.resolve(matchingRows);
                },
              };
            },
          };
        },
      };
    },
  };

  function createQueryBuilder(
    sourceRows: Array<Record<string, unknown>>,
    fields?: Record<string, unknown>
  ) {
    let rows = [...sourceRows];

    function materialize(selectedRows: Array<Record<string, unknown>>) {
      if (!fields) {
        return selectedRows.map(cloneRow);
      }

      return selectedRows.map((row) => {
        const projectedRow: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(fields)) {
          if (isColumnChunk(field)) {
            projectedRow[key] = getObjectPropertyByName(row, field.name);
          }
        }
        return projectedRow;
      });
    }

    const queryBuilder = {
      where(condition: unknown) {
        rows = applyWhere(sourceRows, condition);
        return queryBuilder;
      },
      orderBy() {
        return queryBuilder;
      },
      offset(offset: number) {
        rows = rows.slice(offset);
        return queryBuilder;
      },
      limit(limit: number) {
        rows = rows.slice(0, limit);
        return queryBuilder;
      },
      for() {
        return queryBuilder;
      },
      then(onfulfilled: (value: unknown[]) => unknown) {
        return Promise.resolve(materialize(rows)).then(onfulfilled);
      },
    };

    return queryBuilder;
  }
}

const leadStage = {
  id: "lead-stage-1",
  name: "Contacted",
  slug: "contacted",
  displayOrder: 1,
  workflowFamily: "lead" as const,
  isActivePipeline: true,
  isTerminal: false,
};

const salesValidationLeadStage = {
  id: "lead-stage-sales-validation",
  name: "Sales Validation Stage",
  slug: "sales_validation_stage",
  displayOrder: 3,
  workflowFamily: "lead" as const,
  isActivePipeline: true,
  isTerminal: false,
};

const opportunityLeadStage = {
  id: "lead-stage-opportunity",
  name: "Opportunity",
  slug: "opportunity",
  displayOrder: 4,
  workflowFamily: "lead" as const,
  isActivePipeline: true,
  isTerminal: true,
};

const dealStage = {
  id: "deal-stage-1",
  name: "Qualified",
  slug: "qualified",
  displayOrder: 1,
  workflowFamily: "standard_deal" as const,
  isActivePipeline: true,
  isTerminal: false,
};

beforeEach(() => {
  pipelineMocks.getStageById.mockReset();
  pipelineMocks.getStageBySlug.mockReset();
  pipelineMocks.getStageById.mockImplementation(async (id: string, workflowFamily?: string) => {
    if (workflowFamily === "lead") {
      if (id === salesValidationLeadStage.id) {
        return salesValidationLeadStage;
      }
      if (id === opportunityLeadStage.id) {
        return opportunityLeadStage;
      }
      return leadStage;
    }

    return dealStage;
  });
  pipelineMocks.getStageBySlug.mockImplementation(async (slug: string, workflowFamily?: string) => {
    if (workflowFamily === "lead" && slug === "opportunity") {
      return opportunityLeadStage;
    }

    return null;
  });
});

describe("Lead Conversion Shared Contract", () => {
  it("defines the lead lifecycle statuses used during conversion", () => {
    expect(LEAD_STATUSES).toEqual(["open", "converted", "disqualified"]);
  });

  it("anchors properties to companies", () => {
    const columns = getTableColumns(properties);
    const config = getTableConfig(properties);

    expect(columns.companyId.name).toBe("company_id");
    expect(columns.companyId.notNull).toBe(true);
    expect(columns.name.notNull).toBe(true);
    expect(columns.isActive.hasDefault).toBe(true);
    expect(columns.isActive.default).toBe(true);
    expect(config.foreignKeys.map((fk) => fk.getName())).toEqual([
      "properties_company_id_companies_id_fk",
    ]);
  });

  it("defines leads as the canonical pre-RFP record tied to company and property", () => {
    const columns = getTableColumns(leads);
    const config = getTableConfig(leads);

    expect(columns.companyId.name).toBe("company_id");
    expect(columns.companyId.notNull).toBe(true);
    expect(columns.propertyId.name).toBe("property_id");
    expect(columns.propertyId.notNull).toBe(true);
    expect(columns.assignedRepId.notNull).toBe(true);
    expect(columns.stageId.notNull).toBe(true);
    expect(columns.status.hasDefault).toBe(true);
    expect(columns.status.default).toBe("open");
    expect(columns.stageEnteredAt.hasDefault).toBe(true);
    expect(columns.isActive.default).toBe(true);
    expect(config.foreignKeys.map((fk) => fk.getName()).sort()).toEqual([
      "leads_assigned_rep_id_users_id_fk",
      "leads_company_id_companies_id_fk",
      "leads_director_reviewed_by_users_id_fk",
      "leads_disqualified_by_users_id_fk",
      "leads_executive_decision_by_users_id_fk",
      "leads_existing_customer_resolved_by_users_id_fk",
      "leads_forecast_updated_by_users_id_fk",
      "leads_primary_contact_id_contacts_id_fk",
      "leads_project_type_id_project_type_config_id_fk",
      "leads_property_id_properties_id_fk",
    ]);
  });

  it("stores lead stage lineage separately from deals", () => {
    const columns = getTableColumns(leadStageHistory);
    const config = getTableConfig(leadStageHistory);

    expect(columns.leadId.name).toBe("lead_id");
    expect(columns.leadId.notNull).toBe(true);
    expect(columns.fromStageId.notNull).toBe(false);
    expect(columns.toStageId.notNull).toBe(true);
    expect(columns.changedBy.notNull).toBe(true);
    expect(config.foreignKeys.map((fk) => fk.getName()).sort()).toEqual([
      "lead_stage_history_changed_by_users_id_fk",
      "lead_stage_history_lead_id_leads_id_fk",
    ]);
  });

  it("adds nullable lineage fields to deals while enforcing one successor deal per lead", () => {
    const columns = getTableColumns(deals);
    const config = getTableConfig(deals);

    expect(columns.propertyId.name).toBe("property_id");
    expect(columns.propertyId.notNull).toBe(false);
    expect(columns.sourceLeadId.name).toBe("source_lead_id");
    expect(columns.sourceLeadId.notNull).toBe(false);
    expect(columns.sourceLeadId.isUnique).toBe(true);
    expect(config.foreignKeys.map((fk) => fk.getName())).toEqual(
      expect.arrayContaining([
        "deals_company_id_companies_id_fk",
        "deals_primary_contact_id_contacts_id_fk",
        "deals_property_id_properties_id_fk",
        "deals_source_lead_id_leads_id_fk",
      ])
    );
  });

  it("creates the properties, leads, and lineage migration contract", () => {
    expectSqlToMatch(
      /CREATE TABLE IF NOT EXISTS %I\.properties\s*\(\s*id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\),\s*company_id UUID NOT NULL REFERENCES %I\.companies\(id\),\s*name VARCHAR\(500\) NOT NULL,/s
    );
    expectSqlToMatch(
      /CREATE TABLE IF NOT EXISTS %I\.leads\s*\(\s*id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\),\s*company_id UUID NOT NULL REFERENCES %I\.companies\(id\),\s*property_id UUID NOT NULL REFERENCES %I\.properties\(id\),\s*primary_contact_id UUID REFERENCES %I\.contacts\(id\),[\s\S]*assigned_rep_id UUID NOT NULL REFERENCES public\.users\(id\),\s*status lead_status NOT NULL DEFAULT ''open''/s
    );
    expectSqlToMatch(
      /CREATE TABLE IF NOT EXISTS %I\.lead_stage_history\s*\(\s*id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\),\s*lead_id UUID NOT NULL REFERENCES %I\.leads\(id\),[\s\S]*changed_by UUID NOT NULL REFERENCES public\.users\(id\),[\s\S]*duration_in_previous_stage INTERVAL/s
    );
    expectSqlToMatch(
      /ALTER TABLE %I\.deals\s+ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES %I\.properties\(id\)/s
    );
    expectSqlToMatch(
      /ALTER TABLE %I\.deals\s+ADD COLUMN IF NOT EXISTS source_lead_id UUID REFERENCES %I\.leads\(id\)/s
    );
    expectSqlToMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS deals_source_lead_id_idx\s+ON %I\.deals \(source_lead_id\)\s+WHERE source_lead_id IS NOT NULL/s
    );
  });

  it("seeds minimal lead-family stages for fresh environments", () => {
    expectPipelineFamilySqlToMatch(
      /INSERT INTO public\.pipeline_stage_config[\s\S]*\('Contacted',\s*'contacted',\s*1,\s*'lead',\s*true,\s*false,\s*'#2563EB'\)[\s\S]*\('Converted',\s*'converted',\s*99,\s*'lead',\s*false,\s*true,\s*'#16A34A'\)/s
    );
  });
});

describe("Lead Service", () => {
  it("creates a lead under a company and property", async () => {
    const tenantDb = createFakeTenantDb();
    const service = createLeadService({
      getStageById: async () => leadStage,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    const lead = await service.createLead(tenantDb as never, {
      companyId: "company-1",
      propertyId: "property-1",
      stageId: "lead-stage-1",
      assignedRepId: "rep-1",
      name: "Palm Villas repaint",
      source: "Referral",
      description: "Property manager requested pre-bid walk",
    });

    expect(lead.companyId).toBe("company-1");
    expect(lead.propertyId).toBe("property-1");
    expect(lead.assignedRepId).toBe("rep-1");
    expect(lead.status).toBe("open");
    expect(lead.isActive).toBe(true);
    expect(tenantDb.state.leads).toHaveLength(1);
  });

  it("revalidates the primary contact hierarchy when primaryContactId changes", async () => {
    const tenantDb = createFakeTenantDb({
      companies: [
        {
          id: "company-1",
          name: "Palm Villas",
          slug: "palm-villas",
          category: "other",
          isActive: true,
        },
        {
          id: "company-2",
          name: "Ocean View",
          slug: "ocean-view",
          category: "other",
          isActive: true,
        },
      ],
      contacts: [
        { id: "contact-1", companyId: "company-1", isActive: true },
        { id: "contact-2", companyId: "company-2", isActive: true },
      ],
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: "contact-1",
          name: "Palm Villas repaint",
          stageId: "lead-stage-1",
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadService({
      getStageById: async () => leadStage,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    await expect(
      service.updateLead(
        tenantDb as never,
        "lead-1",
        { primaryContactId: "contact-2" },
        "director",
        "director-1"
      )
    ).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: "Primary contact does not belong to the company",
    });
  });
});

describe("Lead Conversion Service", () => {
  it("converts one lead into one successor deal", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Palm Villas repaint",
          stageId: "lead-stage-sales-validation",
          assignedRepId: "rep-1",
          status: "open",
          pipelineType: "normal",
          preQualValue: "85000",
          source: "Referral",
          description: "Property manager requested pre-bid walk",
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadConversionService({
      getStageById: pipelineMocks.getStageById as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
      createDeal: async (_tenantDb, input) => {
        const deal = {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          workflowRoute: input.workflowRoute ?? "normal",
          primaryContactId: input.primaryContactId ?? null,
          companyId: input.companyId ?? null,
          propertyId: input.propertyId ?? null,
          sourceLeadId: input.sourceLeadId ?? null,
          source: input.source ?? null,
          assignedRepId: input.assignedRepId,
          stageId: input.stageId,
          name: input.name,
        };
        tenantDb.state.deals.push(deal);
        return deal as never;
      },
    });

    const result = await service.convertLead(tenantDb as never, {
      leadId: "lead-1",
      dealStageId: "deal-stage-1",
      userRole: "rep",
      userId: "rep-1",
    });

    expect(result.deal.id).toBe("deal-1");
    expect(result.deal.sourceLeadId).toBe("lead-1");
    expect(result.deal.workflowRoute).toBe("normal");
    expect(result.lead.status).toBe("converted");
    expect(result.lead.convertedAt).toEqual(new Date("2026-04-15T15:00:00.000Z"));
    expect(result.lead.stageId).toBe("lead-stage-opportunity");
    expect(result.lead.stageEnteredAt).toEqual(new Date("2026-04-15T15:00:00.000Z"));
    expect(tenantDb.state.leadStageHistory).toEqual([
      expect.objectContaining({
        leadId: "lead-1",
        fromStageId: "lead-stage-sales-validation",
        toStageId: "lead-stage-opportunity",
        changedBy: "rep-1",
      }),
    ]);
    expect(tenantDb.state.deals).toHaveLength(1);
  });

  it("only promotes a lead into Opportunity from Sales Validation Stage", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Palm Villas repaint",
          stageId: "lead-stage-1",
          assignedRepId: "rep-1",
          status: "open",
          pipelineType: "normal",
          preQualValue: "85000",
          source: "Referral",
          description: null,
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const createDealSpy = vi.fn();
    const service = createLeadConversionService({
      getStageById: pipelineMocks.getStageById as never,
      createDeal: createDealSpy as never,
    });

    await expect(
      service.convertLead(tenantDb as never, {
        leadId: "lead-1",
        dealStageId: "deal-stage-1",
        userRole: "rep",
        userId: "rep-1",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 409,
      message: "Only Sales Validation Stage leads can be promoted to Opportunity",
    });

    expect(createDealSpy).not.toHaveBeenCalled();
    expect(tenantDb.state.leads[0]?.status).toBe("open");
  });

  it.each([
    {
      name: "service work below the $50k boundary",
      pipelineType: "service" as const,
      preQualValue: "49999.99",
      expectedRoute: "service" as const,
    },
    {
      name: "normal work at or above the $50k boundary",
      pipelineType: "normal" as const,
      preQualValue: "50000",
      expectedRoute: "normal" as const,
    },
  ])("maps %s into the correct downstream route", async ({ pipelineType, preQualValue, expectedRoute }) => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Palm Villas repaint",
          stageId: "lead-stage-sales-validation",
          assignedRepId: "rep-1",
          status: "open",
          pipelineType,
          preQualValue,
          source: "Referral",
          description: null,
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadConversionService({
      getStageById: pipelineMocks.getStageById as never,
      createDeal: async (_tenantDb, input) =>
        ({
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          workflowRoute: input.workflowRoute ?? "normal",
          primaryContactId: input.primaryContactId ?? null,
          companyId: input.companyId ?? null,
          propertyId: input.propertyId ?? null,
          sourceLeadId: input.sourceLeadId ?? null,
          source: input.source ?? null,
          assignedRepId: input.assignedRepId,
          stageId: input.stageId,
          name: input.name,
        }) as never,
    });

    const result = await service.convertLead(tenantDb as never, {
      leadId: "lead-1",
      dealStageId: "deal-stage-1",
      userRole: "rep",
      userId: "rep-1",
    });

    expect(result.deal.workflowRoute).toBe(expectedRoute);
  });

  it("prevents multiple conversions from the same lead", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Palm Villas repaint",
          stageId: "lead-stage-sales-validation",
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadConversionService({
      getStageById: pipelineMocks.getStageById as never,
      createDeal: async (_tenantDb, input) => {
        const deal = {
          id: `deal-${tenantDb.state.deals.length + 1}`,
          dealNumber: `TR-2026-000${tenantDb.state.deals.length + 1}`,
          workflowRoute: input.workflowRoute ?? "normal",
          primaryContactId: input.primaryContactId ?? null,
          companyId: input.companyId ?? null,
          propertyId: input.propertyId ?? null,
          sourceLeadId: input.sourceLeadId ?? null,
          source: input.source ?? null,
          assignedRepId: input.assignedRepId,
          stageId: input.stageId,
          name: input.name,
        };
        tenantDb.state.deals.push(deal);
        return deal as never;
      },
    });

    await service.convertLead(tenantDb as never, {
      leadId: "lead-1",
      dealStageId: "deal-stage-1",
      userRole: "rep",
      userId: "rep-1",
    });

    await expect(
      service.convertLead(tenantDb as never, {
        leadId: "lead-1",
        dealStageId: "deal-stage-1",
        userRole: "rep",
        userId: "rep-1",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 409,
      message: "Lead has already been converted",
    });
  });

  it("preserves lead ownership and lineage on conversion", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Palm Villas repaint",
          stageId: "lead-stage-sales-validation",
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: "Preserve lineage",
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadConversionService({
      getStageById: pipelineMocks.getStageById as never,
      createDeal: async (_tenantDb, input) => {
        const deal = {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          workflowRoute: input.workflowRoute ?? "normal",
          primaryContactId: input.primaryContactId ?? null,
          companyId: input.companyId ?? null,
          propertyId: input.propertyId ?? null,
          sourceLeadId: input.sourceLeadId ?? null,
          source: input.source ?? null,
          assignedRepId: input.assignedRepId,
          stageId: input.stageId,
          name: input.name,
        };
        tenantDb.state.deals.push(deal);
        return deal as never;
      },
    });

    const result = await service.convertLead(tenantDb as never, {
      leadId: "lead-1",
      dealStageId: "deal-stage-1",
      userRole: "rep",
      userId: "rep-1",
    });

    expect(result.deal.assignedRepId).toBe("rep-1");
    expect(result.deal.companyId).toBe("company-1");
    expect(result.deal.propertyId).toBe("property-1");
    expect(result.deal.sourceLeadId).toBe("lead-1");
    expect(result.deal.source).toBe("Referral");
  });

  it("rejects converting another rep's lead", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Palm Villas repaint",
          stageId: "lead-stage-1",
          assignedRepId: "rep-2",
          status: "open",
          source: "Referral",
          description: null,
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const createDealSpy = vi.fn();
    const service = createLeadConversionService({
      getStageById: pipelineMocks.getStageById as never,
      createDeal: createDealSpy as never,
    });

    await expect(
      service.convertLead(tenantDb as never, {
        leadId: "lead-1",
        dealStageId: "deal-stage-1",
        userRole: "rep",
        userId: "rep-1",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 403,
      message: "You can only convert your own leads",
    });

    expect(createDealSpy).not.toHaveBeenCalled();
    expect(tenantDb.state.deals).toHaveLength(0);
  });

  it("rejects rep-driven reassignment of the successor deal", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Palm Villas repaint",
          stageId: "lead-stage-sales-validation",
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const createDealSpy = vi.fn();
    const service = createLeadConversionService({
      getStageById: pipelineMocks.getStageById as never,
      createDeal: createDealSpy as never,
    });

    await expect(
      service.convertLead(tenantDb as never, {
        leadId: "lead-1",
        dealStageId: "deal-stage-1",
        assignedRepId: "rep-2",
        userRole: "rep",
        userId: "rep-1",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 403,
      message: "You cannot reassign the successor deal",
    });

    expect(createDealSpy).not.toHaveBeenCalled();
    expect(tenantDb.state.deals).toHaveLength(0);
  });

  it.each([
    {
      name: "disqualified leads",
      lead: { status: "disqualified" as const, isActive: false },
      message: "Disqualified leads cannot be converted",
    },
    {
      name: "inactive leads",
      lead: { status: "open" as const, isActive: false },
      message: "Inactive leads cannot be converted",
    },
  ])("rejects conversion for $name", async ({ lead, message }) => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Palm Villas repaint",
          stageId: "lead-stage-1",
          assignedRepId: "rep-1",
          status: lead.status,
          source: "Referral",
          description: null,
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: lead.isActive,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const createDealSpy = vi.fn();
    const service = createLeadConversionService({
      getStageById: pipelineMocks.getStageById as never,
      createDeal: createDealSpy as never,
    });

    await expect(
      service.convertLead(tenantDb as never, {
        leadId: "lead-1",
        dealStageId: "deal-stage-1",
        userRole: "rep",
        userId: "rep-1",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message,
    });

    expect(createDealSpy).not.toHaveBeenCalled();
    expect(tenantDb.state.deals).toHaveLength(0);
  });

  it("fails conversion when the opportunity lead stage is not configured", async () => {
    pipelineMocks.getStageBySlug.mockResolvedValueOnce(null);

    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Palm Villas repaint",
          stageId: "lead-stage-sales-validation",
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const createDealSpy = vi.fn();
    const service = createLeadConversionService({
      createDeal: createDealSpy as never,
    });

    await expect(
      service.convertLead(tenantDb as never, {
        leadId: "lead-1",
        dealStageId: "deal-stage-1",
        userRole: "rep",
        userId: "rep-1",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 500,
      message: "Missing opportunity lead stage configuration",
    });

    expect(createDealSpy).not.toHaveBeenCalled();
    expect(tenantDb.state.leads[0]?.status).toBe("open");
    expect(tenantDb.state.leadStageHistory).toHaveLength(0);
  });
});

describe("Deal Lineage Enforcement", () => {
  it("rejects direct successor deal creation outside the dedicated lead conversion flow", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: "contact-1",
          name: "Palm Villas repaint",
          stageId: "lead-stage-1",
          assignedRepId: "rep-2",
          status: "open",
          source: "Referral",
          description: null,
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });

    await expect(
      createDeal(tenantDb as never, {
        name: "Bypass successor deal",
        stageId: "deal-stage-1",
        assignedRepId: "rep-1",
        sourceLeadId: "lead-1",
        workflowRoute: "normal",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: "Use the lead conversion endpoint to create deals from leads",
    });

    expect(tenantDb.state.leads[0]?.status).toBe("open");
    expect(tenantDb.state.deals).toHaveLength(0);
  });

  it("rejects creating a second deal for the same source lead with a controlled validation error", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: "contact-1",
          name: "Palm Villas repaint",
          stageId: "lead-stage-1",
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
      deals: [
        {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          name: "Existing successor deal",
          stageId: "deal-stage-1",
          assignedRepId: "rep-1",
          primaryContactId: "contact-1",
          companyId: "company-1",
          propertyId: "property-1",
          sourceLeadId: "lead-1",
          source: "Referral",
          workflowRoute: "normal",
        },
      ],
    });

    await expect(
      createDeal(tenantDb as never, {
        name: "Duplicate successor deal",
        stageId: "deal-stage-1",
        assignedRepId: "rep-1",
        sourceLeadId: "lead-1",
        workflowRoute: "normal",
        sourceLeadWriteMode: "lead_conversion",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 409,
      message: "A deal already exists for this source lead",
    });
  });

  it("rejects deal creation when the primary contact belongs to a different company", async () => {
    const tenantDb = createFakeTenantDb({
      companies: [
        {
          id: "company-1",
          name: "Palm Villas",
          slug: "palm-villas",
          category: "other",
          isActive: true,
        },
        {
          id: "company-2",
          name: "Ocean View",
          slug: "ocean-view",
          category: "other",
          isActive: true,
        },
      ],
      contacts: [
        { id: "contact-1", companyId: "company-1", isActive: true },
        { id: "contact-2", companyId: "company-2", isActive: true },
      ],
    });

    await expect(
      createDeal(tenantDb as never, {
        name: "Cross-company contact deal",
        stageId: "deal-stage-1",
        assignedRepId: "rep-1",
        migrationMode: true,
        companyId: "company-1",
        propertyId: "property-1",
        primaryContactId: "contact-2",
        workflowRoute: "normal",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: "Primary contact does not belong to the company",
    });
  });

  it("rejects updating a legacy deal without source lead lineage unless migrationMode is explicit", async () => {
    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-legacy-1",
          dealNumber: "TR-2026-0099",
          name: "Legacy Deal",
          stageId: "deal-stage-1",
          assignedRepId: "rep-1",
          primaryContactId: null,
          companyId: "company-1",
          propertyId: "property-1",
          sourceLeadId: null,
          source: "HubSpot",
          workflowRoute: "normal",
        },
      ],
    });

    await expect(
      updateDeal(
        tenantDb as never,
        "deal-legacy-1",
        { name: "Legacy Deal Updated" },
        "director",
        "director-1"
      )
    ).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: "Legacy deals require migrationMode=true until source lead lineage is backfilled",
    });
  });

  it("allows updating a legacy deal when migrationMode is explicit", async () => {
    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-legacy-1",
          dealNumber: "TR-2026-0099",
          name: "Legacy Deal",
          stageId: "deal-stage-1",
          assignedRepId: "rep-1",
          primaryContactId: null,
          companyId: "company-1",
          propertyId: "property-1",
          sourceLeadId: null,
          source: "HubSpot",
          workflowRoute: "normal",
        },
      ],
    });

    const updated = await updateDeal(
      tenantDb as never,
      "deal-legacy-1",
      { name: "Legacy Deal Updated", migrationMode: true },
      "director",
      "director-1"
    );

    expect(updated.name).toBe("Legacy Deal Updated");
  });

  it("rejects attaching a source lead that is already linked to another deal", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: "contact-1",
          name: "Palm Villas repaint",
          stageId: "lead-stage-1",
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
      deals: [
        {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          name: "Existing successor deal",
          stageId: "deal-stage-1",
          assignedRepId: "rep-1",
          primaryContactId: "contact-1",
          companyId: "company-1",
          propertyId: "property-1",
          sourceLeadId: "lead-1",
          source: "Referral",
          workflowRoute: "normal",
        },
        {
          id: "deal-2",
          dealNumber: "TR-2026-0002",
          name: "Legacy deal awaiting lineage",
          stageId: "deal-stage-1",
          assignedRepId: "rep-1",
          primaryContactId: null,
          companyId: "company-1",
          propertyId: "property-1",
          sourceLeadId: null,
          source: "Referral",
          workflowRoute: "normal",
        },
      ],
    });

    await expect(
      updateDeal(
        tenantDb as never,
        "deal-2",
        { sourceLeadId: "lead-1", migrationMode: true },
        "director",
        "director-1"
      )
    ).rejects.toMatchObject<AppError>({
      statusCode: 409,
      message: "A deal already exists for this source lead",
    });
  });

  it("rejects updating a deal to use a primary contact from a different company", async () => {
    const tenantDb = createFakeTenantDb({
      companies: [
        {
          id: "company-1",
          name: "Palm Villas",
          slug: "palm-villas",
          category: "other",
          isActive: true,
        },
        {
          id: "company-2",
          name: "Ocean View",
          slug: "ocean-view",
          category: "other",
          isActive: true,
        },
      ],
      contacts: [
        { id: "contact-1", companyId: "company-1", isActive: true },
        { id: "contact-2", companyId: "company-2", isActive: true },
      ],
      deals: [
        {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          name: "Palm Villas deal",
          stageId: "deal-stage-1",
          assignedRepId: "rep-1",
          primaryContactId: "contact-1",
          companyId: "company-1",
          propertyId: "property-1",
          sourceLeadId: null,
          source: "Referral",
          workflowRoute: "normal",
        },
      ],
    });

    await expect(
      updateDeal(
        tenantDb as never,
        "deal-1",
        { primaryContactId: "contact-2", migrationMode: true },
        "director",
        "director-1"
      )
    ).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: "Primary contact does not belong to the company",
    });
  });
});

describe("Public Deal Route Guardrails", () => {
  it("strips migrationMode from public deal-create requests", async () => {
    const { dealRoutes, routeServiceMocks } = await loadDealRoutesWithServiceMocks();
    routeServiceMocks.createDeal.mockResolvedValueOnce({ id: "deal-1" });

    await invokeDealRoute({
      dealRoutes,
      method: "post",
      path: "/",
      body: {
        name: "Route-created deal",
        stageId: "deal-stage-1",
        assignedRepId: "rep-2",
        sourceLeadId: "lead-1",
        migrationMode: true,
      },
      userRole: "director",
    });

    expect(routeServiceMocks.createDeal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "Route-created deal",
        stageId: "deal-stage-1",
        assignedRepId: "rep-2",
        sourceLeadId: "lead-1",
      })
    );
    expect(routeServiceMocks.createDeal.mock.calls[0]?.[1]).not.toHaveProperty("migrationMode");
  });

  it("strips migrationMode from public deal-update requests", async () => {
    const { dealRoutes, routeServiceMocks } = await loadDealRoutesWithServiceMocks();
    routeServiceMocks.updateDeal.mockResolvedValueOnce({ id: "deal-1" });

    await invokeDealRoute({
      dealRoutes,
      method: "patch",
      path: "/:id",
      params: { id: "deal-1" },
      body: {
        sourceLeadId: "lead-1",
        migrationMode: true,
      },
      userRole: "director",
    });

    expect(routeServiceMocks.updateDeal).toHaveBeenCalledWith(
      expect.anything(),
      "deal-1",
      expect.objectContaining({
        sourceLeadId: "lead-1",
      }),
      "director",
      "director-1",
      "office-1"
    );
    expect(routeServiceMocks.updateDeal.mock.calls[0]?.[2]).not.toHaveProperty("migrationMode");
  });
});
