import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  companies,
  contacts,
  deals,
  leads,
  pipelineStageConfig,
  properties,
  userOfficeAccess,
  users,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { WorkflowFamily } from "@trock-crm/shared/types";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { getStageById } from "../pipeline/service.js";

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
}

export interface UpdateLeadInput {
  stageId?: string;
  assignedRepId?: string;
  officeId?: string;
  primaryContactId?: string | null;
  name?: string;
  source?: string | null;
  description?: string | null;
  status?: "open" | "disqualified";
}

interface LeadServiceDependencies {
  getStageById: (id: string, workflowFamily?: WorkflowFamily) => Promise<{
    id: string;
    isTerminal: boolean;
  } | null>;
  now: () => Date;
}

type WorkspaceScope = "mine" | "team" | "all";

export interface LeadBoardInput {
  role: string;
  userId: string;
  activeOfficeId: string;
  scope: WorkspaceScope;
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

const defaultDependencies: LeadServiceDependencies = {
  getStageById,
  now: () => new Date(),
};

async function listLeadStages() {
  return db
    .select()
    .from(pipelineStageConfig)
    .where(eq(pipelineStageConfig.workflowFamily, "lead"))
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

function groupLeadBoardColumns(stages: Awaited<ReturnType<typeof listLeadStages>>, rows: LeadStageRow[]) {
  return stages
    .filter((stage) => !stage.isTerminal)
    .map((stage) => {
      const cards = rows
        .filter((row) => row.stage_id === stage.id)
        .map(mapLeadStageRow);

      return {
        stage,
        count: cards.length,
        cards,
      };
    });
}

export async function listLeadBoard(tenantDb: TenantDb, input: LeadBoardInput) {
  const [stages, defaultConversionDealStageId, rowResult] = await Promise.all([
    listLeadStages(),
    getDefaultConversionDealStageId(),
    tenantDb.execute(sql`
      select
        l.id,
        l.name,
        l.stage_id,
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
      left join companies c on c.id = l.company_id
      left join properties p on p.id = l.property_id
      where ${buildLeadWorkspaceScope(input)}
      order by l.stage_entered_at asc, l.updated_at desc
    `),
  ]);

  return {
    columns: groupLeadBoardColumns(stages, rowResult.rows as LeadStageRow[]),
    defaultConversionDealStageId,
  };
}

export async function listLeadStagePage(tenantDb: TenantDb, input: LeadStagePageInput) {
  const [stage] = await listLeadStages().then((stages) => stages.filter((item) => item.id === input.stageId));
  if (!stage) {
    throw new AppError(404, "Lead stage not found");
  }

  const page = Math.max(1, input.page || 1);
  const pageSize = Math.max(1, Math.min(100, input.pageSize || 25));
  const offset = (page - 1) * pageSize;
  const scope = buildLeadWorkspaceScope(input);
  const countResult = await tenantDb.execute(sql`
    select
      count(*)::int as total
    from leads l
    join users u on u.id = l.assigned_rep_id
    left join companies c on c.id = l.company_id
    left join properties p on p.id = l.property_id
    where ${scope} and l.stage_id = ${input.stageId}
  `);
  const rowResult = await tenantDb.execute(sql`
    select
      l.id,
      l.name,
      l.stage_id,
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
    left join companies c on c.id = l.company_id
    left join properties p on p.id = l.property_id
    where ${scope} and l.stage_id = ${input.stageId}
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
  const leadIds = rows.map((lead) => lead.id);

  const [companyRows, propertyRows, convertedDealRows] = await Promise.all([
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
  const convertedDealMap = new Map(
    convertedDealRows
      .filter((deal) => deal.sourceLeadId)
      .map((deal) => [deal.sourceLeadId as string, { id: deal.id, dealNumber: deal.dealNumber }])
  );

  return rows.map((lead) => ({
    ...lead,
    companyName: companyMap.get(lead.companyId) ?? null,
    property: propertyMap.get(lead.propertyId) ?? null,
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
        stageEnteredAt: now,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

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

    if (input.stageId !== undefined) {
      const stage = await deps.getStageById(input.stageId, "lead");
      if (!stage) {
        throw new AppError(400, "Invalid lead stage ID");
      }
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

    if (input.name !== undefined) updates.name = input.name;
    if (input.source !== undefined) updates.source = input.source;
    if (input.description !== undefined) updates.description = input.description;

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

    updates.updatedAt = deps.now();

    const [lead] = await tenantDb
      .update(leads)
      .set(updates)
      .where(eq(leads.id, leadId))
      .returning();

    return lead;
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
    deleteLead,
  };
}

const liveService = createLeadService();

export const getLeadById = liveService.getLeadById;
export const listLeads = liveService.listLeads;
export const createLead = liveService.createLead;
export const updateLead = liveService.updateLead;
export const deleteLead = liveService.deleteLead;
