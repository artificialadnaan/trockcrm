import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  CANONICAL_LEAD_STAGE_SLUGS,
  companies,
  contacts,
  deals,
  leadStageHistory,
  leadQuestionAnswers,
  leads,
  pipelineStageConfig,
  projectTypeConfig,
  properties,
  userOfficeAccess,
  users,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { toCanonicalLeadStageSlug, type WorkflowFamily } from "@trock-crm/shared/types";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { getActiveProjectTypes, getAllStages, getStageById } from "../pipeline/service.js";
import { assertLeadStageTransitionAllowed, LeadStageTransitionError } from "./stage-transition-service.js";
import { preflightLeadStageCheck } from "./stage-gate.js";
import {
  isAnsweredQuestionValue,
  isLeadEditV2Enabled,
  listLeadQuestionAnswers,
  listMissingRequiredQuestionKeys,
  listQuestionnaireNodes,
  upsertLeadQuestionAnswerSet,
} from "./questionnaire-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface LeadFilters {
  search?: string;
  companyId?: string;
  propertyId?: string;
  assignedRepId?: string;
  status?: "open" | "converted" | "disqualified";
  isActive?: boolean | "all";
}

export interface CreateLeadInput {
  companyId: string;
  propertyId: string;
  stageId: string;
  assignedRepId: string;
  officeId?: string;
  primaryContactId?: string;
  name: string;
  source?: string;
  description?: string;
  projectTypeId?: string | null;
  qualificationPayload?: Record<string, string | boolean | number | null>;
  projectTypeQuestionPayload?: {
    projectTypeId: string | null;
    answers: Record<string, string | boolean | number | null>;
  };
  leadQuestionAnswers?: Record<string, string | boolean | number | null>;
}

export interface UpdateLeadInput {
  stageId?: string;
  assignedRepId?: string;
  officeId?: string;
  primaryContactId?: string | null;
  name?: string;
  source?: string | null;
  description?: string | null;
  projectTypeId?: string | null;
  qualificationPayload?: Record<string, string | boolean | number | null>;
  projectTypeQuestionPayload?: {
    projectTypeId: string | null;
    answers: Record<string, string | boolean | number | null>;
  };
  leadQuestionAnswers?: Record<string, string | boolean | number | null>;
  status?: "open" | "disqualified";
}

interface LeadServiceDependencies {
  getAllStages: (workflowFamily?: WorkflowFamily) => Promise<Array<{
    id: string;
    slug: string;
    displayOrder: number;
    isTerminal: boolean;
    isActivePipeline?: boolean;
  }>>;
  getStageById: (id: string, workflowFamily?: WorkflowFamily) => Promise<{
    id: string;
    name?: string;
    slug?: string;
    displayOrder?: number;
    isTerminal: boolean;
  } | null>;
  getActiveProjectTypes: typeof getActiveProjectTypes;
  now: () => Date;
}

const defaultDependencies: LeadServiceDependencies = {
  getAllStages,
  getStageById,
  getActiveProjectTypes,
  now: () => new Date(),
};

const CANONICAL_LEAD_STAGE_INDEX = new Map(
  CANONICAL_LEAD_STAGE_SLUGS.map((stageSlug, index) => [stageSlug, index] as const)
);

interface TransitionLeadStageInput {
  leadId: string;
  targetStageId: string;
  userId: string;
  userRole: string;
  officeId?: string;
  inlinePatch?: Partial<UpdateLeadInput>;
}

type TransitionBlockedResult = {
  ok: false;
  reason: "missing_requirements";
  targetStageId: string;
  resolution: "inline" | "detail";
  missing: Array<{
    key: string;
    label: string;
    resolution: "inline" | "detail";
  }>;
};

type TransitionSuccessResult = {
  ok: true;
  lead: Record<string, unknown>;
};

type WorkspaceScope = "mine" | "team" | "all";

export interface LeadBoardInput {
  role: string;
  userId: string;
  activeOfficeId: string;
  scope: WorkspaceScope;
  previewLimit?: number;
}

export interface LeadStagePageInput extends LeadBoardInput {
  stageId: string;
  page: number;
  pageSize: number;
  search?: string;
  sort?: string;
  assignedRepId?: string;
  staleOnly?: boolean;
  status?: string;
  workflowRoute?: string;
  source?: string;
}

type LeadStageRow = {
  id: string;
  name: string;
  stage_id: string;
  stage_slug: string | null;
  assigned_rep_id: string;
  office_id: string;
  company_name: string | null;
  property_city: string | null;
  property_state: string | null;
  source: string | null;
  status: string;
  last_activity_at: string | null;
  stage_entered_at: string;
  updated_at: string;
};

const NEW_LEAD_BOARD_STAGE_SLUGS = [
  "contacted",
  "lead_new",
  "company_pre_qualified",
  "scoping_in_progress",
  "new_lead",
] as const;

