import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  companies,
  contacts,
  deals,
  leadStageHistory,
  leads,
  projectTypeConfig,
  pipelineStageConfig,
  properties,
  userOfficeAccess,
  users,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { WorkflowFamily } from "@trock-crm/shared/types";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { getActiveProjectTypes, getAllStages, getStageById } from "../pipeline/service.js";
import { assertLeadStageTransitionAllowed } from "./stage-transition-service.js";
import { createAssignmentTaskIfNeeded } from "../assignment-tasks/service.js";
import { createNotification } from "../notifications/service.js";
import { createTask } from "../tasks/service.js";
import {
  type LeadQualificationPatch,
  upsertLeadQualification,
} from "./qualification-service.js";
import { validateLeadStageGate } from "./stage-gate.js";

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
  actorUserId: string;
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
  qualificationScope?: string | null;
  qualificationBudgetAmount?: string | null;
  qualificationCompanyFit?: boolean | null;
  qualificationCompletedAt?: Date | null;
  directorReviewDecision?: "go" | "no_go" | null;
  directorReviewReason?: string | null;
  status?: "open" | "disqualified";
  decisionMakerName?: string | null;
  decisionProcess?: string | null;
  budgetStatus?: string | null;
  incumbentVendor?: string | null;
  unitCount?: number | null;
  buildYear?: number | null;
  forecastWindow?: "30_days" | "60_days" | "90_days" | "beyond_90" | "uncommitted" | null;
  forecastCategory?: "commit" | "best_case" | "pipeline" | null;
  forecastConfidencePercent?: number | null;
  forecastRevenue?: string | null;
  forecastGrossProfit?: string | null;
  forecastBlockers?: string | null;
  nextStep?: string | null;
  nextStepDueAt?: string | null;
  nextMilestoneAt?: string | null;
  supportNeededType?: "leadership" | "estimating" | "operations" | "executive_team" | null;
  supportNeededNotes?: string | null;
  estimatedOpportunityValue?: string | null;
  goDecision?: "go" | "no_go" | null;
  goDecisionNotes?: string | null;
  qualificationData?: Record<string, unknown>;
  scopingSubsetData?: Record<string, unknown>;
  disqualificationReason?: string | null;
  disqualificationNotes?: string | null;
}

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

