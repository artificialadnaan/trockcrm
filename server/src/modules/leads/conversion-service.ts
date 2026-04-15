import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals, leads } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { WorkflowRoute } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { createDeal } from "../deals/service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface ConvertLeadInput {
  leadId: string;
  dealStageId: string;
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
  now: () => Date;
}

const defaultDependencies: LeadConversionDependencies = {
  createDeal,
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

    if (lead.status === "converted") {
      throw new AppError(409, "Lead has already been converted");
    }

    const [existingDeal] = await tenantDb
      .select()
      .from(deals)
      .where(eq(deals.sourceLeadId, input.leadId))
      .limit(1);

    if (existingDeal) {
      throw new AppError(409, "Lead has already been converted");
    }

    const deal = await deps.createDeal(tenantDb, {
      name: input.name ?? lead.name,
      stageId: input.dealStageId,
      workflowRoute: input.workflowRoute ?? "estimating",
      assignedRepId: input.assignedRepId ?? lead.assignedRepId,
      officeId: input.officeId,
      primaryContactId:
        input.primaryContactId === undefined
          ? (lead.primaryContactId ?? undefined)
          : (input.primaryContactId ?? undefined),
      companyId: lead.companyId,
      propertyId: lead.propertyId,
      sourceLeadId: lead.id,
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
        status: "converted",
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
