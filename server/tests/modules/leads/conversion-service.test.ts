import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  companies,
  contacts,
  deals,
  dealTeamRoleEnum,
  leadStageHistory,
  leads,
  properties,
  userOfficeAccess,
  users,
} from "../../../../shared/src/schema/index.js";
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
}));

const leadStageGateMocks = vi.hoisted(() => ({
  validateLeadStageGate: vi.fn(),
}));

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getAllStages: pipelineMocks.getAllStages,
  getStageById: pipelineMocks.getStageById,
  getStageBySlug: pipelineMocks.getStageBySlug,
}));

vi.mock("../../../src/modules/leads/stage-gate.js", () => ({
  validateLeadStageGate: leadStageGateMocks.validateLeadStageGate,
}));

vi.mock("../../../src/modules/assignment-tasks/service.js", () => ({
  createAssignmentTaskIfNeeded: vi.fn(async () => undefined),
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
const salesFunnelAlignmentMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0028_sales_funnel_model_alignment.sql"
);
const salesFunnelAlignmentMigrationSql = readFileSync(salesFunnelAlignmentMigrationPath, "utf8");
const workflowAlignmentMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0028_pipeline_workflow_alignment.sql"
);
const workflowAlignmentMigrationSql = existsSync(workflowAlignmentMigrationPath)
  ? readFileSync(workflowAlignmentMigrationPath, "utf8")
  : "";
const leadPipelineCleanupMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0046_lead_pipeline_legacy_stage_cleanup.sql"
);
const leadPipelineCleanupMigrationSql = existsSync(leadPipelineCleanupMigrationPath)
  ? readFileSync(leadPipelineCleanupMigrationPath, "utf8")
  : "";
const leadPipelineRemapMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0047_remap_legacy_open_lead_stages.sql"
);
const leadPipelineRemapMigrationSql = existsSync(leadPipelineRemapMigrationPath)
  ? readFileSync(leadPipelineRemapMigrationPath, "utf8")
  : "";

function expectSqlToMatch(pattern: RegExp): void {
  expect(migrationSql).toMatch(pattern);
}

function expectPipelineFamilySqlToMatch(pattern: RegExp): void {
  expect(pipelineFamilyMigrationSql).toMatch(pattern);
}

function expectSalesFunnelAlignmentSqlToMatch(pattern: RegExp): void {
  expect(salesFunnelAlignmentMigrationSql).toMatch(pattern);
}

function expectWorkflowAlignmentSqlToMatch(pattern: RegExp): void {
  expect(workflowAlignmentMigrationSql).toMatch(pattern);
}

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
  source: string | null;
  description: string | null;
  qualificationScope?: string | null;
  qualificationBudgetAmount?: string | null;
  qualificationCompanyFit?: boolean | null;
  qualificationCompletedAt?: Date | null;
  directorReviewDecision?: "go" | "no_go" | null;
  directorReviewedAt?: Date | null;
  directorReviewedBy?: string | null;
  directorReviewReason?: string | null;
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
  pipelineDisposition?: "opportunity" | "deals" | "service" | null;
  assignedRepId: string;
  primaryContactId: string | null;
  companyId: string | null;
  propertyId: string | null;
  sourceLeadId: string | null;
  source: string | null;
  workflowRoute: "estimating" | "service" | null;
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
    if (table === leadStageHistory || tableName === "lead_stage_history") return state.leadStageHistory;
    if ("slug" in candidate && "category" in candidate && "website" in candidate) return state.companies;
    if ("lat" in candidate && "lng" in candidate && "companyId" in candidate) return state.properties;
    if ("companyId" in candidate && "firstName" in candidate && "lastName" in candidate) return state.contacts;
    if ("email" in candidate && "role" in candidate && "officeId" in candidate) return state.users;
    if ("userId" in candidate && "roleOverride" in candidate) return state.userOfficeAccess;
    if ("convertedAt" in candidate && "stageEnteredAt" in candidate && "assignedRepId" in candidate) return state.leads;
    if ("dealNumber" in candidate && "workflowRoute" in candidate && "sourceLeadId" in candidate) return state.deals;
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
  displayOrder: 10,
  workflowFamily: "lead" as const,
  isActivePipeline: true,
  isTerminal: false,
};

