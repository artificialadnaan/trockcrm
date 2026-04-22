import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimatePricingRecommendations,
  estimateReviewEvents,
} from "@trock-crm/shared/schema";
import { getHistoricalPricingSignals } from "./historical-pricing-service.js";
import { buildEstimatingWorkbenchState } from "./workbench-service.js";

type TenantDb = NodePgDatabase<typeof schema>;
type AppDb = NodePgDatabase<typeof schema>;

export async function getEstimatingWorkflowState(
  tenantDb: TenantDb,
  dealId: string,
  options: { appDb?: AppDb | null; officeId?: string | null } = {}
) {
  return buildEstimatingWorkbenchState(tenantDb, dealId, options);
}

export async function listEstimateReviewEvents(tenantDb: TenantDb, dealId: string) {
  return tenantDb
    .select()
    .from(estimateReviewEvents)
    .where(eq(estimateReviewEvents.dealId, dealId))
    .orderBy(desc(estimateReviewEvents.createdAt));
}

export async function buildEstimatingCopilotContext(input: {
  tenantDb: TenantDb;
  appDb: AppDb;
  dealId: string;
  officeId?: string | null;
  question: string;
}) {
  const workflowState = await buildEstimatingWorkbenchState(input.tenantDb, input.dealId, {
    appDb: input.appDb,
    officeId: input.officeId ?? null,
  });
  const historicalSignals = await getHistoricalPricingSignals(input.tenantDb, input.dealId);
  const [pricingRecommendation] = await input.tenantDb
    .select()
    .from(estimatePricingRecommendations)
    .where(eq(estimatePricingRecommendations.dealId, input.dealId))
    .orderBy(desc(estimatePricingRecommendations.createdAt))
    .limit(1);

  return {
    workflowState,
    historicalComparables: historicalSignals.historicalItems,
    wonBidPatterns: historicalSignals.wonBidPatterns,
    pricingRecommendation,
  };
}

function summarizeWonBidPatterns(patterns: Array<{ projectType?: string; region?: string; marginBand?: string }>) {
  if (patterns.length === 0) return "No historical win-pattern evidence is available yet.";
  const first = patterns[0];
  return `Most comparable wins cluster around ${first.projectType ?? "mixed scope"} work in ${first.region ?? "mixed regions"} with ${first.marginBand ?? "mixed"} margins.`;
}

function collectRiskEvidence(context: Record<string, any>) {
  return Object.keys(context).map((key) => ({ type: key, id: key }));
}

function summarizeEstimateRiskAndAssumptions(context: Record<string, any>) {
  const recommendation = context.pricingRecommendation;
  if (!recommendation) return "No pricing recommendation is available yet.";
  return `Current draft recommendation is based on ${recommendation.priceBasis ?? "available evidence"} with estimator review still required.`;
}

export async function answerEstimatingCopilotQuestion(input: {
  question: string;
  context: {
    wonBidPatterns?: any[];
    pricingRecommendation?: any;
    historicalComparables?: any[];
  };
}) {
  if (/historically won|won bids|win patterns/i.test(input.question)) {
    return {
      answer: summarizeWonBidPatterns(input.context.wonBidPatterns ?? []),
      evidence: (input.context.wonBidPatterns ?? []).map((row: any) => ({
        type: "won_bid_pattern",
        id: row.id,
      })),
    };
  }

  if (/line item|price/i.test(input.question)) {
    return {
      answer: `Recommended unit price: ${input.context.pricingRecommendation?.recommendedUnitPrice}`,
      evidence: [
        {
          type: "pricing_recommendation",
          id: input.context.pricingRecommendation?.id ?? "generated",
        },
        ...((input.context.historicalComparables ?? []).map((row: any) => ({
          type: "historical_line_item",
          id: row.id,
        }))),
      ],
    };
  }

  return {
    answer: summarizeEstimateRiskAndAssumptions(input.context),
    evidence: collectRiskEvidence(input.context),
  };
}
