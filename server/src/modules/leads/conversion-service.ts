import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, leadStageHistory, leads } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { WorkflowRoute } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { createDeal } from "../deals/service.js";
import { getStageBySlug } from "../pipeline/service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface ConvertLeadInput {
  leadId: string;
  dealStageId: string;
  userId: string;
  userRole: string;
  workflowRoute?: WorkflowRoute;
  assignedRepId?: string;
  primaryContactId?: string | null;
  officeId?: string;
  name?: string;
  source?: string;
  description?: string;
  ddEstimate?: string;
  bidEstimate?: string;
  awardedAmount?: string;
  projectTypeId?: string;
  regionId?: string;
  expectedCloseDate?: string;
}

interface LeadConversionDependencies {
  createDeal: typeof createDeal;
  getStageBySlug: typeof getStageBySlug;
  now: () => Date;
}

const defaultDependencies: LeadConversionDependencies = {
  createDeal,
  getStageBySlug,
  now: () => new Date(),
};

export function createLeadConversionService(
  dependencies: Partial<LeadConversionDependencies> = {}
) {
  const deps = { ...defaultDependencies, ...dependencies };

  async function convertLead(tenantDb: TenantDb, input: ConvertLeadInput) {
    const leadRowResult = await tenantDb
      .select()
      .from(leads)
      .where(eq(leads.id, input.leadId))
      .for("update")
      .limit(1);

    const lead = leadRowResult[0] ?? null;
    if (!lead) {
      throw new AppError(404, "Lead not found");
    }

    if (input.userRole === "rep" && lead.assignedRepId !== input.userId) {
      throw new AppError(403, "You can only convert your own leads");
    }

    if (lead.status === "converted") {
      throw new AppError(409, "Lead has already been converted");
    }

    if (lead.status === "disqualified") {
      throw new AppError(400, "Disqualified leads cannot be converted");
    }

    if (!lead.isActive) {
      throw new AppError(400, "Inactive leads cannot be converted");
    }

    const [existingDeal] = await tenantDb
      .select()
      .from(deals)
      .where(eq(deals.sourceLeadId, input.leadId))
      .limit(1);

    if (existingDeal) {
      throw new AppError(409, "Lead has already been converted");
    }

    const successorAssignedRepId = input.assignedRepId ?? lead.assignedRepId;
    if (input.userRole === "rep" && successorAssignedRepId !== lead.assignedRepId) {
      throw new AppError(403, "You cannot reassign the successor deal");
    }

    const convertedStage = await deps.getStageBySlug("converted", "lead");
    if (!convertedStage) {
      throw new AppError(500, "Missing converted lead stage configuration");
    }

    const transitionedToConvertedStage = convertedStage.id !== lead.stageId;

    const deal = await deps.createDeal(tenantDb, {
      name: input.name ?? lead.name,
      stageId: input.dealStageId,
      workflowRoute: input.workflowRoute ?? "estimating",
      assignedRepId: successorAssignedRepId,
      officeId: input.officeId,
      primaryContactId:
        input.primaryContactId === undefined
          ? (lead.primaryContactId ?? undefined)
          : (input.primaryContactId ?? undefined),
      companyId: lead.companyId,
      propertyId: lead.propertyId,
      sourceLeadId: lead.id,
      sourceLeadWriteMode: "lead_conversion",
      source: input.source ?? lead.source ?? undefined,
      description: input.description ?? lead.description ?? undefined,
      ddEstimate: input.ddEstimate,
      bidEstimate: input.bidEstimate,
      awardedAmount: input.awardedAmount,
      projectTypeId: input.projectTypeId,
      regionId: input.regionId,
      expectedCloseDate: input.expectedCloseDate,
    });

    const convertedAt = deps.now();

    if (transitionedToConvertedStage) {
      await tenantDb.insert(leadStageHistory).values({
        leadId: lead.id,
        fromStageId: lead.stageId,
        toStageId: convertedStage.id,
        changedBy: input.userId,
        isBackwardMove: false,
        durationInPreviousStage: null,
        createdAt: convertedAt,
      });
    }

    const [updatedLead] = await tenantDb
      .update(leads)
      .set({
        stageId: transitionedToConvertedStage ? convertedStage.id : lead.stageId,
        status: "converted",
        stageEnteredAt: convertedAt,
        convertedAt,
        isActive: false,
        updatedAt: convertedAt,
      })
      .where(eq(leads.id, input.leadId))
      .returning();

    return {
      lead: updatedLead ?? {
        ...lead,
        status: "converted",
        convertedAt,
        isActive: false,
        updatedAt: convertedAt,
      },
      deal,
    };
  }

  return {
    convertLead,
  };
}

const liveService = createLeadConversionService();

export const convertLead = liveService.convertLead;