const QUALIFIED_LEAD_BOARD_STAGE_SLUGS = [
  "qualified_lead",
  "pre_qual_value_assigned",
  "director_go_no_go",
] as const;

const SALES_VALIDATION_BOARD_STAGE_SLUGS = [
  "lead_go_no_go",
  "qualified_for_opportunity",
  "ready_for_opportunity",
  "sales_validation_stage",
] as const;

const CANONICAL_LEAD_BOARD_STAGE_SLUGS = [
  "new_lead",
  "qualified_lead",
  "sales_validation_stage",
] as const;

type CanonicalLeadBoardStageSlug = (typeof CANONICAL_LEAD_BOARD_STAGE_SLUGS)[number];

async function resolveProjectType(
  projectTypeId: string | null | undefined,
  getProjectTypes: typeof getActiveProjectTypes
) {
  if (!projectTypeId) {
    return null;
  }

  const projectTypes = await getProjectTypes();
  const projectType = projectTypes.find((entry) => entry.id === projectTypeId) ?? null;

  if (!projectType) {
    throw new AppError(400, "Project type not found");
  }

  return projectType;
}

function normalizeQualificationPayload(
  payload: Record<string, string | boolean | number | null> | undefined
) {
  return payload ?? {};
}

function normalizeProjectTypeQuestionPayload(
  projectTypeId: string | null,
  payload:
    | {
        projectTypeId: string | null;
        answers: Record<string, string | boolean | number | null>;
      }
    | undefined
) {
  return {
    projectTypeId,
    answers: payload?.answers ?? {},
  };
}

function coerceExistingQuestionPayload(value: unknown, projectTypeId: string | null) {
  const payload = value as { projectTypeId?: string | null; answers?: Record<string, string | boolean | number | null> } | null;

  return {
    projectTypeId: payload?.projectTypeId ?? projectTypeId,
    answers: payload?.answers ?? {},
  };
}

function normalizeStageSlugForTransitionValidation(stageSlug: string) {
  const canonicalStageSlug = toCanonicalLeadStageSlug(stageSlug);
  if (canonicalStageSlug === "sales_validation") {
    return "sales_validation_stage";
  }

  return canonicalStageSlug ?? stageSlug;
}

function assertCanonicalLeadProgression(
  currentStageSlug: string,
  targetStageSlug: string
) {
  const targetCanonicalStageSlug = toCanonicalLeadStageSlug(targetStageSlug);
  if (!targetCanonicalStageSlug) {
    return;
  }

  const currentCanonicalStageSlug = toCanonicalLeadStageSlug(currentStageSlug);
  if (!currentCanonicalStageSlug) {
    return;
  }

  const currentStageIndex = CANONICAL_LEAD_STAGE_INDEX.get(currentCanonicalStageSlug);
  const targetStageIndex = CANONICAL_LEAD_STAGE_INDEX.get(targetCanonicalStageSlug);
  if (currentStageIndex === undefined || targetStageIndex === undefined) {
    throw new AppError(
      409,
      "Lead stage is not part of the canonical workflow",
      "LEAD_STAGE_INVALID"
    );
  }

  if (targetStageIndex > currentStageIndex + 1) {
    throw new AppError(
      409,
      "Lead stage progression must move one canonical stage at a time",
      "LEAD_STAGE_PROGRESSION_GAP"
    );
  }
}

function assertLeadStartsInEntryStage(stageSlug: string) {
  const canonicalStageSlug = toCanonicalLeadStageSlug(stageSlug);
  if (canonicalStageSlug && canonicalStageSlug !== "new_lead") {
    throw new AppError(
      400,
      "New leads must start in the New Lead stage",
      "LEAD_CREATION_REQUIRES_ENTRY_STAGE"
    );
  }
}

