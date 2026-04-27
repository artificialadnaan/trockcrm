import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  deals,
  leadQuestionAnswers,
  leads,
  projectTypeQuestionNodes,
  properties,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { WorkflowRoute } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type DealFieldOwnership =
  | "lead"
  | "lead_questionnaire"
  | "deal"
  | "deal_scoping";

export type ResolvedDealField =
  | "projectTypeId"
  | "sourceCategory"
  | "sourceDetail"
  | "propertyId"
  | "propertyName"
  | "propertyAddress"
  | "propertyCity"
  | "propertyState"
  | "propertyZip"
  | "primaryContactId"
  | "assignedRepId"
  | "workflowRoute"
  | "description"
  | "bidDueDate"
  | "preBidMeetingCompleted"
  | "siteVisitDecision"
  | "siteVisitCompleted"
  | "estimatorConsultationNotes";

export const DEAL_FIELD_OWNERSHIP: Record<ResolvedDealField, DealFieldOwnership> = {
  projectTypeId: "lead",
  sourceCategory: "lead",
  sourceDetail: "lead",
  propertyId: "lead",
  propertyName: "lead",
  propertyAddress: "lead",
  propertyCity: "lead",
  propertyState: "lead",
  propertyZip: "lead",
  primaryContactId: "lead",
  assignedRepId: "lead",
  workflowRoute: "lead",
  description: "lead",
  bidDueDate: "lead_questionnaire",
  preBidMeetingCompleted: "deal_scoping",
  siteVisitDecision: "deal_scoping",
  siteVisitCompleted: "deal_scoping",
  estimatorConsultationNotes: "deal_scoping",
};

export type DealWriteTarget =
  | "source_lead"
  | "source_lead_questionnaire"
  | "deal"
  | "deal_scoping";

export interface DealFieldWritePlan {
  field: ResolvedDealField;
  ownership: DealFieldOwnership;
  target: DealWriteTarget;
  compatibilityWriteThrough: boolean;
}

export interface ResolvedDealView {
  deal: typeof deals.$inferSelect;
  sourceLead: typeof leads.$inferSelect | null;
  property: typeof properties.$inferSelect | null;
  answersByKey: Record<string, unknown>;
  resolved: {
    projectTypeId: string | null;
    sourceCategory: string | null;
    sourceDetail: string | null;
    legacySource: string | null;
    propertyId: string | null;
    propertyName: string | null;
    propertyAddress: string | null;
    propertyCity: string | null;
    propertyState: string | null;
    propertyZip: string | null;
    primaryContactId: string | null;
    assignedRepId: string | null;
    workflowRoute: WorkflowRoute;
    description: string | null;
    bidDueDate: unknown;
  };
  ownership: typeof DEAL_FIELD_OWNERSHIP;
}

const DEAL_COMPATIBILITY_SNAPSHOT_FIELDS = new Set<ResolvedDealField>([
  "projectTypeId",
  "propertyId",
  "propertyName",
  "propertyAddress",
  "propertyCity",
  "propertyState",
  "propertyZip",
  "primaryContactId",
  "assignedRepId",
  "workflowRoute",
  "description",
]);

function workflowRouteFromLeadPipeline(pipelineType: string | null | undefined): WorkflowRoute | null {
  if (pipelineType === "service") {
    return "service";
  }
  if (pipelineType === "normal") {
    return "normal";
  }
  return null;
}

function getAnswerValue(answersByKey: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(answersByKey, key) ? answersByKey[key] : null;
}

