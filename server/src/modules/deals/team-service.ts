import { eq, and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealTeamMembers } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface AddTeamMemberInput {
  dealId: string;
  userId: string;
  role: string;
  assignedBy?: string;
  notes?: string;
}

export interface UpdateTeamMemberInput {
  role?: string;
  notes?: string | null;
}

export async function getTeamMembers(tenantDb: TenantDb, dealId: string) {
  const rows = await tenantDb.execute(
    sql`
      SELECT dtm.id, dtm.deal_id AS "dealId", dtm.user_id AS "userId", dtm.role,
             dtm.assigned_by AS "assignedBy", dtm.notes, dtm.is_active AS "isActive",
             dtm.created_at AS "createdAt", dtm.updated_at AS "updatedAt",
             u.display_name AS "displayName", u.email, u.avatar_url AS "avatarUrl"
      FROM deal_team_members dtm
      JOIN public.users u ON dtm.user_id = u.id
      WHERE dtm.deal_id = ${dealId} AND dtm.is_active = TRUE
      ORDER BY dtm.created_at
    `
  );
  return rows.rows;
}

export async function addTeamMember(tenantDb: TenantDb, input: AddTeamMemberInput) {
  if (!input.dealId) throw new AppError(400, "dealId is required");
  if (!input.userId) throw new AppError(400, "userId is required");
  if (!input.role) throw new AppError(400, "role is required");

  const result = await tenantDb
    .insert(dealTeamMembers)
    .values({
      dealId: input.dealId,
      userId: input.userId,
      role: input.role as any,
      assignedBy: input.assignedBy ?? null,
      notes: input.notes ?? null,
    })
    .returning();

  return result[0];
}

export async function updateTeamMember(
  tenantDb: TenantDb,
  memberId: string,
  dealId: string,
  input: UpdateTeamMemberInput
) {
  const updates: Record<string, any> = {};
  if (input.role !== undefined) updates.role = input.role;
  if (input.notes !== undefined) updates.notes = input.notes;

  if (Object.keys(updates).length === 0) {
    const [existing] = await tenantDb
      .select()
      .from(dealTeamMembers)
      .where(and(eq(dealTeamMembers.id, memberId), eq(dealTeamMembers.dealId, dealId)))
      .limit(1);
    if (!existing) throw new AppError(404, "Team member not found");
    return existing;
  }

  updates.updatedAt = new Date();

  const result = await tenantDb
    .update(dealTeamMembers)
    .set(updates)
    .where(
      and(
        eq(dealTeamMembers.id, memberId),
        eq(dealTeamMembers.dealId, dealId),
        eq(dealTeamMembers.isActive, true)
      )
    )
    .returning();

  if (result.length === 0) throw new AppError(404, "Team member not found");
  return result[0];
}

export async function removeTeamMember(tenantDb: TenantDb, memberId: string, dealId: string) {
  const result = await tenantDb
    .update(dealTeamMembers)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(dealTeamMembers.id, memberId), eq(dealTeamMembers.dealId, dealId)))
    .returning();

  if (result.length === 0) throw new AppError(404, "Team member not found");
  return result[0];
}
