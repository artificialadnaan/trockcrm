import { and, desc, eq, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { activities, deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;
type ActivitySourceEntityType = "company" | "property" | "lead" | "deal" | "contact";

export interface CreateActivityInput {
  type: string;
  responsibleUserId: string;
  performedByUserId?: string;
  sourceEntityType: ActivitySourceEntityType;
  sourceEntityId: string;
  companyId?: string;
  propertyId?: string;
  leadId?: string;
  dealId?: string;
  contactId?: string;
  emailId?: string;
  subject?: string;
  body?: string;
  outcome?: string;
  durationMinutes?: number;
  occurredAt?: string;
}

export interface ActivityFilters {
  companyId?: string;
  propertyId?: string;
  leadId?: string;
  dealId?: string;
  contactId?: string;
  responsibleUserId?: string;
  userId?: string;
  sourceEntityType?: ActivitySourceEntityType;
  sourceEntityId?: string;
  type?: string;
  page?: number;
  limit?: number;
}

const SOURCE_ENTITY_LINK_KEY: Record<ActivitySourceEntityType, keyof Pick<
  CreateActivityInput,
  "companyId" | "propertyId" | "leadId" | "dealId" | "contactId"
>> = {
  company: "companyId",
  property: "propertyId",
  lead: "leadId",
  deal: "dealId",
  contact: "contactId",
};

function normalizeLinkedEntities(input: CreateActivityInput) {
  const linkedEntities = {
    companyId: input.companyId ?? null,
    propertyId: input.propertyId ?? null,
    leadId: input.leadId ?? null,
    dealId: input.dealId ?? null,
    contactId: input.contactId ?? null,
  };

  const sourceLinkKey = SOURCE_ENTITY_LINK_KEY[input.sourceEntityType];
  const existingSourceLink = linkedEntities[sourceLinkKey];

  if (existingSourceLink && existingSourceLink !== input.sourceEntityId) {
    throw new AppError(400, `${sourceLinkKey} must match sourceEntityId`);
  }

  linkedEntities[sourceLinkKey] = input.sourceEntityId;

  return linkedEntities;
}

/**
 * Get activities filtered by deal, contact, or user.
 */
export async function getActivities(
  tenantDb: TenantDb,
  filters: ActivityFilters
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  const responsibleUserId = filters.responsibleUserId ?? filters.userId;

  let dealCondition = filters.dealId ? eq(activities.dealId, filters.dealId) : undefined;

  if (filters.dealId) {
    const [deal] = await tenantDb
      .select({ sourceLeadId: deals.sourceLeadId })
      .from(deals)
      .where(eq(deals.id, filters.dealId))
      .limit(1);

    if (deal?.sourceLeadId) {
      dealCondition = or(
        eq(activities.dealId, filters.dealId),
        eq(activities.leadId, deal.sourceLeadId)
      );
    }
  }

  if (filters.companyId) conditions.push(eq(activities.companyId, filters.companyId));
  if (filters.propertyId) conditions.push(eq(activities.propertyId, filters.propertyId));
  if (filters.leadId) conditions.push(eq(activities.leadId, filters.leadId));
  if (dealCondition) conditions.push(dealCondition);
  if (filters.contactId) conditions.push(eq(activities.contactId, filters.contactId));
  if (responsibleUserId) conditions.push(eq(activities.responsibleUserId, responsibleUserId));
  if (filters.sourceEntityType) {
    conditions.push(eq(activities.sourceEntityType, filters.sourceEntityType as any));
  }
  if (filters.sourceEntityId) conditions.push(eq(activities.sourceEntityId, filters.sourceEntityId));
  if (filters.type) conditions.push(eq(activities.type, filters.type as any));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult, rows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(activities).where(where),
    tenantDb
      .select()
      .from(activities)
      .where(where)
      .orderBy(desc(activities.occurredAt), desc(activities.createdAt))
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    activities: rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Create an activity (call, note, meeting, task_completed).
 * Also updates deals.lastActivityAt if a dealId is provided.
 *
 * NOTE: The existing PG touchpoint_trigger on the activities table automatically
 * handles: incrementing contacts.touchpoint_count, updating contacts.last_contacted_at,
 * and setting contacts.first_outreach_completed = true for call/email/meeting types.
 * We do NOT need to do this in application code.
 */
export async function createActivity(
  tenantDb: TenantDb,
  input: CreateActivityInput
) {
  if (!input.type) throw new AppError(400, "Activity type is required");
  if (!input.responsibleUserId) throw new AppError(400, "responsibleUserId is required");
  if (!input.sourceEntityType) throw new AppError(400, "sourceEntityType is required");
  if (!input.sourceEntityId) throw new AppError(400, "sourceEntityId is required");

  const linkedEntities = normalizeLinkedEntities(input);

  const result = await tenantDb
    .insert(activities)
    .values({
      type: input.type as any,
      responsibleUserId: input.responsibleUserId,
      performedByUserId: input.performedByUserId ?? null,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
      companyId: linkedEntities.companyId,
      propertyId: linkedEntities.propertyId,
      leadId: linkedEntities.leadId,
      dealId: linkedEntities.dealId,
      contactId: linkedEntities.contactId,
      emailId: input.emailId ?? null,
      subject: input.subject ?? null,
      body: input.body ?? null,
      outcome: input.outcome ?? null,
      durationMinutes: input.durationMinutes ?? null,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
    })
    .returning();

  const activity = result[0];

  // Update deal.lastActivityAt if deal is associated
  if (linkedEntities.dealId) {
    await tenantDb
      .update(deals)
      .set({ lastActivityAt: new Date() })
      .where(eq(deals.id, linkedEntities.dealId));
  }

  return activity;
}