export function planDealFieldWrite(input: {
  field: ResolvedDealField;
  hasSourceLead: boolean;
}): DealFieldWritePlan {
  const ownership = DEAL_FIELD_OWNERSHIP[input.field];
  if (!ownership) {
    throw new AppError(400, `Unsupported resolved deal field: ${input.field}`);
  }

  if (ownership === "deal_scoping") {
    return {
      field: input.field,
      ownership,
      target: "deal_scoping",
      compatibilityWriteThrough: false,
    };
  }

  if (!input.hasSourceLead) {
    return {
      field: input.field,
      ownership,
      target: "deal",
      compatibilityWriteThrough: false,
    };
  }

  if (ownership === "lead_questionnaire") {
    return {
      field: input.field,
      ownership,
      target: "source_lead_questionnaire",
      compatibilityWriteThrough: false,
    };
  }

  return {
    field: input.field,
    ownership,
    target: "source_lead",
    compatibilityWriteThrough: DEAL_COMPATIBILITY_SNAPSHOT_FIELDS.has(input.field),
  };
}

async function getQuestionAnswersByKey(tenantDb: TenantDb, leadId: string) {
  const rows = await tenantDb
    .select({
      key: projectTypeQuestionNodes.key,
      valueJson: leadQuestionAnswers.valueJson,
    })
    .from(leadQuestionAnswers)
    .innerJoin(
      projectTypeQuestionNodes,
      eq(leadQuestionAnswers.questionId, projectTypeQuestionNodes.id)
    )
    .where(eq(leadQuestionAnswers.leadId, leadId));

  return Object.fromEntries(rows.map((row) => [row.key, row.valueJson]));
}

export async function getResolvedDeal(
  tenantDb: TenantDb,
  dealId: string
): Promise<ResolvedDealView> {
  const [deal] = await tenantDb.select().from(deals).where(eq(deals.id, dealId)).limit(1);
  if (!deal) {
    throw new AppError(404, "Deal not found");
  }

  const [sourceLead] = deal.sourceLeadId
    ? await tenantDb.select().from(leads).where(eq(leads.id, deal.sourceLeadId)).limit(1)
    : [null];

  const propertyId = sourceLead?.propertyId ?? deal.propertyId ?? null;
  const [property] = propertyId
    ? await tenantDb.select().from(properties).where(eq(properties.id, propertyId)).limit(1)
    : [null];

  const answersByKey = sourceLead ? await getQuestionAnswersByKey(tenantDb, sourceLead.id) : {};
  const workflowRoute =
    workflowRouteFromLeadPipeline(sourceLead?.pipelineType) ?? deal.workflowRoute;

  return {
    deal,
    sourceLead,
    property,
    answersByKey,
    resolved: {
      projectTypeId: sourceLead?.projectTypeId ?? deal.projectTypeId ?? null,
      sourceCategory: sourceLead?.sourceCategory ?? null,
      sourceDetail: sourceLead?.sourceDetail ?? null,
      legacySource: sourceLead?.source ?? deal.source ?? null,
      propertyId,
      propertyName: property?.name ?? deal.name ?? null,
      propertyAddress: property?.address ?? deal.propertyAddress ?? null,
      propertyCity: property?.city ?? deal.propertyCity ?? null,
      propertyState: property?.state ?? deal.propertyState ?? null,
      propertyZip: property?.zip ?? deal.propertyZip ?? null,
      primaryContactId: sourceLead?.primaryContactId ?? deal.primaryContactId ?? null,
      assignedRepId: sourceLead?.assignedRepId ?? deal.assignedRepId,
      workflowRoute,
      description: sourceLead?.description ?? deal.description ?? null,
      bidDueDate: getAnswerValue(answersByKey, "bid_due_date"),
    },
    ownership: DEAL_FIELD_OWNERSHIP,
  };
}

export async function getDealField(
  tenantDb: TenantDb,
  dealId: string,
  field: ResolvedDealField
) {
  const resolvedDeal = await getResolvedDeal(tenantDb, dealId);

  if (field === "preBidMeetingCompleted") return null;
  if (field === "siteVisitDecision") return null;
  if (field === "siteVisitCompleted") return null;
  if (field === "estimatorConsultationNotes") return null;

  return resolvedDeal.resolved[field as keyof ResolvedDealView["resolved"]] ?? null;
}
