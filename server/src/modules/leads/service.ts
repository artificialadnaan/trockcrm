import { and, asc, desc, eq, ilike, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  companies,
  contacts,
  leads,
  properties,
  userOfficeAccess,
  users,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { WorkflowFamily } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { getStageById } from "../pipeline/service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface LeadFilters {
  search?: string;
  companyId?: string;
  propertyId?: string;
  assignedRepId?: string;
  status?: "open" | "converted" | "disqualified";
  isActive?: boolean;
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

const defaultDependencies: LeadServiceDependencies = {
  getStageById,
  now: () => new Date(),
};

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

    return lead;
  }

  async function listLeads(
    tenantDb: TenantDb,
    filters: LeadFilters,
    userRole: string,
    userId: string
  ) {
    const conditions: any[] = [];

    conditions.push(eq(leads.isActive, filters.isActive ?? true));

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

    return tenantDb
      .select()
      .from(leads)
      .where(and(...conditions))
      .orderBy(desc(leads.updatedAt), asc(leads.name));
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
