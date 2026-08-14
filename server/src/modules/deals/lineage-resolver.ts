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
import { redactPropertyImageKeys } from "../properties/property-image-service.js";
import { applyProjectTypeChange, clearSalesSource, normalizeOptionalDealBidDueDate } from "./service.js";
import { lockCurrentDealDescription, recordDescriptionHistoryChange } from "./deal-description-history.js";

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
  property: Omit<typeof properties.$inferSelect, "imageR2Key" | "imageThumbnailR2Key"> | null;
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

/**
 * deals.bid_due_date is a timestamptz stored at UTC midnight; leads.bid_due_date is a date-only column
 * serialized as "YYYY-MM-DD". When a deal has NO source lead the deal column is the authoritative value,
 * so the resolver must surface it in the SAME date-only string shape lead-backed deals produce —
 * consumers (scoping-service, the PATCH /resolved-fields response) guard on `typeof === "string"`. Read
 * the UTC calendar day so there's no off-by-one against the UTC-midnight storage.
 */
function dealBidDueDateToDateOnly(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
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
  const [propertyRow] = propertyId
    ? await tenantDb.select().from(properties).where(eq(properties.id, propertyId)).limit(1)
    : [null];
  // Redact the internal R2 image keys — this full property row is serialized to clients.
  const property = propertyRow ? redactPropertyImageKeys(propertyRow) : null;

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
      // A lead-backed deal's bid due date is owned by the lead — INCLUDING when it's been cleared to
      // null. Only fall back to the deal column when there's NO source lead at all, so a deliberately
      // cleared lead value isn't masked by a stale pre-write-through deal snapshot (scoping/readiness
      // must see the clear). No source lead → the deal column is authoritative (UTC date-only).
      bidDueDate: sourceLead
        ? sourceLead.bidDueDate ?? null
        : dealBidDueDateToDateOnly(deal.bidDueDate) ?? null,
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

    // Reciprocal conflict guard: the new owner cannot be the deal's current sales source.
    // Mirrors the identical check in updateDeal (service.ts) — closes the bypass path where
    // PATCH /resolved-fields could move the sales-source rep into the owner slot and produce
    // a double commission cut (owner row + the existing additive sales_source row).
    if (field === "assignedRepId") {
      const newAssignedRepId = normalizeOptionalText(value);
      // L (P3): allow reassigning to the current source when the SAME patch also moves the deal OUT of the
      // service workflow — the F9 block below then clears the now-invalid source, so owner==source is only
      // transient (no double-count). Otherwise a valid single-save correction would be forced into two
      // requests. Mirrors the identical carve-out in updateDeal (service.ts).
      const leavingServiceWorkflow =
        resolvedDeal.deal.workflowRoute === "service" &&
        "workflowRoute" in patch &&
        (patch as { workflowRoute?: unknown }).workflowRoute !== "service";
      if (
        newAssignedRepId != null &&
        newAssignedRepId === (resolvedDeal.deal.salesSourceUserId ?? null) &&
        !leavingServiceWorkflow
      ) {
        throw new AppError(
          422,
          "Cannot reassign a deal to its sales source",
          "SALES_SOURCE_CONFLICT"
        );
      }
    }

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
      // A deal with no source lead owns bidDueDate directly — write it to the authoritative
      // deals.bid_due_date column (timestamptz, UTC-midnight) via the SAME normalizer the
      // lead-mirror path uses (line ~417), so non-lead edits actually persist instead of no-op'ing.
      if (field === "bidDueDate") dealUpdates.bidDueDate = normalizeOptionalDealBidDueDate(value);
    }
  }

  // Lock + read the current deals.description (what the deal-detail panel shows) BEFORE any write, so a
  // concurrent resolved-fields save on the same deal can't slip a stale intermediate into the history row.
  const oldDealDescription =
    dealUpdates.description !== undefined
      ? await lockCurrentDealDescription(tenantDb, resolvedDeal.deal.id)
      : null;

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

    // The resolved-fields path also writes deals.description (lead compatibility write-through or a direct
    // deal edit), so record the change-log row here too, using the locked deals.description before-value above.
    if (dealUpdates.description !== undefined) {
      await recordDescriptionHistoryChange(tenantDb, {
        dealId: resolvedDeal.deal.id,
        oldDescription: oldDealDescription,
        newDescription: dealUpdates.description as string | null,
        changedBy: input.userId,
        source: "resolved_fields",
        // changedAt omitted -> DB now() at insert (post-lock), so concurrent same-deal saves order correctly.
      });
    }
  }

  await writeScopingFields({
    tenantDb,
    resolvedDeal,
    values: scopingValues,
    userId: input.userId,
    officeId: input.officeId,
    now,
  });

  // F9 (resolved-fields bypass): if this write just transitioned the deal out of the service
  // workflow, clear any stale sales-source attribution. The PATCH /deals/:id/resolved-fields
  // route writes workflowRoute directly via dealUpdates without going through updateDeal, so the
  // guard there does not fire. Mirror the identical condition from updateDeal in service.ts so
  // the invariant holds regardless of which write path changes the route.
  if (
    "workflowRoute" in dealUpdates &&
    resolvedDeal.deal.workflowRoute === "service" &&
    dealUpdates.workflowRoute !== "service" &&
    (resolvedDeal.deal.salesSourceUserId ?? null) !== null
  ) {
    await clearSalesSource(tenantDb, dealId, input.userId);
  }

  return getResolvedDeal(tenantDb, dealId);
}
