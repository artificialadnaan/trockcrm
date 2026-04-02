import { eq, and, desc, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { activities, deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CreateActivityInput {
  type: string;
  userId: string;
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
  dealId?: string;
  contactId?: string;
  userId?: string;
  type?: string;
  page?: number;
  limit?: number;
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

  if (filters.dealId) conditions.push(eq(activities.dealId, filters.dealId));
  if (filters.contactId) conditions.push(eq(activities.contactId, filters.contactId));
  if (filters.userId) conditions.push(eq(activities.userId, filters.userId));
  if (filters.type) conditions.push(eq(activities.type, filters.type as any));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult, rows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(activities).where(where),
    tenantDb
      .select()
      .from(activities)
      .where(where)
      .orderBy(desc(activities.occurredAt))
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
  if (!input.userId) throw new AppError(400, "userId is required");

  const result = await tenantDb
    .insert(activities)
    .values({
      type: input.type as any,
      userId: input.userId,
      dealId: input.dealId ?? null,
      contactId: input.contactId ?? null,
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
  if (input.dealId) {
    await tenantDb
      .update(deals)
      .set({ lastActivityAt: new Date() })
      .where(eq(deals.id, input.dealId));
  }

  return activity;
}
