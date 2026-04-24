import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, leads } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { toCanonicalLeadStageSlug, type WorkflowRoute } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { createDeal } from "../deals/service.js";
import { getStageById, getStageBySlug } from "../pipeline/service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface ConvertLeadInput {
  leadId: string;
  dealStageId?: string;
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
  getStageById: typeof getStageById;
  getStageBySlug: typeof getStageBySlug;
  now: () => Date;
}

const defaultDependencies: LeadConversionDependencies = {
  createDeal,
  getStageById,
  getStageBySlug,
  now: () => new Date(),
};

function workflowFamilyForRoute(workflowRoute: WorkflowRoute) {
  return workflowRoute === "service" ? "service_deal" : "standard_deal";
}

function resolveWorkflowRoute(lead: typeof leads.$inferSelect): WorkflowRoute {
  const preQualValue =
    typeof lead.preQualValue === "number"
      ? lead.preQualValue
      : typeof lead.preQualValue === "string"
        ? Number(lead.preQualValue)
        : Number.NaN;

  if (Number.isFinite(preQualValue)) {
    return preQualValue < 50000 ? "service" : "normal";
  }

  return lead.pipelineType === "service" ? "service" : "normal";
}

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

    const workflowRoute = resolveWorkflowRoute(lead);
    if (input.workflowRoute && input.workflowRoute !== workflowRoute) {
      throw new AppError(
        409,
        "workflowRoute does not match the lead's derived downstream route",
        "LEAD_CONVERSION_ROUTE_MISMATCH"
      );
    }

    const currentLeadStage = await deps.getStageById(lead.stageId, "lead");
    if (!currentLeadStage?.slug) {
      throw new AppError(500, "Current lead stage config is incomplete");
    }

    const currentCanonicalStageSlug = toCanonicalLeadStageSlug(currentLeadStage.slug);
    if (!currentCanonicalStageSlug) {
      throw new AppError(
        409,
        "Lead cannot be converted from a non-canonical stage",
        "LEAD_CONVERSION_STAGE_INVALID"
      );
    }

    if (currentCanonicalStageSlug !== "sales_validation" && currentCanonicalStageSlug !== "opportunity") {
      throw new AppError(
        409,
        "Only Sales Validation leads can be converted to deals. Move the lead through the canonical progression first.",
        "LEAD_CONVERSION_REQUIRES_SALES_VALIDATION"
      );
    }

    const resolvedDealStageId =
      input.dealStageId ??
      (
        await deps.getStageBySlug("opportunity", workflowFamilyForRoute(workflowRoute))
      )?.id;

    if (!resolvedDealStageId) {
      throw new AppError(500, "Canonical opportunity stage config is incomplete");
    }

    const deal = await deps.createDeal(tenantDb, {
      name: input.name ?? lead.name,
      stageId: resolvedDealStageId,
      workflowRoute,
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

    const [updatedLead] = await tenantDb
      .update(leads)
      .set({
        stageId: lead.stageId,
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