async function decorateLeads(
  tenantDb: TenantDb,
  rows: Array<typeof leads.$inferSelect>
) {
  if (rows.length === 0) {
    return [];
  }

  const companyIds = [...new Set(rows.map((lead) => lead.companyId).filter(Boolean))];
  const propertyIds = [...new Set(rows.map((lead) => lead.propertyId).filter(Boolean))];
  const projectTypeIds = [...new Set(rows.map((lead) => lead.projectTypeId).filter(Boolean))];
  const leadIds = rows.map((lead) => lead.id);

  const [companyRows, propertyRows, projectTypeRows, convertedDealRows] = await Promise.all([
    companyIds.length === 0
      ? []
      : tenantDb
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(inArray(companies.id, companyIds)),
    propertyIds.length === 0
      ? []
      : tenantDb
          .select({
            id: properties.id,
            name: properties.name,
            address: properties.address,
            city: properties.city,
            state: properties.state,
            zip: properties.zip,
          })
          .from(properties)
          .where(inArray(properties.id, propertyIds)),
    projectTypeIds.length === 0
      ? []
      : tenantDb
          .select({
            id: projectTypeConfig.id,
            name: projectTypeConfig.name,
            slug: projectTypeConfig.slug,
          })
          .from(projectTypeConfig)
          .where(inArray(projectTypeConfig.id, projectTypeIds as string[])),
    tenantDb
      .select({
        sourceLeadId: deals.sourceLeadId,
        id: deals.id,
        dealNumber: deals.dealNumber,
      })
      .from(deals)
      .where(inArray(deals.sourceLeadId, leadIds)),
  ]);

  const companyMap = new Map(companyRows.map((company) => [company.id, company.name]));
  const propertyMap = new Map(propertyRows.map((property) => [property.id, property]));
  const projectTypeMap = new Map(projectTypeRows.map((projectType) => [projectType.id, projectType]));
  const convertedDealMap = new Map(
    convertedDealRows
      .filter((deal) => deal.sourceLeadId)
      .map((deal) => [deal.sourceLeadId as string, { id: deal.id, dealNumber: deal.dealNumber }])
  );

  const v2Enabled = isLeadEditV2Enabled();
  const leadQuestionAnswerRows =
    v2Enabled && leadIds.length > 0
      ? await tenantDb.select().from(leadQuestionAnswers)
      : [];
  const questionNodes =
    v2Enabled && leadQuestionAnswerRows.length > 0
      ? await tenantDb.select().from(projectTypeConfig)
      : [];
  void questionNodes;
  const answerRowsByLeadId = new Map<string, Array<(typeof leadQuestionAnswers.$inferSelect)>>();

  for (const row of leadQuestionAnswerRows) {
    const rowsForLead = answerRowsByLeadId.get(row.leadId) ?? [];
    rowsForLead.push(row);
    answerRowsByLeadId.set(row.leadId, rowsForLead);
  }

  return rows.map((lead) => ({
    ...lead,
    companyName: companyMap.get(lead.companyId) ?? null,
    property: propertyMap.get(lead.propertyId) ?? null,
    projectType: lead.projectTypeId ? projectTypeMap.get(lead.projectTypeId) ?? null : null,
    convertedDealId: convertedDealMap.get(lead.id)?.id ?? null,
    convertedDealNumber: convertedDealMap.get(lead.id)?.dealNumber ?? null,
    leadQuestionAnswers: v2Enabled
      ? Object.fromEntries(
          (answerRowsByLeadId.get(lead.id) ?? []).map((row) => [row.questionId, row.valueJson ?? null])
        )
      : undefined,
  }));
}

function createLeadQuestionGateError(input: {
  currentStage: {
    id: string;
    slug: string;
    name: string;
    isTerminal: boolean;
    displayOrder: number;
  };
  targetStage: {
    id: string;
    slug: string;
    name: string;
    isTerminal: boolean;
    displayOrder: number;
  };
  qualificationFields: string[];
  projectTypeQuestionIds: string[];
}) {
  return new LeadStageTransitionError({
    allowed: false,
    code: "LEAD_STAGE_REQUIREMENTS_UNMET",
    message:
      "Complete the Sales Validation qualification fields and required project questions before moving this lead forward.",
    currentStage: input.currentStage,
    targetStage: input.targetStage,
    missingRequirements: {
      prerequisiteFields: [],
      qualificationFields: input.qualificationFields,
      projectTypeQuestionIds: input.projectTypeQuestionIds,
    },
  });
}

async function assertLeadQuestionGateAllowed(
  tenantDb: TenantDb,
  input: {
    leadId: string;
    projectTypeId: string | null;
    qualificationPayload: Record<string, string | boolean | number | null>;
    leadQuestionAnswers: Record<string, string | boolean | number | null>;
    currentStage: {
      id: string;
      slug: string;
      name: string;
      isTerminal: boolean;
      displayOrder: number;
    };
    targetStage: {
      id: string;
      slug: string;
      name: string;
      isTerminal: boolean;
      displayOrder: number;
    };
  }
) {
  const currentStoredAnswers = await listLeadQuestionAnswers(tenantDb, input.leadId);
  const mergedAnswers = {
    ...currentStoredAnswers,
    ...input.leadQuestionAnswers,
  };
  const nodes = await listQuestionnaireNodes(tenantDb, input.projectTypeId);
  const qualificationFields = ["existing_customer_status", "estimated_value", "timeline_status"].filter(
    (fieldId) => !isAnsweredQuestionValue(input.qualificationPayload[fieldId])
  );
  const projectTypeQuestionIds = listMissingRequiredQuestionKeys(nodes, mergedAnswers);

  if (qualificationFields.length === 0 && projectTypeQuestionIds.length === 0) {
    return;
  }

  throw createLeadQuestionGateError({
    currentStage: input.currentStage,
    targetStage: input.targetStage,
    qualificationFields,
    projectTypeQuestionIds,
  });
}

