import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  dealScopingIntake,
  deals,
  leadQuestionAnswers,
  leads,
  projectTypeQuestionNodes,
  properties,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { WorkflowRoute } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { applyProjectTypeChange, normalizeOptionalDealBidDueDate } from "./service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type DealFieldOwnership =
  | "lead"
  | "deal"
  | "deal_scoping";

export type ResolvedDealField =
  | "projectTypeId"
  | "companyId"
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
  companyId: "lead",
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
  bidDueDate: "lead",
  preBidMeetingCompleted: "deal_scoping",
  siteVisitDecision: "deal_scoping",
  siteVisitCompleted: "deal_scoping",
  estimatorConsultationNotes: "deal_scoping",
};

export type DealWriteTarget =
  | "source_lead"
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
    companyId: string | null;
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

export type ResolvedDealFieldPatch = Partial<Record<ResolvedDealField, unknown>>;

const DEAL_COMPATIBILITY_SNAPSHOT_FIELDS = new Set<ResolvedDealField>([
  "projectTypeId",
  "companyId",
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
  "bidDueDate",
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
      companyId: sourceLead?.companyId ?? deal.companyId ?? null,
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
      bidDueDate: sourceLead?.bidDueDate ?? null,
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

function normalizeOptionalText(value: unknown) {
  if (value == null) return null;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function mergeRecord(currentValue: unknown, incomingValue: Record<string, unknown>) {
  return {
    ...(typeof currentValue === "object" && currentValue !== null && !Array.isArray(currentValue)
      ? currentValue as Record<string, unknown>
      : {}),
    ...incomingValue,
  };
}

function scopingFieldLocation(field: ResolvedDealField) {
  if (field === "preBidMeetingCompleted") {
    return { section: "opportunity", key: "preBidMeetingCompleted" };
  }
  if (field === "siteVisitDecision") {
    return { section: "opportunity", key: "siteVisitDecision" };
  }
  if (field === "siteVisitCompleted") {
    return { section: "opportunity", key: "siteVisitCompleted" };
  }
  if (field === "estimatorConsultationNotes") {
    return { section: "opportunity", key: "estimatorConsultationNotes" };
  }
  return null;
}

async function getPropertySnapshot(tenantDb: TenantDb, propertyId: string | null) {
  if (!propertyId) return null;
  const [property] = await tenantDb
    .select()
    .from(properties)
    .where(eq(properties.id, propertyId))
    .limit(1);
  return property ?? null;
}

async function writeScopingFields(input: {
  tenantDb: TenantDb;
  resolvedDeal: ResolvedDealView;
  values: Array<[ResolvedDealField, unknown]>;
  userId: string;
  officeId: string;
  now: Date;
}) {
  if (input.values.length === 0) return;

  const [existingIntake] = await input.tenantDb
    .select()
    .from(dealScopingIntake)
    .where(eq(dealScopingIntake.dealId, input.resolvedDeal.deal.id))
    .limit(1);

  const sectionData =
    typeof existingIntake?.sectionData === "object" &&
    existingIntake.sectionData !== null &&
    !Array.isArray(existingIntake.sectionData)
      ? { ...existingIntake.sectionData as Record<string, unknown> }
      : {};

  for (const [field, value] of input.values) {
    const location = scopingFieldLocation(field);
    if (!location) continue;
    sectionData[location.section] = mergeRecord(sectionData[location.section], {
      [location.key]: value,
    });
  }

  if (existingIntake) {
    await input.tenantDb
      .update(dealScopingIntake)
      .set({
        sectionData,
        lastEditedBy: input.userId,
        lastAutosavedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(dealScopingIntake.id, existingIntake.id));
    return;
  }

  await input.tenantDb.insert(dealScopingIntake).values({
    dealId: input.resolvedDeal.deal.id,
    officeId: input.officeId,
    workflowRouteSnapshot: input.resolvedDeal.resolved.workflowRoute,
    status: "draft",
    projectTypeId: input.resolvedDeal.resolved.projectTypeId,
    sectionData,
    completionState: {},
    readinessErrors: {},
    firstReadyAt: null,
    activatedAt: null,
    lastAutosavedAt: input.now,
    createdBy: input.userId,
    lastEditedBy: input.userId,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export async function writeResolvedDealFields(
  tenantDb: TenantDb,
  dealId: string,
  patch: ResolvedDealFieldPatch,
  input: { userId: string; officeId: string; role: string; now?: Date }
) {
  const resolvedDeal = await getResolvedDeal(tenantDb, dealId);
  const now = input.now ?? new Date();
  const sourceLead = resolvedDeal.sourceLead;
  const leadUpdates: Record<string, unknown> = {};
  const dealUpdates: Record<string, unknown> = {};
  const scopingValues: Array<[ResolvedDealField, unknown]> = [];

  for (const [rawField, value] of Object.entries(patch)) {
    const field = rawField as ResolvedDealField;
    const writePlan = planDealFieldWrite({ field, hasSourceLead: Boolean(sourceLead) });

    if (writePlan.target === "deal_scoping") {
      scopingValues.push([field, value]);
      continue;
    }

    if (field === "propertyId") {
      const propertyId = normalizeOptionalText(value);
      const property = await getPropertySnapshot(tenantDb, propertyId);
      if (sourceLead) {
        leadUpdates.propertyId = propertyId;
      }
      dealUpdates.propertyId = propertyId;
      dealUpdates.name = property?.name ?? resolvedDeal.deal.name;
      dealUpdates.propertyAddress = property?.address ?? null;
      dealUpdates.propertyCity = property?.city ?? null;
      dealUpdates.propertyState = property?.state ?? null;
      dealUpdates.propertyZip = property?.zip ?? null;
      continue;
    }

    if (sourceLead && writePlan.target === "source_lead") {
      if (field === "projectTypeId") {
        const nextProjectTypeId = normalizeOptionalText(value);
        leadUpdates.projectTypeId = nextProjectTypeId;
        Object.assign(
          dealUpdates,
          await applyProjectTypeChange(tenantDb, resolvedDeal.deal, nextProjectTypeId, {
            id: input.userId,
            role: input.role,
          })
        );
      }
      if (field === "companyId") leadUpdates.companyId = normalizeOptionalText(value);
      if (field === "sourceCategory") leadUpdates.sourceCategory = normalizeOptionalText(value);
      if (field === "sourceDetail") leadUpdates.sourceDetail = normalizeOptionalText(value);
      if (field === "primaryContactId") leadUpdates.primaryContactId = normalizeOptionalText(value);
      if (field === "assignedRepId") leadUpdates.assignedRepId = normalizeOptionalText(value);
      if (field === "workflowRoute") leadUpdates.pipelineType = value === "service" ? "service" : "normal";
      if (field === "description") leadUpdates.description = normalizeOptionalText(value);
      if (field === "bidDueDate") leadUpdates.bidDueDate = normalizeOptionalText(value);

      if (writePlan.compatibilityWriteThrough) {
        if (field === "companyId") dealUpdates.companyId = normalizeOptionalText(value);
        if (field === "primaryContactId") dealUpdates.primaryContactId = normalizeOptionalText(value);
        if (field === "assignedRepId") dealUpdates.assignedRepId = normalizeOptionalText(value);
        if (field === "workflowRoute") dealUpdates.workflowRoute = value === "service" ? "service" : "normal";
        if (field === "description") dealUpdates.description = normalizeOptionalText(value);
        // deals.bid_due_date is timestamptz and the create/conversion path stores it at UTC midnight
        // (normalizeOptionalDealBidDueDate). Normalize identically here so the deal mirror matches the
        // lead's date-only "YYYY-MM-DD" with no off-by-one — single normalizer, no divergent inline.
        if (field === "bidDueDate") dealUpdates.bidDueDate = normalizeOptionalDealBidDueDate(value);
      }
      continue;
    }

    if (writePlan.target === "deal") {
      if (field === "projectTypeId") {
        Object.assign(
          dealUpdates,
          await applyProjectTypeChange(tenantDb, resolvedDeal.deal, normalizeOptionalText(value), {
            id: input.userId,
            role: input.role,
          })
        );
      }
      if (field === "companyId") dealUpdates.companyId = normalizeOptionalText(value);
      if (field === "primaryContactId") dealUpdates.primaryContactId = normalizeOptionalText(value);
      if (field === "assignedRepId") dealUpdates.assignedRepId = normalizeOptionalText(value);
      if (field === "workflowRoute") dealUpdates.workflowRoute = value === "service" ? "service" : "normal";
      if (field === "description") dealUpdates.description = normalizeOptionalText(value);
    }
  }

  if (sourceLead && Object.keys(leadUpdates).length > 0) {
    await tenantDb
      .update(leads)
      .set({
        ...leadUpdates,
        updatedAt: now,
      })
      .where(eq(leads.id, sourceLead.id));
  }

  if (Object.keys(dealUpdates).length > 0) {
    await tenantDb
      .update(deals)
      .set({
        ...dealUpdates,
        updatedAt: now,
      })
      .where(eq(deals.id, resolvedDeal.deal.id));
  }

  await writeScopingFields({
    tenantDb,
    resolvedDeal,
    values: scopingValues,
    userId: input.userId,
    officeId: input.officeId,
    now,
  });

  return getResolvedDeal(tenantDb, dealId);
}
