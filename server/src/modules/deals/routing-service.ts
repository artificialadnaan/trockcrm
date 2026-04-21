import { and, asc, eq, ne } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  dealRoutingHistory,
  deals,
  pipelineStageConfig,
} from "@trock-crm/shared/schema";
import type {
  DealPipelineDisposition,
  DealRouteValueSource,
  WorkflowRoute,
} from "@trock-crm/shared/types";
import type * as schema from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { getStageBySlug } from "../pipeline/service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export function routeForAmount(amount: string | number): WorkflowRoute {
  const numericAmount = typeof amount === "number" ? amount : Number(amount);
  return numericAmount < 50000 ? "service" : "estimating";
}

async function resolveEntryStageForDisposition(
  disposition: Exclude<DealPipelineDisposition, "opportunity">
) {
  if (disposition === "deals") {
    const estimatingStage = await getStageBySlug("estimating", "standard_deal");
    if (estimatingStage) {
      return estimatingStage;
    }

    const [fallbackStandardStage] = await db
      .select()
      .from(pipelineStageConfig)
      .where(
        and(
          eq(pipelineStageConfig.workflowFamily, "standard_deal"),
          eq(pipelineStageConfig.isActivePipeline, true),
          ne(pipelineStageConfig.slug, "opportunity")
        )
      )
      .orderBy(asc(pipelineStageConfig.displayOrder))
      .limit(1);

    if (fallbackStandardStage) {
      return fallbackStandardStage;
    }
  }

  const [serviceStage] = await db
    .select()
    .from(pipelineStageConfig)
    .where(
      and(
        eq(pipelineStageConfig.workflowFamily, "service_deal"),
        eq(pipelineStageConfig.isActivePipeline, true)
      )
    )
    .orderBy(asc(pipelineStageConfig.displayOrder))
    .limit(1);

  if (serviceStage) {
    return serviceStage;
  }

  throw new AppError(400, `No active entry stage configured for ${disposition} deals`);
}

export async function applyOpportunityRoutingReview(
  tenantDb: TenantDb,
  input: {
    dealId: string;
    valueSource: DealRouteValueSource;
    amount: string;
    userId: string;
    reason?: string;
  }
) {
  const [deal] = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, input.dealId))
    .limit(1)
    .for("update");

  if (!deal) {
    throw new AppError(404, "Deal not found");
  }

  const nextRoute = routeForAmount(input.amount);
  const nextDisposition: Exclude<DealPipelineDisposition, "opportunity"> =
    nextRoute === "service" ? "service" : "deals";

  if (
    deal.workflowRoute === nextRoute &&
    deal.pipelineDisposition === nextDisposition
  ) {
    return { deal, changed: false };
  }

  const nextStage = await resolveEntryStageForDisposition(nextDisposition);
  const [updatedDeal] = await tenantDb
    .update(deals)
    .set({
      pipelineDisposition: nextDisposition,
      workflowRoute: nextRoute,
      stageId: nextStage.id,
      updatedAt: new Date(),
    })
    .where(eq(deals.id, deal.id))
    .returning();

  await tenantDb.insert(dealRoutingHistory).values({
    dealId: deal.id,
    fromWorkflowRoute: deal.workflowRoute,
    toWorkflowRoute: nextRoute,
    valueSource: input.valueSource,
    triggeringValue: input.amount,
    reason: input.reason ?? null,
    changedBy: input.userId,
    createdAt: new Date(),
  });

  return { deal: updatedDeal, changed: true };
}
