import { and, asc, desc, eq, ilike, inArray, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  CANONICAL_LEAD_STAGE_SLUGS,
  companies,
  contacts,
  deals,
  leadStageHistory,
  leads,
  projectTypeConfig,
  properties,
  userOfficeAccess,
  users,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { toCanonicalLeadStageSlug, type WorkflowFamily } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { getActiveProjectTypes, getStageById } from "../pipeline/service.js";
import { assertLeadStageTransitionAllowed } from "./stage-transition-service.js";

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
  status?: "open" | "disqualified";
}

interface LeadServiceDependencies {
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
  getStageById,
  getActiveProjectTypes,
  now: () => new Date(),
};

const CANONICAL_LEAD_STAGE_INDEX = new Map(
  CANONICAL_LEAD_STAGE_SLUGS.map((stageSlug, index) => [stageSlug, index] as const)
);

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

    if (!stage.slug) {
      throw new AppError(500, "Target lead stage config is incomplete");
    }

    assertLeadStartsInEntryStage(stage.slug);

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

      const projectType = await resolveProjectType(effectiveProjectTypeId ?? null, deps.getActiveProjectTypes);
      assertLeadStageTransitionAllowed({
        lead: {
          id: existing.id,
          stageId: existing.stageId,
          stageSlug: normalizeStageSlugForTransitionValidation(currentStage.slug),
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
          slug: normalizeStageSlugForTransitionValidation(currentStage.slug),
          name: currentStage.name,
          isTerminal: currentStage.isTerminal,
          displayOrder: currentStage.displayOrder,
        },
        targetStage: {
          id: stage.id,
          slug: normalizeStageSlugForTransitionValidation(stage.slug),
          name: stage.name,
          isTerminal: stage.isTerminal,
          displayOrder: stage.displayOrder,
        },
        projectTypeSlug: projectType?.slug ?? null,
      });

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
    if (input.qualificationPayload !== undefined) {
      updates.qualificationPayload = normalizeQualificationPayload(input.qualificationPayload);
    }
    if (input.projectTypeQuestionPayload !== undefined || input.projectTypeId !== undefined) {
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

    updates.updatedAt = stageChangedAt ?? deps.now();

    const [lead] = await tenantDb
      .update(leads)
      .set(updates)
      .where(eq(leads.id, leadId))
      .returning();

    if (stageChangeAuditRecord) {
      await tenantDb.insert(leadStageHistory).values(stageChangeAuditRecord);
    }

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