const qualifiedLeadStage = {
  id: "stage-qualified-lead",
  name: "Qualified Lead",
  slug: "qualified_lead",
  displayOrder: 20,
  workflowFamily: "lead" as const,
  isActivePipeline: true,
  isTerminal: false,
};

const directorReviewStage = {
  id: "stage-director-go-no-go",
  name: "Director Go/No-Go",
  slug: "director_go_no_go",
  displayOrder: 30,
  workflowFamily: "lead" as const,
  isActivePipeline: true,
  isTerminal: false,
};

const readyForOpportunityStage = {
  id: "stage-ready-for-opportunity",
  name: "Ready for Opportunity",
  slug: "ready_for_opportunity",
  displayOrder: 40,
  workflowFamily: "lead" as const,
  isActivePipeline: true,
  isTerminal: false,
};

const convertedLeadStage = {
  id: "lead-stage-converted",
  name: "Converted",
  slug: "converted",
  displayOrder: 99,
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

const opportunityDealStage = {
  id: "stage-opportunity-standard",
  name: "Opportunity",
  slug: "opportunity",
  displayOrder: 1,
  workflowFamily: "standard_deal" as const,
  isActivePipeline: true,
  isTerminal: false,
};

beforeEach(() => {
  pipelineMocks.getAllStages.mockReset();
  pipelineMocks.getStageById.mockReset();
  pipelineMocks.getStageBySlug.mockReset();
  leadStageGateMocks.validateLeadStageGate.mockReset();
  leadStageGateMocks.validateLeadStageGate.mockResolvedValue({ allowed: true });
  pipelineMocks.getAllStages.mockImplementation(async (workflowFamily?: string) => {
    if (workflowFamily === "lead") {
      return [
        leadStage,
        qualifiedLeadStage,
        directorReviewStage,
        readyForOpportunityStage,
        convertedLeadStage,
      ];
    }
    return [dealStage];
  });
  pipelineMocks.getStageById.mockImplementation(async (id: string, workflowFamily?: string) => {
    if (workflowFamily === "lead") {
      const stageMap = new Map([
        [leadStage.id, leadStage],
        [qualifiedLeadStage.id, qualifiedLeadStage],
        [directorReviewStage.id, directorReviewStage],
        [readyForOpportunityStage.id, readyForOpportunityStage],
        [convertedLeadStage.id, convertedLeadStage],
      ]);
      return stageMap.get(id) ?? leadStage;
    }

    return dealStage;
  });
  pipelineMocks.getStageBySlug.mockImplementation(async (slug: string, workflowFamily?: string) => {
    if (workflowFamily === "lead") {
      if (slug === "converted") {
        return convertedLeadStage;
      }
      if (slug === "qualified_for_opportunity") {
        return {
          ...readyForOpportunityStage,
          id: "stage-qualified-for-opportunity",
          name: "Qualified for Opportunity",
          slug: "qualified_for_opportunity",
        };
      }
      if (slug === "ready_for_opportunity") {
        return readyForOpportunityStage;
      }
    }

    if (workflowFamily === "standard_deal" && slug === "opportunity") {
      return opportunityDealStage;
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
      "leads_forecast_updated_by_users_id_fk",
      "leads_primary_contact_id_contacts_id_fk",
      "leads_property_id_properties_id_fk",
    ]);
  });

  it("stores qualification and director review metadata on leads", () => {
    const columns = getTableColumns(leads);

    expect(columns).toHaveProperty("qualificationCompletedAt");
    expect(columns).toHaveProperty("qualificationBudgetAmount");
    expect(columns).toHaveProperty("qualificationScope");
    expect(columns).toHaveProperty("qualificationCompanyFit");
    expect(columns).toHaveProperty("directorReviewDecision");
    expect(columns).toHaveProperty("directorReviewedAt");
    expect(columns).toHaveProperty("directorReviewedBy");
    expect(columns).toHaveProperty("directorReviewReason");
  });

  it("adds qualification and director review columns to each tenant lead table", () => {
    expectSalesFunnelAlignmentSqlToMatch(/table_name = 'leads'/);
    expectSalesFunnelAlignmentSqlToMatch(/ALTER TABLE %I\.leads[\s\S]*qualification_scope varchar\(255\)/);
    expectSalesFunnelAlignmentSqlToMatch(/director_reviewed_by uuid REFERENCES public\.users\(id\)/);
    expectSalesFunnelAlignmentSqlToMatch(/director_review_reason text/);
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

  it("adds workflow alignment migration seeds for lead qualification and opportunity", () => {
    expectWorkflowAlignmentSqlToMatch(/'New',\s*'lead_new',\s*1,\s*'lead'/);
    expectWorkflowAlignmentSqlToMatch(/'Lead Go\/No-Go',\s*'lead_go_no_go'/);
    expectWorkflowAlignmentSqlToMatch(
      /'Qualified for Opportunity',\s*'qualified_for_opportunity'/
    );
    expectWorkflowAlignmentSqlToMatch(/'Opportunity',\s*'opportunity',\s*1,\s*'standard_deal'/);
  });

  it("deactivates legacy lead stages once the aligned lead pipeline is available", () => {
    expect(existsSync(leadPipelineCleanupMigrationPath)).toBe(true);
    expect(leadPipelineCleanupMigrationSql).toContain("workflow_family = 'lead'");
    expect(leadPipelineCleanupMigrationSql).toContain("slug IN ('contacted'");
    expect(leadPipelineCleanupMigrationSql).toContain("is_active_pipeline = false");
    expect(leadPipelineCleanupMigrationSql).toContain("slug = 'lead_new'");
  });

  it("remaps open leads from legacy lead stages into canonical aligned stages", () => {
    expect(existsSync(leadPipelineRemapMigrationPath)).toBe(true);
    expect(leadPipelineRemapMigrationSql).toContain("slug = 'contacted'");
    expect(leadPipelineRemapMigrationSql).toContain("slug = 'lead_new'");
    expect(leadPipelineRemapMigrationSql).toContain("slug = 'qualified_lead'");
    expect(leadPipelineRemapMigrationSql).toContain("slug = 'pre_qual_value_assigned'");
    expect(leadPipelineRemapMigrationSql).toContain("slug = 'director_go_no_go'");
    expect(leadPipelineRemapMigrationSql).toContain("slug = 'lead_go_no_go'");
    expect(leadPipelineRemapMigrationSql).toContain("slug = 'ready_for_opportunity'");
    expect(leadPipelineRemapMigrationSql).toContain("slug = 'qualified_for_opportunity'");
    expect(leadPipelineRemapMigrationSql).toContain("status = 'open'");
  });

  it("persists neutral opportunity routing state on deals", () => {
    const columns = getTableColumns(deals) as Record<string, any>;

    expect(columns.pipelineDisposition?.name).toBe("pipeline_disposition");
    expect(columns.workflowRoute.notNull).toBe(false);
  });

  it("expands deal team roles for service and operations ownership", () => {
    expect(dealTeamRoleEnum.enumValues).toEqual(
      expect.arrayContaining(["client_services", "operations"])
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

  it("blocks moving a lead into qualified lead when required data is missing", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: "contact-1",
          name: "Palm Villas repaint",
          stageId: leadStage.id,
          assignedRepId: "rep-1",
          status: "open",
          source: null,
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
      getStageById: pipelineMocks.getStageById,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    const result = await service.transitionLeadStage(tenantDb as never, {
      leadId: "lead-1",
      targetStageId: qualifiedLeadStage.id,
      userId: "rep-1",
      userRole: "rep",
    });

    expect(result).toEqual({
      ok: false,
      reason: "missing_requirements",
      targetStageId: qualifiedLeadStage.id,
      resolution: "inline",
      missing: [
        { key: "source", label: "Lead source", resolution: "inline" },
        { key: "qualificationScope", label: "Project scope / category", resolution: "inline" },
        { key: "qualificationBudgetAmount", label: "Approximate budget / dollar amount", resolution: "inline" },
        { key: "qualificationCompanyFit", label: "Company fit / serviceability confirmation", resolution: "inline" },
      ],
    });
  });

  it("blocks moving directly from lead to director review", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: "contact-1",
          name: "Palm Villas repaint",
          stageId: leadStage.id,
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
      getStageById: pipelineMocks.getStageById,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    await expect(
      service.transitionLeadStage(tenantDb as never, {
        leadId: "lead-1",
        targetStageId: directorReviewStage.id,
        userId: "rep-1",
        userRole: "rep",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("returns missing requirements when director go/no-go is not set before ready_for_opportunity", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-director-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: "contact-1",
          name: "Palm Villas repaint",
          stageId: directorReviewStage.id,
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          qualificationScope: "Exterior repaint",
          qualificationBudgetAmount: "120000.00",
          qualificationCompanyFit: true,
          qualificationCompletedAt: new Date("2026-04-14T15:00:00.000Z"),
          stageEnteredAt: new Date("2026-04-14T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-14T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    const result = await service.transitionLeadStage(tenantDb as never, {
      leadId: "lead-director-1",
      targetStageId: readyForOpportunityStage.id,
      userId: "director-1",
      userRole: "director",
    });

    expect(result).toEqual({
      ok: false,
      reason: "missing_requirements",
      targetStageId: readyForOpportunityStage.id,
      resolution: "inline",
      missing: [
        { key: "directorReviewDecision", label: "Director decision", resolution: "inline" },
      ],
    });
  });

  it("requires a reason when a director records no_go", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-director-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: "contact-1",
          name: "Palm Villas repaint",
          stageId: directorReviewStage.id,
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          qualificationScope: "Exterior repaint",
          qualificationBudgetAmount: "120000.00",
          qualificationCompanyFit: true,
          qualificationCompletedAt: new Date("2026-04-14T15:00:00.000Z"),
          stageEnteredAt: new Date("2026-04-14T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-14T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    await expect(
      service.transitionLeadStage(tenantDb as never, {
        leadId: "lead-director-1",
        targetStageId: readyForOpportunityStage.id,
        userId: "director-1",
        userRole: "director",
        inlinePatch: { directorReviewDecision: "no_go", directorReviewReason: null },
      })
    ).rejects.toMatchObject({ statusCode: 400, message: "No-go decisions require a reason" });
  });

  it("prevents reps from recording director go/no-go decisions", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-director-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: "contact-1",
          name: "Palm Villas repaint",
          stageId: directorReviewStage.id,
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          qualificationScope: "Exterior repaint",
          qualificationBudgetAmount: "120000.00",
          qualificationCompanyFit: true,
          qualificationCompletedAt: new Date("2026-04-14T15:00:00.000Z"),
          stageEnteredAt: new Date("2026-04-14T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-14T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    await expect(
      service.transitionLeadStage(tenantDb as never, {
        leadId: "lead-director-1",
        targetStageId: readyForOpportunityStage.id,
        userId: "rep-1",
        userRole: "rep",
        inlinePatch: { directorReviewDecision: "go" },
      })
    ).rejects.toMatchObject({ statusCode: 403, message: "Only directors can record go/no-go decisions" });
  });

  it("allows direct lead stage changes through updateLead when the gate passes", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: "contact-1",
          name: "Palm Villas repaint",
          stageId: leadStage.id,
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
      getStageById: pipelineMocks.getStageById,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    const updatedLead = await service.updateLead(
      tenantDb as never,
      "lead-1",
      { stageId: qualifiedLeadStage.id },
      "director",
      "director-1"
    );

    expect(updatedLead.stageId).toBe(qualifiedLeadStage.id);
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
          stageId: readyForOpportunityStage.id,
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: "Property manager requested pre-bid walk",
          directorReviewDecision: "go",
          directorReviewedAt: new Date("2026-04-14T15:00:00.000Z"),
          directorReviewedBy: "director-1",
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadConversionService({
      now: () => new Date("2026-04-15T15:00:00.000Z"),
      createDeal: async (_tenantDb, input) => {
        const deal = {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          workflowRoute: input.workflowRoute ?? "estimating",
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
    expect(result.lead.status).toBe("converted");
    expect(result.lead.convertedAt).toEqual(new Date("2026-04-15T15:00:00.000Z"));
    expect(result.lead.stageId).toBe("lead-stage-converted");
    expect(result.lead.stageEnteredAt).toEqual(new Date("2026-04-15T15:00:00.000Z"));
    expect(tenantDb.state.leadStageHistory).toEqual([
      expect.objectContaining({
        leadId: "lead-1",
        fromStageId: readyForOpportunityStage.id,
        toStageId: "lead-stage-converted",
        changedBy: "rep-1",
      }),
    ]);
    expect(tenantDb.state.deals).toHaveLength(1);
  });

  it("converts qualified leads into a neutral opportunity deal", async () => {
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
      now: () => new Date("2026-04-15T15:00:00.000Z"),
      getStageBySlug: async (slug: string, workflowFamily?: string) => {
        if (workflowFamily === "lead" && slug === "converted") {
          return convertedLeadStage as never;
        }

        if (workflowFamily === "standard_deal" && slug === "opportunity") {
          return {
            id: "stage-opportunity-standard",
            name: "Opportunity",
            slug: "opportunity",
            workflowFamily: "standard_deal",
            displayOrder: 1,
            isTerminal: false,
            isActivePipeline: true,
          } as never;
        }

        return null;
      },
      createDeal: async (_tenantDb, input) => {
        const deal = {
          id: "deal-2",
          dealNumber: "TR-2026-0002",
          pipelineDisposition: input.pipelineDisposition ?? null,
          workflowRoute: input.workflowRoute ?? null,
          primaryContactId: input.primaryContactId ?? null,
          companyId: input.companyId ?? null,
          propertyId: input.propertyId ?? null,
          sourceLeadId: input.sourceLeadId ?? null,
          source: input.source ?? null,
          assignedRepId: input.assignedRepId,
          stageId: input.stageId,
          name: input.name,
        };
        return deal as never;
      },
    });

    const result = await service.convertLead(tenantDb as never, {
      leadId: "lead-1",
      userRole: "rep",
      userId: "rep-1",
    } as any);

    expect(result.deal.stageId).toBe("stage-opportunity-standard");
    expect(result.deal.pipelineDisposition).toBe("opportunity");
    expect(result.deal.workflowRoute).toBeNull();
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
          stageId: readyForOpportunityStage.id,
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          directorReviewDecision: "go",
          directorReviewedAt: new Date("2026-04-14T15:00:00.000Z"),
          directorReviewedBy: "director-1",
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadConversionService({
      createDeal: async (_tenantDb, input) => {
        const deal = {
          id: `deal-${tenantDb.state.deals.length + 1}`,
          dealNumber: `TR-2026-000${tenantDb.state.deals.length + 1}`,
          workflowRoute: input.workflowRoute ?? "estimating",
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
          stageId: readyForOpportunityStage.id,
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: "Preserve lineage",
          directorReviewDecision: "go",
          directorReviewedAt: new Date("2026-04-14T15:00:00.000Z"),
          directorReviewedBy: "director-1",
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadConversionService({
      createDeal: async (_tenantDb, input) => {
        const deal = {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          workflowRoute: input.workflowRoute ?? "estimating",
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

  it("allows conversion from a legacy active lead stage when opportunity stages are not configured", async () => {
    pipelineMocks.getStageBySlug.mockImplementation(async (slug: string, workflowFamily?: string) => {
      if (workflowFamily === "lead" && slug === "converted") {
        return convertedLeadStage;
      }
      if (workflowFamily === "standard_deal" && slug === "opportunity") {
        return opportunityDealStage;
      }
      return null;
    });

    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-legacy",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Legacy conversion lead",
          stageId: leadStage.id,
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: "Legacy funnel",
          directorReviewDecision: null,
          directorReviewedAt: null,
          directorReviewedBy: null,
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadConversionService({
      now: () => new Date("2026-04-15T15:00:00.000Z"),
      createDeal: async (_tenantDb, input) => {
        const deal = {
          id: "deal-legacy",
          dealNumber: "TR-2026-0099",
          workflowRoute: input.workflowRoute ?? "estimating",
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
      leadId: "lead-legacy",
      dealStageId: "deal-stage-1",
      userRole: "rep",
      userId: "rep-1",
    });

    expect(result.deal.id).toBe("deal-legacy");
    expect(result.deal.sourceLeadId).toBe("lead-legacy");
    expect(result.lead.status).toBe("converted");
    expect(result.lead.stageId).toBe(convertedLeadStage.id);
  });

  it("keeps the strict readiness gate when opportunity stages are configured", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-not-ready",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Not ready lead",
          stageId: leadStage.id,
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          directorReviewDecision: null,
          directorReviewedAt: null,
          directorReviewedBy: null,
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
        leadId: "lead-not-ready",
        dealStageId: "deal-stage-1",
        userRole: "rep",
        userId: "rep-1",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: "Lead is not ready for opportunity conversion",
    });

    expect(createDealSpy).not.toHaveBeenCalled();
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
          stageId: readyForOpportunityStage.id,
          assignedRepId: "rep-2",
          status: "open",
          source: "Referral",
          description: null,
          directorReviewDecision: "go",
          directorReviewedAt: new Date("2026-04-14T15:00:00.000Z"),
          directorReviewedBy: "director-1",
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
          stageId: readyForOpportunityStage.id,
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          directorReviewDecision: "go",
          directorReviewedAt: new Date("2026-04-14T15:00:00.000Z"),
          directorReviewedBy: "director-1",
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

  it("fails conversion when the converted lead stage is not configured", async () => {
    pipelineMocks.getStageBySlug.mockImplementation(async (slug: string, workflowFamily?: string) => {
      if (workflowFamily !== "lead") return null;
      if (slug === "ready_for_opportunity") return readyForOpportunityStage;
      if (slug === "converted") return null;
      return null;
    });

    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Palm Villas repaint",
          stageId: readyForOpportunityStage.id,
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          directorReviewDecision: "go",
          directorReviewedAt: new Date("2026-04-14T15:00:00.000Z"),
          directorReviewedBy: "director-1",
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
      message: "Missing converted lead stage configuration",
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
        workflowRoute: "estimating",
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
          workflowRoute: "estimating",
        },
      ],
    });

    await expect(
      createDeal(tenantDb as never, {
        name: "Duplicate successor deal",
        stageId: "deal-stage-1",
        assignedRepId: "rep-1",
        sourceLeadId: "lead-1",
        workflowRoute: "estimating",
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
        workflowRoute: "estimating",
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
          workflowRoute: "estimating",
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
          workflowRoute: "estimating",
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
          workflowRoute: "estimating",
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
          workflowRoute: "estimating",
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
          workflowRoute: "estimating",
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
  it("exposes a dedicated routing review route", async () => {
    const { dealRoutes } = await loadDealRoutesWithServiceMocks();

    expect(() => findDealRouteHandler(dealRoutes, "post", "/:id/routing-review")).not.toThrow();
  });

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

  it("preserves migrationMode on public deal-update requests", async () => {
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
        migrationMode: true,
      }),
      "director",
      "director-1",
      "office-1"
    );
  });
});
