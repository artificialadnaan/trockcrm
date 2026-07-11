import { eq, and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealTeamMembers } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface AddTeamMemberInput {
  dealId: string;
  // Exactly ONE of userId / contactId identifies the member — a staff user (public.users) OR a directory
  // contact (tenant contacts). The DB check constraint (deal_team_members_user_or_contact_check) enforces
  // the same one-of at the storage layer; this service asserts it before the insert for a clean 400.
  userId?: string | null;
  contactId?: string | null;
  role: string;
  assignedBy?: string;
  notes?: string;
}

export interface UpdateTeamMemberInput {
  role?: string;
  notes?: string | null;
}

export async function getTeamMembers(tenantDb: TenantDb, dealId: string) {
  // A member is EITHER a staff user (public.users) OR a directory contact (tenant contacts) — resolve the
  // display name + email from whichever fk is set so the web tab renders either. LEFT JOINs (not the old
  // inner JOIN on users) keep contact-backed rows visible; COALESCE picks the populated side.
  const rows = await tenantDb.execute(
    sql`
      SELECT dtm.id, dtm.deal_id AS "dealId", dtm.user_id AS "userId", dtm.contact_id AS "contactId",
             dtm.role, dtm.assigned_by AS "assignedBy", dtm.notes, dtm.is_active AS "isActive",
             dtm.created_at AS "createdAt", dtm.updated_at AS "updatedAt",
             COALESCE(u.display_name, TRIM(CONCAT(c.first_name, ' ', c.last_name))) AS "displayName",
             COALESCE(u.email, c.email) AS "email",
             u.avatar_url AS "avatarUrl"
      FROM deal_team_members dtm
      LEFT JOIN public.users u ON dtm.user_id = u.id
      LEFT JOIN contacts c ON dtm.contact_id = c.id
      WHERE dtm.deal_id = ${dealId} AND dtm.is_active = TRUE
      ORDER BY dtm.created_at
    `
  );
  return rows.rows;
}

export async function addTeamMember(tenantDb: TenantDb, input: AddTeamMemberInput) {
  if (!input.dealId) throw new AppError(400, "dealId is required");
  if (!input.role) throw new AppError(400, "role is required");
  const hasUser = Boolean(input.userId);
  const hasContact = Boolean(input.contactId);
  // Exactly one of the two identities — mirrors the deal_team_members_user_or_contact_check constraint.
  if (hasUser === hasContact) {
    throw new AppError(400, "Provide exactly one of userId or contactId");
  }

  const result = await tenantDb
    .insert(dealTeamMembers)
    .values({
      dealId: input.dealId,
      userId: hasUser ? input.userId! : null,
      contactId: hasContact ? input.contactId! : null,
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

export interface ScorecardTeamEmails {
  superintendentEmail: string | null;
  projectManagerEmail: string | null;
  superintendentName: string | null;
  projectManagerName: string | null;
}

/**
 * Resolve the CC recipients for a deal's field scorecard email: the deal's assigned superintendent and
 * project_manager, keyed off the ACTIVE deal_team_members rows. Each role's email is resolved from the
 * linked staff user (public.users) or directory contact (tenant contacts) — whichever the member row
 * carries. If a role is assigned more than once, the most-recently-created active row wins (DISTINCT ON).
 * A role with no active member — or a member whose user/contact has no email on file — resolves to null,
 * so the enqueue site simply omits that CC.
 */
export async function resolveScorecardTeamEmails(
  tenantDb: TenantDb,
  dealId: string,
): Promise<ScorecardTeamEmails> {
  const result = await tenantDb.execute(
    sql`
      SELECT DISTINCT ON (dtm.role)
             dtm.role AS "role",
             COALESCE(u.email, c.email) AS "email",
             COALESCE(u.display_name, TRIM(CONCAT(c.first_name, ' ', c.last_name))) AS "name"
      FROM deal_team_members dtm
      LEFT JOIN public.users u ON dtm.user_id = u.id
      LEFT JOIN contacts c ON dtm.contact_id = c.id
      WHERE dtm.deal_id = ${dealId}
        AND dtm.is_active = TRUE
        AND dtm.role IN ('superintendent', 'project_manager')
      ORDER BY dtm.role, dtm.created_at DESC
    `
  );
  const rows = (result.rows ?? []) as Array<{ role: string; email: string | null; name: string | null }>;
  const superintendent = rows.find((r) => r.role === "superintendent");
  const projectManager = rows.find((r) => r.role === "project_manager");
  return {
    superintendentEmail: superintendent?.email ?? null,
    projectManagerEmail: projectManager?.email ?? null,
    superintendentName: superintendent?.name ?? null,
    projectManagerName: projectManager?.name ?? null,
  };
}