async function validateAssignee(tenantDb: TenantDb, assigneeId: string, officeId?: string): Promise<void> {
  const [user] = await tenantDb
    .select()
    .from(users)
    .where(and(eq(users.id, assigneeId), eq(users.isActive, true)))
    .limit(1);

  if (!user) {
    throw new AppError(400, "Assigned user not found or inactive");
  }

  if (!officeId || user.officeId === officeId) {
    return;
  }

  const [access] = await tenantDb
    .select()
    .from(userOfficeAccess)
    .where(and(eq(userOfficeAccess.userId, assigneeId), eq(userOfficeAccess.officeId, officeId)))
    .limit(1);

  if (!access) {
    throw new AppError(400, "Assigned user does not have access to this office");
  }
}

async function validateLeadHierarchy(
  tenantDb: TenantDb,
  input: Pick<CreateLeadInput, "companyId" | "propertyId" | "primaryContactId">
) {
  const [company] = await tenantDb
    .select()
    .from(companies)
    .where(and(eq(companies.id, input.companyId), eq(companies.isActive, true)))
    .limit(1);

  if (!company) {
    throw new AppError(400, "Company not found");
  }

  const [property] = await tenantDb
    .select()
    .from(properties)
    .where(and(eq(properties.id, input.propertyId), eq(properties.isActive, true)))
    .limit(1);

  if (!property) {
    throw new AppError(400, "Property not found");
  }

  if (property.companyId !== input.companyId) {
    throw new AppError(400, "Property does not belong to the company");
  }

  await validatePrimaryContact(tenantDb, input.companyId, input.primaryContactId);
}

async function validatePrimaryContact(
  tenantDb: TenantDb,
  companyId: string,
  primaryContactId?: string | null
) {
  if (!primaryContactId) {
    return;
  }

  const [contact] = await tenantDb
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, primaryContactId), eq(contacts.isActive, true)))
    .limit(1);

  if (!contact) {
    throw new AppError(400, "Primary contact not found");
  }

  if (contact.companyId !== companyId) {
    throw new AppError(400, "Primary contact does not belong to the company");
  }
}

async function listLeadStages() {
  return db
    .select()
    .from(pipelineStageConfig)
    .where(
      and(
        eq(pipelineStageConfig.workflowFamily, "lead"),
        eq(pipelineStageConfig.isActivePipeline, true),
        inArray(pipelineStageConfig.slug, [...CANONICAL_LEAD_BOARD_STAGE_SLUGS])
      )
    )
    .orderBy(asc(pipelineStageConfig.displayOrder));
}

async function getDefaultConversionDealStageId() {
  const [stage] = await db
    .select({ id: pipelineStageConfig.id })
    .from(pipelineStageConfig)
    .where(
      and(
        eq(pipelineStageConfig.workflowFamily, "standard_deal"),
        eq(pipelineStageConfig.isActivePipeline, true)
      )
    )
    .orderBy(asc(pipelineStageConfig.displayOrder))
    .limit(1);

  return stage?.id ?? null;
}

function buildLeadWorkspaceScope(input: LeadBoardInput | LeadStagePageInput) {
  const filters = [
    sql`l.is_active = true`,
    sql`u.office_id = ${input.activeOfficeId}`,
  ];

  if (input.role === "rep" || input.scope === "mine") {
    filters.push(sql`l.assigned_rep_id = ${input.userId}`);
  }

  if ("assignedRepId" in input && input.assignedRepId) {
    filters.push(sql`l.assigned_rep_id = ${input.assignedRepId}`);
  }

  if ("status" in input && input.status) {
    filters.push(sql`l.status = ${input.status}`);
  } else {
    filters.push(sql`l.status = 'open'`);
  }

  if ("source" in input && input.source) {
    filters.push(sql`l.source = ${input.source}`);
  }

  if ("search" in input && input.search && input.search.trim().length >= 2) {
    const term = `%${input.search.trim()}%`;
    filters.push(sql`(l.name ilike ${term} or c.name ilike ${term} or p.city ilike ${term} or p.state ilike ${term})`);
  }

  if ("staleOnly" in input && input.staleOnly) {
    filters.push(sql`l.last_activity_at is null or l.last_activity_at < now() - interval '14 days'`);
  }

  return sql.join(filters, sql` and `);
}

function normalizeLeadStageSort(sort?: string) {
  switch (sort) {
    case "name_asc":
      return sql`l.name asc, l.updated_at desc`;
    case "age_desc":
      return sql`l.stage_entered_at asc, l.updated_at desc`;
    default:
      return sql`l.updated_at desc, l.name asc`;
  }
}

function mapLeadStageRow(row: LeadStageRow) {
  return {
    id: row.id,
    name: row.name,
    stageId: row.stage_id,
    assignedRepId: row.assigned_rep_id,
    officeId: row.office_id,
    companyName: row.company_name,
    propertyCity: row.property_city,
    propertyState: row.property_state,
    source: row.source,
    status: row.status,
    lastActivityAt: row.last_activity_at,
    stageEnteredAt: row.stage_entered_at,
    updatedAt: row.updated_at,
  };
}

