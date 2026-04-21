import { and, asc, desc, eq, ilike, inArray, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  companies,
  contacts,
  deals,
  leadStageHistory,
  leads,
  properties,
  userOfficeAccess,
  users,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { WorkflowFamily } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { getStageById } from "../pipeline/service.js";
import { createAssignmentTaskIfNeeded } from "../assignment-tasks/service.js";

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
}

export interface UpdateLeadInput {
  stageId?: string;
  assignedRepId?: string;
  officeId?: string;
  primaryContactId?: string | null;
  name?: string;
  source?: string | null;
  description?: string | null;
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
  getStageById: (id: string, workflowFamily?: WorkflowFamily) => Promise<{
    id: string;
    slug: string;
    displayOrder: number;
    isTerminal: boolean;
  } | null>;
  now: () => Date;
}

const defaultDependencies: LeadServiceDependencies = {
  getStageById,
  now: () => new Date(),
};

const QUALIFIED_LEAD_REQUIREMENTS = [
  "property",
  "source",
  "qualificationScope",
  "qualificationBudgetAmount",
  "qualificationCompanyFit",
] as const;

const REQUIREMENT_METADATA: Record<string, { label: string; resolution: "inline" | "detail" }> = {
  property: { label: "Linked property", resolution: "detail" },
  source: { label: "Lead source", resolution: "inline" },
  qualificationScope: { label: "Project scope / category", resolution: "inline" },
  qualificationBudgetAmount: { label: "Approximate budget / dollar amount", resolution: "inline" },
  qualificationCompanyFit: { label: "Company fit / serviceability confirmation", resolution: "inline" },
  directorReviewDecision: { label: "Director decision", resolution: "inline" },
};

function isBlank(value: unknown) {
  return value === null || value === undefined || (typeof value === "string" && value.trim().length === 0);
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
    const nextAssignedRepId =
      input.assignedRepId !== undefined ? input.assignedRepId : existing.assignedRepId;

    if (input.stageId !== undefined) {
      throw new AppError(400, "Use the lead stage transition endpoint to move a lead");
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

    updates.updatedAt = deps.now();

    const [lead] = await tenantDb
      .update(leads)
      .set(updates)
      .where(eq(leads.id, leadId))
      .returning();

    if (
      input.assignedRepId !== undefined &&
      input.assignedRepId !== existing.assignedRepId
    ) {
      await createAssignmentTaskIfNeeded(tenantDb, {
        entityType: "lead",
        entityId: lead.id,
        entityName: lead.name,
        previousAssignedRepId: existing.assignedRepId,
        nextAssignedRepId,
        actorUserId: userId,
        officeId: input.officeId ?? null,
      });
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

    if (targetStage.displayOrder !== currentStage.displayOrder + 1) {
      throw new AppError(400, "Lead stages must advance one step at a time");
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

    const missing: string[] = [];

    if (targetStage.slug === "qualified_lead") {
      for (const requirement of QUALIFIED_LEAD_REQUIREMENTS) {
        if (requirement === "property") {
          if (!existing.propertyId || !existing.property) missing.push("property");
          continue;
        }

        if (requirement === "qualificationCompanyFit") {
          if (effectiveLead.qualificationCompanyFit !== true) missing.push("qualificationCompanyFit");
          continue;
        }

        if (isBlank(effectiveLead[requirement])) missing.push(requirement);
      }
    }

    if (targetStage.slug === "ready_for_opportunity" && effectiveLead.directorReviewDecision !== "go") {
      missing.push("directorReviewDecision");
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

    if (missing.length > 0) {
      if (Object.keys(updates).length > 1) {
        await tenantDb.update(leads).set(updates).where(eq(leads.id, input.leadId));
      }

      return {
        ok: false,
        reason: "missing_requirements",
        targetStageId: input.targetStageId,
        resolution: "inline",
        missing: missing.map((key) => ({
          key,
          label: REQUIREMENT_METADATA[key]?.label ?? key,
          resolution: REQUIREMENT_METADATA[key]?.resolution ?? "inline",
        })),
      };
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
