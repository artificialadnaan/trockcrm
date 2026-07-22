import { eq, and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealTeamMembers } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface AddTeamMemberInput {
  dealId: string;
  // Exactly ONE of userId / contactId identifies the member — a staff user (public.users) OR a directory
  // contact (tenant contacts). The DB check constraint (deal_team_members_identity_check) enforces the same
  // one-of at the storage layer (it additionally permits an email-only member — user_id + contact_id both
  // NULL, member_email set — added for corrective-action recipients, which this user/contact path never
  // creates); this service asserts the one-of before the insert for a clean 400.
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
        -- Only surface members whose linked identity is ALSO active: a deactivated staff user
        -- (public.users.is_active) or an archived directory contact (contacts.is_active) must not show as an
        -- active team member — consistent with resolveScorecardTeamEmails/Names, which skip inactive identities.
        AND ((dtm.user_id IS NOT NULL AND u.is_active) OR (dtm.contact_id IS NOT NULL AND c.is_active))
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
  // Exactly one of the two identities — mirrors the deal_team_members_identity_check constraint.
  if (hasUser === hasContact) {
    throw new AppError(400, "Provide exactly one of userId or contactId");
  }
  // A contact-backed estimator is a visibly-dead row: revision routing (resolveRevisionTaskAssignee)
  // only picks estimator rows whose user_id IS NOT NULL, so a contact estimator can never be routed a
  // revision task. Reject it here too (mirrors the POST /:id/team route) for direct callers of this service.
  if (hasContact && input.role === "estimator") {
    throw new AppError(400, "Estimator must be a staff user, not a contact.");
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

  // Guard the CHANGE-TO-estimator path too (not just add): a contact-backed member (contact_id set /
  // user_id null) re-roled to "estimator" would be a visibly-dead row — revision routing
  // (resolveRevisionTaskAssignee) only picks estimator rows whose user_id IS NOT NULL, so it could never be
  // routed a revision task. Mirrors the add-time reject in addTeamMember + the POST route.
  if (input.role === "estimator") {
    const [target] = await tenantDb
      .select({ userId: dealTeamMembers.userId, contactId: dealTeamMembers.contactId })
      .from(dealTeamMembers)
      .where(and(eq(dealTeamMembers.id, memberId), eq(dealTeamMembers.dealId, dealId)))
      .limit(1);
    if (!target) throw new AppError(404, "Team member not found");
    if (target.contactId || !target.userId) {
      throw new AppError(400, "Estimator must be a staff user, not a contact.");
    }
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

export interface ScorecardTeamNames {
  superintendentName: string | null;
  pmName: string | null;
}

interface ScorecardTeamRow {
  role: string;
  email: string | null;
  name: string | null;
}

/**
 * The deal's assigned superintendent + project_manager, resolved ONLY from ACTIVE identities. A candidate
 * team row counts only when its linked identity is itself active — the joined staff user (public.users)
 * with is_active = TRUE, OR the joined directory contact (tenant contacts) with is_active = TRUE. So a
 * superintendent/PM whose USER was deactivated, or whose CONTACT was archived, is skipped and the role
 * resolves to null (the enqueue omits that CC; the prefill leaves the field blank). If a role is assigned
 * more than once, the most-recently-created row whose identity is STILL active wins (DISTINCT ON).
 */
async function resolveActiveScorecardTeamRows(
  tenantDb: TenantDb,
  dealId: string,
): Promise<ScorecardTeamRow[]> {
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
        -- Skip rows whose linked identity is inactive: a deactivated staff user (public.users.is_active)
        -- or an archived directory contact (contacts.is_active). DISTINCT ON then lands on the most-recent
        -- row that is BOTH an active team row AND backed by an active user/contact.
        AND ((dtm.user_id IS NOT NULL AND u.is_active) OR (dtm.contact_id IS NOT NULL AND c.is_active))
      ORDER BY dtm.role, dtm.created_at DESC
    `
  );
  return (result.rows ?? []) as unknown as ScorecardTeamRow[];
}

/**
 * Resolve the CC recipients for a deal's field scorecard email: the deal's assigned superintendent and
 * project_manager, keyed off the ACTIVE deal_team_members rows AND their ACTIVE user/contact identities.
 * A role with no active member — or one whose user/contact is deactivated/archived or has no email on
 * file — resolves to null, so the enqueue site simply omits that CC.
 */
export async function resolveScorecardTeamEmails(
  tenantDb: TenantDb,
  dealId: string,
): Promise<ScorecardTeamEmails> {
  const rows = await resolveActiveScorecardTeamRows(tenantDb, dealId);
  const superintendent = rows.find((r) => r.role === "superintendent");
  const projectManager = rows.find((r) => r.role === "project_manager");
  return {
    superintendentEmail: superintendent?.email ?? null,
    projectManagerEmail: projectManager?.email ?? null,
    superintendentName: superintendent?.name ?? null,
    projectManagerName: projectManager?.name ?? null,
  };
}

/**
 * The deal's assigned superintendent + PM NAMES only (no emails), resolved with the SAME active-identity
 * + most-recent selection as resolveScorecardTeamEmails — so the field prefill shows the same person the
 * completed-scorecard email is CC'd to. Blank/whitespace names normalize to null.
 */
export async function resolveScorecardTeamNames(
  tenantDb: TenantDb,
  dealId: string,
): Promise<ScorecardTeamNames> {
  const rows = await resolveActiveScorecardTeamRows(tenantDb, dealId);
  const pick = (role: string): string | null => {
    const name = rows.find((r) => r.role === role)?.name?.trim();
    return name ? name : null;
  };
  return {
    superintendentName: pick("superintendent"),
    pmName: pick("project_manager"),
  };
}