function resolveCanonicalLeadBoardStageSlug(
  stageSlug: string | null | undefined
): CanonicalLeadBoardStageSlug | null {
  if (!stageSlug) {
    return null;
  }

  if (NEW_LEAD_BOARD_STAGE_SLUGS.includes(stageSlug as (typeof NEW_LEAD_BOARD_STAGE_SLUGS)[number])) {
    return "new_lead";
  }

  if (QUALIFIED_LEAD_BOARD_STAGE_SLUGS.includes(stageSlug as (typeof QUALIFIED_LEAD_BOARD_STAGE_SLUGS)[number])) {
    return "qualified_lead";
  }

  if (
    SALES_VALIDATION_BOARD_STAGE_SLUGS.includes(
      stageSlug as (typeof SALES_VALIDATION_BOARD_STAGE_SLUGS)[number]
    )
  ) {
    return "sales_validation_stage";
  }

  return null;
}

function listCanonicalBucketStageSlugs(canonicalStageSlug: string): readonly string[] {
  switch (canonicalStageSlug) {
    case "new_lead":
      return NEW_LEAD_BOARD_STAGE_SLUGS;
    case "qualified_lead":
      return QUALIFIED_LEAD_BOARD_STAGE_SLUGS;
    case "sales_validation_stage":
      return SALES_VALIDATION_BOARD_STAGE_SLUGS;
    default:
      return [canonicalStageSlug];
  }
}

function groupLeadBoardColumns(
  stages: Awaited<ReturnType<typeof listLeadStages>>,
  rows: LeadStageRow[]
) {
  return stages.map((stage) => {
    const cards = rows
      .filter((row) => resolveCanonicalLeadBoardStageSlug(row.stage_slug) === stage.slug)
      .map(mapLeadStageRow);

    return {
      stage,
      count: cards.length,
      cards,
    };
  });
}

async function listLeadBoardWorkspace(tenantDb: TenantDb, input: LeadBoardInput) {
  const previewLimit = Math.max(1, Math.min(12, input.previewLimit ?? 8));
  const [stages, defaultConversionDealStageId, rowResult] = await Promise.all([
    listLeadStages(),
    getDefaultConversionDealStageId(),
    tenantDb.execute(sql`
      select
        l.id,
        l.name,
        l.stage_id,
        psc.slug as stage_slug,
        l.assigned_rep_id,
        u.office_id,
        c.name as company_name,
        p.city as property_city,
        p.state as property_state,
        l.source,
        l.status,
        l.last_activity_at,
        l.stage_entered_at,
        l.updated_at
      from leads l
      join users u on u.id = l.assigned_rep_id
      join public.pipeline_stage_config psc on psc.id = l.stage_id
      left join companies c on c.id = l.company_id
      left join properties p on p.id = l.property_id
      where ${buildLeadWorkspaceScope(input)}
      order by l.stage_entered_at asc, l.updated_at desc
    `),
  ]);

  return {
    columns: groupLeadBoardColumns(stages, rowResult.rows as LeadStageRow[]).map((column) => ({
      ...column,
      cards: column.cards.slice(0, previewLimit),
    })),
    defaultConversionDealStageId,
  };
}

async function listLeadStageWorkspacePage(tenantDb: TenantDb, input: LeadStagePageInput) {
  const [stage] = await listLeadStages().then((stages) => stages.filter((item) => item.id === input.stageId));
  if (!stage) {
    throw new AppError(404, "Lead stage not found");
  }
  const bucketStageSlugs = listCanonicalBucketStageSlugs(stage.slug);

  const page = Math.max(1, input.page || 1);
  const pageSize = Math.max(1, Math.min(100, input.pageSize || 25));
  const offset = (page - 1) * pageSize;
  const scope = buildLeadWorkspaceScope(input);
  const countResult = await tenantDb.execute(sql`
    select count(*)::int as total
    from leads l
    join users u on u.id = l.assigned_rep_id
    join public.pipeline_stage_config psc on psc.id = l.stage_id
    left join companies c on c.id = l.company_id
    left join properties p on p.id = l.property_id
    where ${scope} and psc.slug in ${bucketStageSlugs}
  `);
  const rowResult = await tenantDb.execute(sql`
    select
      l.id,
      l.name,
      l.stage_id,
      psc.slug as stage_slug,
      l.assigned_rep_id,
      u.office_id,
      c.name as company_name,
      p.city as property_city,
      p.state as property_state,
      l.source,
      l.status,
      l.last_activity_at,
      l.stage_entered_at,
      l.updated_at
    from leads l
    join users u on u.id = l.assigned_rep_id
    join public.pipeline_stage_config psc on psc.id = l.stage_id
    left join companies c on c.id = l.company_id
    left join properties p on p.id = l.property_id
    where ${scope} and psc.slug in ${bucketStageSlugs}
    order by ${normalizeLeadStageSort(input.sort)}
    limit ${pageSize}
    offset ${offset}
  `);

  const total = Number((countResult.rows[0] as { total?: number | string } | undefined)?.total ?? 0);

  return {
    stage,
    scope: input.scope,
    summary: {
      count: total,
    },
    pagination: {
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 1 : Math.ceil(total / pageSize),
    },
    rows: (rowResult.rows as LeadStageRow[]).map(mapLeadStageRow),
  };
}