interface LeadServiceDependencies {
  getAllStages: (workflowFamily?: WorkflowFamily) => Promise<Array<{
    id: string;
    slug: string;
    displayOrder: number;
    isTerminal: boolean;
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
  createApprovalNotification: typeof createNotification;
  createApprovalTask: typeof createTask;
}

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

const defaultDependencies: LeadServiceDependencies = {
  getAllStages,
  getStageById,
  getActiveProjectTypes,
  now: () => new Date(),
  createApprovalNotification: createNotification,
  createApprovalTask: createTask,
};

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

const QUALIFIED_LEAD_REQUIREMENTS = [
  "source",
  "projectTypeId",
  "qualificationPayload.existing_customer_status",
] as const;

const REQUIREMENT_METADATA: Record<string, { label: string; resolution: "inline" | "detail" }> = {
  property: { label: "Linked property", resolution: "detail" },
  source: { label: "Lead source", resolution: "inline" },
  projectTypeId: { label: "Project type", resolution: "detail" },
  "qualificationPayload.existing_customer_status": {
    label: "Existing customer status",
    resolution: "inline",
  },
  qualificationScope: { label: "Project scope / category", resolution: "inline" },
  qualificationBudgetAmount: { label: "Approximate budget / dollar amount", resolution: "inline" },
  qualificationCompanyFit: { label: "Company fit / serviceability confirmation", resolution: "inline" },
  directorReviewDecision: { label: "Director decision", resolution: "inline" },
};

function isBlank(value: unknown) {
  return value === null || value === undefined || (typeof value === "string" && value.trim().length === 0);
}

function isDirectorOrAdmin(role: string | null | undefined) {
  return role === "director" || role === "admin";
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

function resolveCanonicalLeadBoardStageSlug(stageSlug: string | null | undefined): CanonicalLeadBoardStageSlug | null {
  if (!stageSlug) {
    return null;
  }

  if (NEW_LEAD_BOARD_STAGE_SLUGS.includes(stageSlug as (typeof NEW_LEAD_BOARD_STAGE_SLUGS)[number])) {
    return "new_lead";
  }

  if (
    QUALIFIED_LEAD_BOARD_STAGE_SLUGS.includes(
      stageSlug as (typeof QUALIFIED_LEAD_BOARD_STAGE_SLUGS)[number]
    )
  ) {
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

function groupLeadBoardColumns(stages: Awaited<ReturnType<typeof listLeadStages>>, rows: LeadStageRow[]) {
  return stages
    .map((stage) => {
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

export async function listLeadBoard(tenantDb: TenantDb, input: LeadBoardInput) {
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

export async function listLeadStagePage(tenantDb: TenantDb, input: LeadStagePageInput) {
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
    select
      count(*)::int as total
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
      totalPages: Math.ceil(total / pageSize),
    },
    rows: (rowResult.rows as LeadStageRow[]).map(mapLeadStageRow),
  };
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

  return rows.map((lead) => ({
    ...lead,
    companyName: companyMap.get(lead.companyId) ?? null,
    property: propertyMap.get(lead.propertyId) ?? null,
    projectType: lead.projectTypeId ? projectTypeMap.get(lead.projectTypeId) ?? null : null,
    convertedDealId: convertedDealMap.get(lead.id)?.id ?? null,
    convertedDealNumber: convertedDealMap.get(lead.id)?.dealNumber ?? null,
  }));
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

async function listLeadApprovalRecipients(tenantDb: TenantDb, officeId: string) {
  const [userRows, accessRows] = await Promise.all([
    tenantDb.select().from(users),
    tenantDb.select().from(userOfficeAccess),
  ]);

  const officeAccessIds = new Set(
    accessRows
      .filter((access) => access.officeId === officeId && isDirectorOrAdmin(access.roleOverride))
      .map((access) => access.userId)
  );

  return userRows.filter((user) => {
    if (user.isActive !== true || !isDirectorOrAdmin((user as { role?: string | null }).role ?? null)) {
      return false;
    }

    return user.officeId === officeId || officeAccessIds.has(user.id);
  });
}

async function createLeadGoNoGoApprovalRequests(
  tenantDb: TenantDb,
  input: {
    leadId: string;
    leadName: string;
    officeId?: string;
    actorUserId: string;
  },
  deps: LeadServiceDependencies
) {
  if (!input.officeId) {
    return;
  }

  const recipients = (await listLeadApprovalRecipients(tenantDb, input.officeId)).filter(
    (recipient) => recipient.id !== input.actorUserId
  );

  await Promise.all(
    recipients.map(async (recipient) => {
      await deps.createApprovalTask(tenantDb, {
        title: `Approve lead go/no-go: ${input.leadName}`,
        description: "Lead reached Go/No-Go and needs director/admin approval before opportunity conversion.",
        type: "approval_request",
        priority: "high",
        assignedTo: recipient.id,
        createdBy: input.actorUserId,
      });

      await deps.createApprovalNotification(tenantDb, {
        userId: recipient.id,
        type: "approval_needed",
        title: "Lead Go/No-Go Approval Needed",
        body: `${input.leadName} reached Lead Go/No-Go and is waiting for director/admin approval.`,
        link: `/leads/${input.leadId}`,
        recipientEmail: recipient.email ?? undefined,
      });
    })
  );
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

    await validateLeadHierarchy(tenantDb, input);
    await validateAssignee(tenantDb, input.assignedRepId, input.officeId);
    await resolveProjectType(input.projectTypeId ?? null, deps.getActiveProjectTypes);

    const now = deps.now();
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
        qualificationPayload: normalizeQualificationPayload(input.qualificationPayload),
        projectTypeQuestionPayload: normalizeProjectTypeQuestionPayload(
          input.projectTypeId ?? null,
          input.projectTypeQuestionPayload
        ),
        stageEnteredAt: now,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await createAssignmentTaskIfNeeded(tenantDb, {
      entityType: "lead",
      entityId: lead.id,
      entityName: lead.name,
      previousAssignedRepId: null,
      nextAssignedRepId: input.assignedRepId,
      actorUserId: input.actorUserId,
      officeId: input.officeId ?? null,
    });

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

    const updates: Record<string, unknown> = {};
    const effectiveProjectTypeId =
      input.projectTypeId !== undefined ? input.projectTypeId : existing.projectTypeId;
    const qualificationPatch: LeadQualificationPatch = {};
    let hasQualificationPatch = false;

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

      const projectType = await resolveProjectType(effectiveProjectTypeId ?? null, deps.getActiveProjectTypes);
      assertLeadStageTransitionAllowed({
        lead: {
          id: existing.id,
          stageId: existing.stageId,
          stageSlug: currentStage.slug,
          source: input.source !== undefined ? input.source : existing.source,
          projectTypeId: effectiveProjectTypeId ?? null,
          qualificationPayload:
            input.qualificationPayload !== undefined
              ? normalizeQualificationPayload(input.qualificationPayload)
              : normalizeQualificationPayload(
                  existing.qualificationPayload as Record<string, string | boolean | number | null>
                ),
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
        currentStage: {
          id: currentStage.id,
          slug: currentStage.slug,
          name: currentStage.name,
          isTerminal: currentStage.isTerminal,
          displayOrder: currentStage.displayOrder,
        },
        targetStage: {
          id: stage.id,
          slug: stage.slug,
          name: stage.name,
          isTerminal: stage.isTerminal,
          displayOrder: stage.displayOrder,
        },
        projectTypeSlug: projectType?.slug ?? null,
      });
      updates.stageId = input.stageId;
      updates.stageEnteredAt = deps.now();
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
    if (input.qualificationPayload !== undefined) {
      updates.qualificationPayload = normalizeQualificationPayload(input.qualificationPayload);
    }
    if (input.projectTypeQuestionPayload !== undefined || input.projectTypeId !== undefined) {
      updates.projectTypeQuestionPayload = normalizeProjectTypeQuestionPayload(
        effectiveProjectTypeId ?? null,
        input.projectTypeQuestionPayload
      );
    }
    if (input.decisionMakerName !== undefined) updates.decisionMakerName = input.decisionMakerName;
    if (input.decisionProcess !== undefined) updates.decisionProcess = input.decisionProcess;
    if (input.budgetStatus !== undefined) updates.budgetStatus = input.budgetStatus;
    if (input.incumbentVendor !== undefined) updates.incumbentVendor = input.incumbentVendor;
    if (input.unitCount !== undefined) updates.unitCount = input.unitCount;
    if (input.buildYear !== undefined) updates.buildYear = input.buildYear;
    if (input.forecastWindow !== undefined) updates.forecastWindow = input.forecastWindow;
    if (input.forecastCategory !== undefined) updates.forecastCategory = input.forecastCategory;
    if (input.forecastConfidencePercent !== undefined) {
      updates.forecastConfidencePercent = input.forecastConfidencePercent;
    }
    if (input.forecastRevenue !== undefined) updates.forecastRevenue = input.forecastRevenue;
    if (input.forecastGrossProfit !== undefined) updates.forecastGrossProfit = input.forecastGrossProfit;
    if (input.forecastBlockers !== undefined) updates.forecastBlockers = input.forecastBlockers;
    if (input.nextStep !== undefined) updates.nextStep = input.nextStep;
    if (input.nextStepDueAt !== undefined) {
      updates.nextStepDueAt = input.nextStepDueAt ? new Date(input.nextStepDueAt) : null;
    }
    if (input.nextMilestoneAt !== undefined) {
      updates.nextMilestoneAt = input.nextMilestoneAt ? new Date(input.nextMilestoneAt) : null;
    }
    if (input.supportNeededType !== undefined) updates.supportNeededType = input.supportNeededType;
    if (input.supportNeededNotes !== undefined) updates.supportNeededNotes = input.supportNeededNotes;
    if (input.qualificationScope !== undefined) updates.qualificationScope = input.qualificationScope;
    if (input.qualificationBudgetAmount !== undefined) updates.qualificationBudgetAmount = input.qualificationBudgetAmount;
    if (input.qualificationCompanyFit !== undefined) updates.qualificationCompanyFit = input.qualificationCompanyFit;
    if (input.qualificationCompletedAt !== undefined) updates.qualificationCompletedAt = input.qualificationCompletedAt;
    if (input.directorReviewDecision !== undefined) {
      if (userRole === "rep") {
        throw new AppError(403, "Only directors can record go/no-go decisions");
      }
      updates.directorReviewDecision = input.directorReviewDecision;
      if (input.directorReviewDecision === "no_go" && isBlank(input.directorReviewReason)) {
        throw new AppError(400, "No-go decisions require a reason");
      }
      updates.directorReviewedAt = deps.now();
      updates.directorReviewedBy = userId;
    }
    if (input.directorReviewReason !== undefined) updates.directorReviewReason = input.directorReviewReason;

    if (input.estimatedOpportunityValue !== undefined) {
      qualificationPatch.estimatedOpportunityValue = input.estimatedOpportunityValue;
      hasQualificationPatch = true;
    }
    if (input.goDecision !== undefined) {
      if (!isDirectorOrAdmin(userRole)) {
        throw new AppError(403, "Only directors and admins can approve lead go/no-go decisions");
      }
      qualificationPatch.goDecision = input.goDecision;
      hasQualificationPatch = true;
    }
    if (input.goDecisionNotes !== undefined) {
      if (!isDirectorOrAdmin(userRole)) {
        throw new AppError(403, "Only directors and admins can approve lead go/no-go decisions");
      }
      qualificationPatch.goDecisionNotes = input.goDecisionNotes;
      hasQualificationPatch = true;
    }
    if (input.qualificationData !== undefined) {
      qualificationPatch.qualificationData = input.qualificationData;
      hasQualificationPatch = true;
    }
    if (input.scopingSubsetData !== undefined) {
      qualificationPatch.scopingSubsetData = input.scopingSubsetData;
      hasQualificationPatch = true;
    }
    if (input.disqualificationReason !== undefined) {
      qualificationPatch.disqualificationReason = input.disqualificationReason;
      hasQualificationPatch = true;
    }
    if (input.disqualificationNotes !== undefined) {
      qualificationPatch.disqualificationNotes = input.disqualificationNotes;
      hasQualificationPatch = true;
    }

    if (input.status !== undefined) {
      if (input.status === "open" || input.status === "disqualified") {
        updates.status = input.status;
        updates.isActive = input.status === "open";
      } else {
        throw new AppError(400, "Use the conversion endpoint to convert a lead");
      }
    }

    if (Object.keys(updates).length === 0 && !hasQualificationPatch) {
      return existing;
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = deps.now();
    }

    if (hasQualificationPatch) {
      await upsertLeadQualification(tenantDb, leadId, qualificationPatch);
    }

    if (Object.keys(updates).length === 0) {
      return existing;
    }

    if (
      input.forecastWindow !== undefined ||
      input.forecastCategory !== undefined ||
      input.forecastConfidencePercent !== undefined ||
      input.forecastRevenue !== undefined ||
      input.forecastGrossProfit !== undefined ||
      input.forecastBlockers !== undefined ||
      input.nextMilestoneAt !== undefined
    ) {
      updates.forecastUpdatedAt = deps.now();
      updates.forecastUpdatedBy = userId;
    }

    const previousStageId = existing.stageId;
    const [lead] = await tenantDb.update(leads).set(updates).where(eq(leads.id, leadId)).returning();

    if (
      input.assignedRepId !== undefined &&
      input.assignedRepId !== existing.assignedRepId
    ) {
      await createAssignmentTaskIfNeeded(tenantDb, {
        entityType: "lead",
        entityId: lead.id,
        entityName: lead.name,
        previousAssignedRepId: existing.assignedRepId,
        nextAssignedRepId: input.assignedRepId,
        actorUserId: userId,
        officeId: input.officeId ?? null,
      });
    }

    if (input.stageId !== undefined && input.stageId !== previousStageId) {
      const targetStage = await deps.getStageById(input.stageId, "lead");
      if (targetStage?.slug === "lead_go_no_go") {
        await createLeadGoNoGoApprovalRequests(
          tenantDb,
          {
            leadId: lead.id,
            leadName: lead.name,
            officeId: input.officeId,
            actorUserId: userId,
          },
          deps
        );
      }
    }

    return lead;
  }

  async function transitionLeadStage(
    tenantDb: TenantDb,
    input: TransitionLeadStageInput
  ): Promise<TransitionBlockedResult | TransitionSuccessResult> {
    const existing = await getLeadById(tenantDb, input.leadId, input.userRole, input.userId);
    if (!existing) {
      throw new AppError(404, "Lead not found");
    }

    if (input.userRole === "rep" && existing.assignedRepId !== input.userId) {
      throw new AppError(403, "You can only edit your own leads");
    }

    const currentStage = await deps.getStageById(existing.stageId, "lead");
    const targetStage = await deps.getStageById(input.targetStageId, "lead");

    if (!currentStage || !targetStage) {
      throw new AppError(400, "Invalid lead stage ID");
    }

    const orderedLeadStages = await deps.getAllStages("lead");
    const stageIndexById = new Map(orderedLeadStages.map((stage, index) => [stage.id, index]));
    const currentStageIndex = stageIndexById.get(currentStage.id);
    const targetStageIndex = stageIndexById.get(targetStage.id);

    if (currentStageIndex === undefined || targetStageIndex === undefined) {
      throw new AppError(400, "Invalid lead stage ID");
    }

    if (targetStageIndex !== currentStageIndex + 1) {
      throw new AppError(400, "Lead stages must advance one step at a time");
    }

    if (targetStage.slug === "qualified_for_opportunity" && !isDirectorOrAdmin(input.userRole)) {
      return {
        ok: false,
        reason: "missing_requirements",
        targetStageId: input.targetStageId,
        resolution: "detail",
        missing: [
          {
            key: "approval.directorAdmin",
            label: "Director/Admin Approval Required",
            resolution: "detail",
          },
        ],
      };
    }

    const effectiveLead = {
      ...existing,
      ...input.inlinePatch,
    };

    if (input.inlinePatch?.directorReviewDecision !== undefined && input.userRole === "rep") {
      throw new AppError(403, "Only directors can record go/no-go decisions");
    }

    if (effectiveLead.directorReviewDecision === "no_go" && isBlank(effectiveLead.directorReviewReason)) {
      throw new AppError(400, "No-go decisions require a reason");
    }

    const legacyMissing: string[] = [];

    if (targetStage.slug === "qualified_lead") {
      const qualificationPayload = normalizeQualificationPayload(
        input.inlinePatch?.qualificationPayload !== undefined
          ? input.inlinePatch.qualificationPayload
          : (existing.qualificationPayload as Record<string, string | boolean | number | null> | undefined)
      );

      for (const requirement of QUALIFIED_LEAD_REQUIREMENTS) {
        if (requirement === "qualificationPayload.existing_customer_status") {
          if (isBlank(qualificationPayload.existing_customer_status)) {
            legacyMissing.push("qualificationPayload.existing_customer_status");
          }
          continue;
        }

        if (isBlank(effectiveLead[requirement])) legacyMissing.push(requirement);
      }
    }

    if (targetStage.slug === "ready_for_opportunity" && effectiveLead.directorReviewDecision !== "go") {
      legacyMissing.push("directorReviewDecision");
    }

    if (legacyMissing.length > 0) {
      return {
        ok: false,
        reason: "missing_requirements",
        targetStageId: input.targetStageId,
        resolution: "inline",
        missing: legacyMissing.map((key) => ({
          key,
          label: REQUIREMENT_METADATA[key]?.label ?? key,
          resolution: REQUIREMENT_METADATA[key]?.resolution ?? "inline",
        })),
      };
    }

    const preflight = await validateLeadStageGate(
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
            resolution: field.key.startsWith("leadScoping.") ? "detail" : "detail",
          })),
      };
    }

    const now = deps.now();
    const updates: Record<string, unknown> = { updatedAt: now };

    if (input.inlinePatch?.source !== undefined) updates.source = input.inlinePatch.source;
    if (input.inlinePatch?.description !== undefined) updates.description = input.inlinePatch.description;
    if (input.inlinePatch?.qualificationScope !== undefined) updates.qualificationScope = input.inlinePatch.qualificationScope;
    if (input.inlinePatch?.qualificationBudgetAmount !== undefined) {
      updates.qualificationBudgetAmount = input.inlinePatch.qualificationBudgetAmount;
    }
    if (input.inlinePatch?.qualificationCompanyFit !== undefined) {
      updates.qualificationCompanyFit = input.inlinePatch.qualificationCompanyFit;
    }
    if (input.inlinePatch?.directorReviewDecision !== undefined) {
      updates.directorReviewDecision = input.inlinePatch.directorReviewDecision;
      updates.directorReviewedAt = now;
      updates.directorReviewedBy = input.userId;
    }
    if (input.inlinePatch?.directorReviewReason !== undefined) {
      updates.directorReviewReason = input.inlinePatch.directorReviewReason;
    }

    if (targetStage.slug === "qualified_lead") {
      updates.qualificationCompletedAt = now;
    }

    if (targetStage.slug === "ready_for_opportunity") {
      if (!updates.directorReviewedAt) updates.directorReviewedAt = now;
      if (!updates.directorReviewedBy) updates.directorReviewedBy = input.userId;
    }

    updates.stageId = input.targetStageId;
    updates.stageEnteredAt = now;

    await tenantDb.insert(leadStageHistory).values({
      leadId: input.leadId,
      fromStageId: existing.stageId,
      toStageId: input.targetStageId,
      changedBy: input.userId,
      isBackwardMove: false,
      durationInPreviousStage: null,
      createdAt: now,
    });

    await tenantDb.update(leads).set(updates).where(eq(leads.id, input.leadId));
    const lead = await getLeadById(tenantDb, input.leadId, input.userRole, input.userId);
    if (!lead) {
      throw new AppError(404, "Lead not found after transition");
    }

    if (targetStage.slug === "lead_go_no_go") {
      await createLeadGoNoGoApprovalRequests(
        tenantDb,
        {
          leadId: String(lead.id),
          leadName: String(lead.name),
          officeId: input.officeId,
          actorUserId: input.userId,
        },
        deps
      );
    }

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
    createLead,
    updateLead,
    transitionLeadStage,
    deleteLead,
  };
}

const liveService = createLeadService();

export const getLeadById = liveService.getLeadById;
export const listLeads = liveService.listLeads;
export const createLead = liveService.createLead;
export const updateLead = liveService.updateLead;
export const transitionLeadStage = liveService.transitionLeadStage;
export const deleteLead = liveService.deleteLead;