export function createLeadService(
  dependencies: Partial<LeadServiceDependencies> = {}
) {
  const deps = { ...defaultDependencies, ...dependencies };

  async function getLeadById(
    tenantDb: TenantDb,
    leadId: string,
    userRole: string,
    userId: string
  ) {
    const [lead] = await tenantDb.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) return null;

    if (userRole === "rep" && lead.assignedRepId !== userId) {
      throw new AppError(403, "You can only view your own leads");
    }

    return (await decorateLeads(tenantDb, [lead]))[0] ?? null;
  }

  async function listLeads(
    tenantDb: TenantDb,
    filters: LeadFilters,
    userRole: string,
    userId: string
  ) {
    const conditions: any[] = [];

    if (filters.isActive !== "all") {
      conditions.push(eq(leads.isActive, filters.isActive ?? true));
    }

    if (userRole === "rep") {
      conditions.push(eq(leads.assignedRepId, userId));
    } else if (filters.assignedRepId) {
      conditions.push(eq(leads.assignedRepId, filters.assignedRepId));
    }

    if (filters.companyId) conditions.push(eq(leads.companyId, filters.companyId));
    if (filters.propertyId) conditions.push(eq(leads.propertyId, filters.propertyId));
    if (filters.status) conditions.push(eq(leads.status, filters.status));

    if (filters.search && filters.search.trim().length >= 2) {
      const searchTerm = `%${filters.search.trim()}%`;
      conditions.push(
        or(
          ilike(leads.name, searchTerm),
          ilike(leads.source, searchTerm),
          ilike(leads.description, searchTerm)
        )
      );
    }

    const rows = await tenantDb
      .select()
      .from(leads)
      .where(and(...conditions))
      .orderBy(desc(leads.updatedAt), asc(leads.name));

    return decorateLeads(tenantDb, rows);
  }

  async function createLead(tenantDb: TenantDb, input: CreateLeadInput) {
    const stage = await deps.getStageById(input.stageId, "lead");
    if (!stage) {
      throw new AppError(400, "Invalid lead stage ID");
    }

    if (stage.isTerminal) {
      throw new AppError(400, "Cannot create a lead in a terminal stage");
    }

    if (!stage.slug) {
      throw new AppError(500, "Target lead stage config is incomplete");
    }

    assertLeadStartsInEntryStage(stage.slug);

    await validateLeadHierarchy(tenantDb, input);
    await validateAssignee(tenantDb, input.assignedRepId, input.officeId);
    await resolveProjectType(input.projectTypeId ?? null, deps.getActiveProjectTypes);

    const now = deps.now();
    const v2Enabled = isLeadEditV2Enabled();
    const normalizedQualificationPayload = normalizeQualificationPayload(input.qualificationPayload);
    const normalizedProjectTypeQuestionPayload = normalizeProjectTypeQuestionPayload(
      input.projectTypeId ?? null,
      input.projectTypeQuestionPayload
    );
    const leadQuestionAnswerInput =
      input.leadQuestionAnswers ??
      normalizedProjectTypeQuestionPayload.answers ??
      {};
    const [lead] = await tenantDb
      .insert(leads)
      .values({
        companyId: input.companyId,
        propertyId: input.propertyId,
        primaryContactId: input.primaryContactId ?? null,
        name: input.name,
        stageId: input.stageId,
        assignedRepId: input.assignedRepId,
        status: "open",
        source: input.source ?? null,
        description: input.description ?? null,
        projectTypeId: input.projectTypeId ?? null,
        qualificationPayload: normalizedQualificationPayload,
        projectTypeQuestionPayload: v2Enabled
          ? { projectTypeId: input.projectTypeId ?? null, answers: {} }
          : normalizedProjectTypeQuestionPayload,
        stageEnteredAt: now,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (v2Enabled && Object.keys(leadQuestionAnswerInput).length > 0) {
      await upsertLeadQuestionAnswerSet(tenantDb, {
        leadId: lead.id,
        projectTypeId: input.projectTypeId ?? null,
        changedBy: input.assignedRepId,
        answers: leadQuestionAnswerInput,
        changedAt: now,
      });
    }

    return lead;
  }

  async function updateLead(
    tenantDb: TenantDb,
    leadId: string,
    input: UpdateLeadInput,
    userRole: string,
    userId: string
  ) {
    const existing = await getLeadById(tenantDb, leadId, userRole, userId);
    if (!existing) {
      throw new AppError(404, "Lead not found");
    }

    if (userRole === "rep" && existing.assignedRepId !== userId) {
      throw new AppError(403, "You can only edit your own leads");
    }

    const v2Enabled = isLeadEditV2Enabled();
    const isConvertedLead = existing.status === "converted";

    if (!existing.isActive && !isConvertedLead) {
      throw new AppError(409, "Hidden lead records are read-only");
    }

    if (isConvertedLead) {
      const nonAnswerKeys = Object.keys(input).filter(
        (key) => key !== "leadQuestionAnswers" && key !== "officeId"
      );

      if (nonAnswerKeys.length > 0) {
        throw new AppError(409, "Converted leads only allow questionnaire answer updates");
      }

      if (v2Enabled && input.leadQuestionAnswers) {
        await upsertLeadQuestionAnswerSet(tenantDb, {
          leadId,
          projectTypeId: existing.projectTypeId ?? null,
          changedBy: userId,
          answers: input.leadQuestionAnswers,
          changedAt: deps.now(),
        });
      }

      return existing;
    }

    const updates: Record<string, unknown> = {};
    const effectiveProjectTypeId =
      input.projectTypeId !== undefined ? input.projectTypeId : existing.projectTypeId;
    let stageChangeAuditRecord:
      | {
          leadId: string;
          fromStageId: string | null;
          toStageId: string;
          changedBy: string;
          isBackwardMove: boolean;
          durationInPreviousStage: null;
          createdAt: Date;
        }
      | null = null;
    let stageChangedAt: Date | null = null;
    const effectiveQualificationPayload =
      input.qualificationPayload !== undefined
        ? normalizeQualificationPayload(input.qualificationPayload)
        : normalizeQualificationPayload(
            existing.qualificationPayload as Record<string, string | boolean | number | null>
          );
    const effectiveLeadQuestionAnswers = input.leadQuestionAnswers ?? {};

    if (input.stageId !== undefined) {
      const stage = await deps.getStageById(input.stageId, "lead");
      if (!stage) {
        throw new AppError(400, "Invalid lead stage ID");
      }

      const currentStage = await deps.getStageById(existing.stageId, "lead");
      if (!currentStage?.slug || currentStage.displayOrder == null || !currentStage.name) {
        throw new AppError(500, "Current lead stage config is incomplete");
      }
      if (!stage.slug || stage.displayOrder == null || !stage.name) {
        throw new AppError(500, "Target lead stage config is incomplete");
      }

      assertCanonicalLeadProgression(currentStage.slug, stage.slug);

      const currentStageInput = {
        id: currentStage.id,
        slug: normalizeStageSlugForTransitionValidation(currentStage.slug),
        name: currentStage.name,
        isTerminal: currentStage.isTerminal,
        displayOrder: currentStage.displayOrder,
      };
      const targetStageInput = {
        id: stage.id,
        slug: normalizeStageSlugForTransitionValidation(stage.slug),
        name: stage.name,
        isTerminal: stage.isTerminal,
        displayOrder: stage.displayOrder,
      };

      if (v2Enabled) {
        const enteringSalesValidation =
          stage.slug === "sales_validation_stage" && currentStage.slug !== "sales_validation_stage";
        const advancingBeyondSalesValidation =
          currentStage.slug === "sales_validation_stage" && stage.displayOrder > currentStage.displayOrder;

        if (enteringSalesValidation || advancingBeyondSalesValidation) {
          await assertLeadQuestionGateAllowed(tenantDb, {
            leadId: existing.id,
            projectTypeId: effectiveProjectTypeId ?? null,
            qualificationPayload: effectiveQualificationPayload,
            leadQuestionAnswers: effectiveLeadQuestionAnswers,
            currentStage: currentStageInput,
            targetStage: targetStageInput,
          });
        }
      } else {
        const projectType = await resolveProjectType(effectiveProjectTypeId ?? null, deps.getActiveProjectTypes);
        assertLeadStageTransitionAllowed({
          lead: {
            id: existing.id,
            stageId: existing.stageId,
            stageSlug: currentStage.slug,
            source: input.source !== undefined ? input.source : existing.source,
            projectTypeId: effectiveProjectTypeId ?? null,
            qualificationPayload: effectiveQualificationPayload,
            projectTypeQuestionPayload:
              input.projectTypeQuestionPayload !== undefined || input.projectTypeId !== undefined
                ? normalizeProjectTypeQuestionPayload(
                    effectiveProjectTypeId ?? null,
                    input.projectTypeQuestionPayload
                  )
                : coerceExistingQuestionPayload(
                  existing.projectTypeQuestionPayload,
                  effectiveProjectTypeId ?? null
                ),
          },
          currentStage: currentStageInput,
          targetStage: targetStageInput,
          projectTypeSlug: projectType?.slug ?? null,
        });
      }

      updates.stageId = input.stageId;
      stageChangedAt = deps.now();
      updates.stageEnteredAt = stageChangedAt;

      if (input.stageId !== existing.stageId) {
        stageChangeAuditRecord = {
          leadId: existing.id,
          fromStageId: existing.stageId,
          toStageId: input.stageId,
          changedBy: userId,
          isBackwardMove: stage.displayOrder < currentStage.displayOrder,
          durationInPreviousStage: null,
          createdAt: stageChangedAt,
        };
      }
    }

    if (input.assignedRepId !== undefined) {
      await validateAssignee(tenantDb, input.assignedRepId, input.officeId);
      updates.assignedRepId = input.assignedRepId;
    }

    if (input.primaryContactId !== undefined) {
      if (input.primaryContactId !== existing.primaryContactId) {
        await validatePrimaryContact(tenantDb, existing.companyId, input.primaryContactId);
      }
      updates.primaryContactId = input.primaryContactId;
    }

    if (input.projectTypeId !== undefined) {
      await resolveProjectType(input.projectTypeId, deps.getActiveProjectTypes);
      updates.projectTypeId = input.projectTypeId;
    }

    if (input.name !== undefined) updates.name = input.name;
    if (input.source !== undefined) updates.source = input.source;
    if (input.description !== undefined) updates.description = input.description;
    if (!v2Enabled && input.qualificationPayload !== undefined) {
      updates.qualificationPayload = normalizeQualificationPayload(input.qualificationPayload);
    }
    if (!v2Enabled && (input.projectTypeQuestionPayload !== undefined || input.projectTypeId !== undefined)) {
      updates.projectTypeQuestionPayload = normalizeProjectTypeQuestionPayload(
        effectiveProjectTypeId ?? null,
        input.projectTypeQuestionPayload
      );
    }

    if (input.status !== undefined) {
      if (input.status === "open" || input.status === "disqualified") {
        updates.status = input.status;
        updates.isActive = input.status === "open";
      } else {
        throw new AppError(400, "Use the conversion endpoint to convert a lead");
      }
    }

    if (Object.keys(updates).length === 0) {
      return existing;
    }

    const updateTime = stageChangedAt ?? deps.now();
    updates.updatedAt = updateTime;

    const [lead] = await tenantDb
      .update(leads)
      .set(updates)
      .where(eq(leads.id, leadId))
      .returning();

    if (stageChangeAuditRecord) {
      await tenantDb.insert(leadStageHistory).values(stageChangeAuditRecord);
    }

    if (v2Enabled && input.leadQuestionAnswers && Object.keys(input.leadQuestionAnswers).length > 0) {
      await upsertLeadQuestionAnswerSet(tenantDb, {
        leadId,
        projectTypeId: effectiveProjectTypeId ?? null,
        changedBy: userId,
        answers: input.leadQuestionAnswers,
        changedAt: updateTime,
      });
    }

    return lead;
  }

  async function transitionLeadStage(
    tenantDb: TenantDb,
    input: TransitionLeadStageInput
  ): Promise<TransitionBlockedResult | TransitionSuccessResult> {
    const preflight = await preflightLeadStageCheck(
      tenantDb,
      input.leadId,
      input.targetStageId,
      input.userRole,
      input.userId
    );

    if (!preflight.allowed) {
      return {
        ok: false,
        reason: "missing_requirements",
        targetStageId: input.targetStageId,
        resolution: "detail",
        missing: preflight.missingRequirements.effectiveChecklist.fields
          .filter((field) => !field.satisfied)
          .map((field) => ({
            key: field.key,
            label: field.label,
            resolution: field.key.startsWith("leadScoping.") ? "detail" : "inline",
          })),
      };
    }

    const lead = await updateLead(
      tenantDb,
      input.leadId,
      {
        ...(input.inlinePatch ?? {}),
        stageId: input.targetStageId,
        officeId: input.officeId,
      },
      input.userRole,
      input.userId
    );

    return { ok: true, lead };
  }

  async function deleteLead(
    tenantDb: TenantDb,
    leadId: string,
    userRole: string,
    userId: string
  ) {
    const existing = await getLeadById(tenantDb, leadId, userRole, userId);
    if (!existing) {
      throw new AppError(404, "Lead not found");
    }

    const [lead] = await tenantDb
      .update(leads)
      .set({ isActive: false, updatedAt: deps.now() })
      .where(eq(leads.id, leadId))
      .returning();

    return lead;
  }

  return {
    getLeadById,
    listLeads,
    listLeadBoard: listLeadBoardWorkspace,
    listLeadStagePage: listLeadStageWorkspacePage,
    createLead,
    updateLead,
    transitionLeadStage,
    deleteLead,
  };
}

const liveService = createLeadService();

export const getLeadById = liveService.getLeadById;
export const listLeads = liveService.listLeads;
export const listLeadBoard = liveService.listLeadBoard;
export const listLeadStagePage = liveService.listLeadStagePage;
export const createLead = liveService.createLead;
export const updateLead = liveService.updateLead;
export const transitionLeadStage = liveService.transitionLeadStage;
export const deleteLead = liveService.deleteLead;
