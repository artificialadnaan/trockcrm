import { eq, and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { dealTeamMembers } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { restartCorrectiveActionNotificationCycleForDeal } from "../field/corrective-actions-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Owning office (id + slug) threaded from the deal route so a responder-role team mutation can enqueue a fresh
 * corrective-action notification cycle (payload needs officeId + `office_<slug>` tenant schema). Optional so
 * direct/legacy callers that never trigger the re-notify still type-check; when absent the re-notify is skipped
 * (the token revoke still runs), which is safe — the re-notify is a best-effort convenience, not a security gate.
 */
export interface TeamMutationOffice {
  id: string;
  slug: string;
}

export interface AddTeamMemberInput {
  dealId: string;
  // Exactly ONE of userId / contactId identifies a LINKED member — a staff user (public.users) OR a directory
  // contact (tenant contacts). OR, for an email-only member, BOTH are null and memberEmail (+ typically
  // memberName) are set. The DB check constraint (deal_team_members_identity_check) enforces the same three
  // shapes at the storage layer; this service asserts the shape before the insert for a clean 400.
  userId?: string | null;
  contactId?: string | null;
  // Email-only member (spec §4.4): a superintendent / project_manager who is NOT a CRM user or directory
  // contact — just a name + email — so the corrective-action flow can notify + token-auth them. Only honored
  // when neither userId nor contactId is set. Restricted to super/PM roles (see EMAIL_ONLY_TEAM_ROLES).
  memberName?: string | null;
  memberEmail?: string | null;
  role: string;
  assignedBy?: string;
  notes?: string;
}

// Email-only members exist ONLY to be corrective-action recipients (spec §4.4/§6), so only the two roles
// that flow resolves are allowed to be email-only. Every other role must be a CRM user or directory contact.
export const EMAIL_ONLY_TEAM_ROLES = new Set(["superintendent", "project_manager"]);

// Minimal, storage-layer email validation for an email-only member (a permissive shape check — a single @
// with non-empty local + domain parts). The client also validates; this is the server backstop.
export function isValidMemberEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
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
             -- An email-only member (both fks null) has no linked identity, so COALESCE falls through to the
             -- member_name/member_email on the row itself. The member_email-IS-NOT-NULL flag lets the UI
             -- render it distinctly (an external, no-login recipient).
             COALESCE(u.display_name, NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''), dtm.member_name) AS "displayName",
             COALESCE(u.email, c.email, dtm.member_email) AS "email",
             u.avatar_url AS "avatarUrl",
             (dtm.user_id IS NULL AND dtm.contact_id IS NULL AND dtm.member_email IS NOT NULL) AS "isEmailOnly"
      FROM deal_team_members dtm
      LEFT JOIN public.users u ON dtm.user_id = u.id
      LEFT JOIN contacts c ON dtm.contact_id = c.id
      WHERE dtm.deal_id = ${dealId} AND dtm.is_active = TRUE
        -- Surface members whose linked identity is ALSO active: a deactivated staff user
        -- (public.users.is_active) or an archived directory contact (contacts.is_active) must not show as an
        -- active team member — consistent with resolveScorecardTeamEmails/Names, which skip inactive identities.
        -- An email-only member (both fks null, member_email set) has no linked identity to deactivate, so it
        -- always shows while its deal_team_members row is active.
        AND (
          (dtm.user_id IS NOT NULL AND u.is_active)
          OR (dtm.contact_id IS NOT NULL AND c.is_active)
          OR (dtm.user_id IS NULL AND dtm.contact_id IS NULL AND dtm.member_email IS NOT NULL)
        )
      ORDER BY dtm.created_at
    `
  );
  return rows.rows;
}

export async function addTeamMember(
  tenantDb: TenantDb,
  input: AddTeamMemberInput,
  office?: TeamMutationOffice,
) {
  if (!input.dealId) throw new AppError(400, "dealId is required");
  if (!input.role) throw new AppError(400, "role is required");
  const hasUser = Boolean(input.userId);
  const hasContact = Boolean(input.contactId);
  const memberEmail = input.memberEmail?.trim() || "";
  const memberName = input.memberName?.trim() || "";

  // Email-only member (spec §4.4): neither a user nor a contact, just name + email. Only when NO linked
  // identity is provided AND an email is present — otherwise fall through to the strict user/contact one-of.
  if (!hasUser && !hasContact && memberEmail) {
    if (!EMAIL_ONLY_TEAM_ROLES.has(input.role)) {
      throw new AppError(400, "An email-only member must be a superintendent or project manager.");
    }
    if (!isValidMemberEmail(memberEmail)) {
      throw new AppError(400, "A valid email is required for an email-only member.");
    }
    if (!memberName) {
      throw new AppError(400, "A name is required for an email-only member.");
    }
    // Dedup active email-only assignments (finding E): a partial unique index
    // (deal_team_members_deal_email_role_uidx, migration 0196) forbids two ACTIVE email-only rows for the same
    // (deal_id, lower(member_email), role). onConflictDoNothing makes a RETRIED add / the same email+role entered
    // twice a no-op at the storage layer instead of a second active row. The other two identity indexes don't
    // apply here (user_id AND contact_id are NULL), so a bare onConflictDoNothing only swallows THIS collision.
    const emailResult = await tenantDb
      .insert(dealTeamMembers)
      .values({
        dealId: input.dealId,
        userId: null,
        contactId: null,
        memberName,
        memberEmail,
        role: input.role as any,
        assignedBy: input.assignedBy ?? null,
        notes: input.notes ?? null,
      })
      .onConflictDoNothing()
      .returning();

    // A conflict (0 rows returned) means an identical active email-only assignment already exists — a duplicate
    // add. Return that existing row and DO NOT restart the notification cycle (nothing changed; a no-op dup must
    // not re-notify or reset any open card's sent stamp). Only a genuinely NEW row restarts the cycle.
    if (emailResult.length === 0) {
      const [existing] = await tenantDb
        .select()
        .from(dealTeamMembers)
        .where(
          and(
            eq(dealTeamMembers.dealId, input.dealId),
            eq(dealTeamMembers.role, input.role as any),
            eq(dealTeamMembers.isActive, true),
            sql`${dealTeamMembers.userId} IS NULL`,
            sql`${dealTeamMembers.contactId} IS NULL`,
            sql`LOWER(${dealTeamMembers.memberEmail}) = LOWER(${memberEmail})`,
          ),
        )
        .limit(1);
      return existing;
    }

    await restartCycleForNewResponder(tenantDb, input.dealId, input.role, office);
    return emailResult[0];
  }

  // Exactly one of the two linked identities — mirrors the deal_team_members_identity_check constraint.
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

  await restartCycleForNewResponder(tenantDb, input.dealId, input.role, office);
  return result[0];
}

/**
 * When a NEW super/PM is ADDED to a deal, they become an authorized corrective-action responder (the
 * assignment/token IS the auth), but the deal's OPEN cards may have already stamped their notification as
 * sent — the worker's per-send recipient revalidation only covers a change DURING an active send, not a
 * responder who joins after the original cycle. So start a fresh notification cycle for the deal's open cards
 * so the new responder actually gets a link. Only fires when the added role is a responder role (super/PM);
 * best-effort — skipped when no office context was threaded (matches the leave/remove paths). Runs in the
 * caller's tenant transaction (the POST route commits both together).
 */
async function restartCycleForNewResponder(
  tenantDb: TenantDb,
  dealId: string,
  role: string,
  office?: TeamMutationOffice,
): Promise<void> {
  if (!office) return;
  if (role !== "superintendent" && role !== "project_manager") return;
  await restartCorrectiveActionNotificationCycleForDeal(tenantDb, { dealId, office });
}

export async function updateTeamMember(
  tenantDb: TenantDb,
  memberId: string,
  dealId: string,
  input: UpdateTeamMemberInput,
  office?: TeamMutationOffice,
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

  // Read the PRE-update row: its role (to detect a super/PM LEAVING that role) + identity (to resolve the
  // recipient email for token revocation). Also validates existence before the estimator guard / update.
  // FOR UPDATE (finding B): lock the target row so concurrent PATCHes on the SAME member serialize. Both derive
  // wasResponder/stillResponder from this pre-image; without the lock, two overlapping role transitions could
  // interleave and each restart the notification cycle (or one could revoke a token the other just re-authorized)
  // off a stale read. The lock is taken in the caller's tenant transaction (the PATCH route commits both).
  const [target] = await tenantDb
    .select({
      userId: dealTeamMembers.userId,
      contactId: dealTeamMembers.contactId,
      memberEmail: dealTeamMembers.memberEmail,
      role: dealTeamMembers.role,
    })
    .from(dealTeamMembers)
    .where(and(eq(dealTeamMembers.id, memberId), eq(dealTeamMembers.dealId, dealId)))
    .limit(1)
    .for("update");
  if (!target) throw new AppError(404, "Team member not found");

  // Guard the CHANGE-TO-estimator path too (not just add): a contact-backed member (contact_id set /
  // user_id null) re-roled to "estimator" would be a visibly-dead row — revision routing
  // (resolveRevisionTaskAssignee) only picks estimator rows whose user_id IS NOT NULL, so it could never be
  // routed a revision task. Mirrors the add-time reject in addTeamMember + the POST route.
  if (input.role === "estimator" && (target.contactId || !target.userId)) {
    throw new AppError(400, "Estimator must be a staff user, not a contact.");
  }

  // Preserve the ADD-flow email-only role restriction on UPDATE: an email-only member (no linked user AND no
  // linked contact — just a name + email) exists only to be a corrective-action recipient, so it may hold
  // ONLY a super/PM role (EMAIL_ONLY_TEAM_ROLES). Without this the PATCH could set any non-estimator role
  // (e.g. foreman) on an email-only member, which addTeamMember rejects. Only guard when a role is being set.
  const isEmailOnly = !target.userId && !target.contactId;
  if (input.role !== undefined && isEmailOnly && !EMAIL_ONLY_TEAM_ROLES.has(input.role)) {
    throw new AppError(400, "An email-only member must be a superintendent or project manager.");
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
  const updated = result[0];

  // A super/PM re-roled to a non-responder role (or deactivated) via update must lose its corrective-action
  // web tokens, exactly like removeTeamMember — otherwise a former responder keeps read/write access to the
  // responder page for the token TTL (30 days). Revoke when the member WAS a super/PM but is NO LONGER an
  // ACTIVE super/PM after the update. verifyCorrectiveActionToken checks only hash + expiry, so this is the
  // only server-side gate. The revoke helper is a no-op if the same recipient email is still held by another
  // active super/PM on the deal (so a lateral super↔PM swap keeps their token). Runs in the same tenant
  // transaction as the update (the PATCH route commits both together).
  const wasResponder = target.role === "superintendent" || target.role === "project_manager";
  const stillResponder =
    updated.isActive && (updated.role === "superintendent" || updated.role === "project_manager");
  // A TRUE lateral responder-role change (superintendent ↔ project_manager) is wasResponder AND stillResponder
  // AND the role actually changed between the two responder roles. Recipient resolution
  // (resolveActiveScorecardTeamRows) is DISTINCT ON (role) ORDER BY created_at DESC — so moving e.g. the newest
  // superintendent to PM EXPOSES an older superintendent whose prior-cycle token was deleted when the newer
  // assignment started its cycle. That fallback is now the resolved superintendent but has no working link and
  // still-set sent stamp, and the moved assignee's old token may fail current-recipient verification. So a
  // lateral swap must ALSO restart the cycle. Excludes a no-op edit that keeps the same role (role unchanged →
  // not a lateral swap → no restart), and never fires alongside the enter/leave branches (mutually exclusive).
  const lateralResponderSwap =
    wasResponder && stillResponder && updated.role !== target.role;
  if (wasResponder && !stillResponder) {
    await revokeCorrectiveActionTokensForRemovedMember(tenantDb, dealId, {
      userId: target.userId,
      contactId: target.contactId,
      memberEmail: target.memberEmail,
    });
    // A responder just LEFT the super/PM role — on a normal reassignment the replacement responder is now
    // authorized but was never notified of the deal's existing OPEN corrective actions (the worker's per-send
    // recipient revalidation only covers a change DURING an active send). Start a fresh notification cycle for
    // the deal's open corrective-action scorecards so the new responder gets a link. Best-effort: skipped when
    // no office context was threaded (the token revoke above still ran).
    if (office) {
      await restartCorrectiveActionNotificationCycleForDeal(tenantDb, { dealId, office });
    }
  } else if (!wasResponder && stillResponder) {
    // A member just ENTERED the responder roles (a non-responder re-roled INTO an active super/PM). They become
    // an authorized responder but the deal's open cards may have already stamped their notification as sent, so
    // the new responder would be authorized-but-silently-unnotified. Start a fresh cycle so they get a link —
    // the enter counterpart of the leave-path restart.
    // Best-effort: skipped when no office was threaded.
    if (office) {
      await restartCorrectiveActionNotificationCycleForDeal(tenantDb, { dealId, office });
    }
  } else if (lateralResponderSwap) {
    // A TRUE lateral super↔PM swap (see above): it hits NEITHER the enter nor leave branch, but the DISTINCT ON
    // (role) recipient resolution can now expose an OLDER same-role assignee whose token was deleted by the newer
    // assignment's cycle — that fallback is stranded (authorized, no working link, sent stamp still set). Restart
    // the deal's open-card cycle so every currently-resolved responder (the moved one AND any exposed fallback)
    // gets a fresh link. Fires EXACTLY ONCE (mutually exclusive with the enter/leave branches). No token revoke
    // here — the moved assignee is still a responder, and the restart re-issues links for whoever now resolves.
    // Best-effort: skipped when no office was threaded.
    if (office) {
      await restartCorrectiveActionNotificationCycleForDeal(tenantDb, { dealId, office });
    }
  }
  return updated;
}

export async function removeTeamMember(
  tenantDb: TenantDb,
  memberId: string,
  dealId: string,
  office?: TeamMutationOffice,
) {
  // Idempotent removal (finding C): restrict the deactivation to ACTIVE rows so a RETRIED delete flips 0 rows.
  // Without the is_active = TRUE predicate a retry re-matches the already-inactive row and returns it, re-running
  // the token revoke + notification-cycle restart below — which could delete a REPLACEMENT responder's fresh
  // token, reset every open card's sent stamp, and re-notify even though nothing changed. With the predicate the
  // retry updates 0 rows → we 404 → the side effects are gated on the update having actually flipped a row.
  const result = await tenantDb
    .update(dealTeamMembers)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(dealTeamMembers.id, memberId),
        eq(dealTeamMembers.dealId, dealId),
        eq(dealTeamMembers.isActive, true),
      ),
    )
    .returning();

  // 0 rows flipped ⇒ either no such member OR it was already inactive (a retry). Either way the side effects must
  // NOT run — a repeated remove is a no-op, not a fresh revoke/re-notify.
  if (result.length === 0) throw new AppError(404, "Team member not found");

  // Revoke any outstanding corrective-action web tokens for this recipient on the deal's scorecards.
  // verifyCorrectiveActionToken checks only hash + expiry, so without this a removed email-only super/PM
  // would keep read/write access to the responder page for up to the token TTL (30 days). We revoke by the
  // recipient's resolved email (tokens are recipient_email-bound), scoped to THIS deal's scorecards.
  const removed = result[0];
  if (removed.role === "superintendent" || removed.role === "project_manager") {
    await revokeCorrectiveActionTokensForRemovedMember(tenantDb, dealId, removed);
    // Removing a responder is the first half of a reassignment — the replacement (added separately) would be
    // authorized but never notified of the deal's existing OPEN corrective actions. Start a fresh notification
    // cycle so the new responder gets a link. Best-effort: skipped when no office context was threaded (the
    // token revoke above still ran).
    if (office) {
      await restartCorrectiveActionNotificationCycleForDeal(tenantDb, { dealId, office });
    }
  }
  return removed;
}

/**
 * Delete the removed super/PM's corrective-action tokens for the deal's scorecards. The removed row's email
 * is resolved from whichever identity it used (staff user, directory contact, or an email-only member's
 * member_email). To avoid revoking a token that is still legitimately held — e.g. the same person is assigned
 * to the deal twice, or a still-active member resolves to the same email — we only delete tokens whose
 * recipient_email is NOT the email of any OTHER active super/PM assignment on this deal. Runs in the same
 * tenant transaction as the removal (the DELETE route commits both together), so the revoke is atomic with
 * the soft-delete — a security revoke should not silently no-op if it fails.
 */
export async function revokeCorrectiveActionTokensForRemovedMember(
  tenantDb: TenantDb,
  dealId: string,
  removed: { userId: string | null; contactId: string | null; memberEmail: string | null },
): Promise<void> {
  // Resolve the removed member's email (lower-cased) from its identity. An email-only member carries it
  // directly; a linked user/contact resolves it from the joined identity row.
  const emailRes = await tenantDb.execute(sql`
    SELECT LOWER(COALESCE(
      ${removed.memberEmail},
      (SELECT email FROM public.users WHERE id = ${removed.userId ?? null}),
      (SELECT email FROM contacts WHERE id = ${removed.contactId ?? null})
    )) AS email
  `);
  const email = (emailRes.rows?.[0] as { email?: string | null } | undefined)?.email;
  if (!email) return;

  // If any OTHER active super/PM on this deal still resolves to the same email, the token is still valid for
  // them — do not revoke. But a match only counts when the OTHER assignment's LINKED identity is itself active:
  // a user-backed row needs public.users.is_active, a contact-backed row needs contacts.is_active, and an
  // email-only member (both fks null, member_email set) has no linked identity to deactivate so it always
  // counts. Otherwise a stale (deactivated-user) same-email assignment could preserve a token that no active
  // responder actually holds — consistent with the active-identity gate used everywhere else in this file.
  const stillAssigned = await tenantDb.execute(sql`
    SELECT 1
      FROM deal_team_members dtm
      LEFT JOIN public.users u ON dtm.user_id = u.id
      LEFT JOIN contacts c ON dtm.contact_id = c.id
     WHERE dtm.deal_id = ${dealId}
       AND dtm.is_active = TRUE
       AND dtm.role IN ('superintendent', 'project_manager')
       AND LOWER(COALESCE(dtm.member_email, u.email, c.email)) = ${email}
       AND (
         (dtm.user_id IS NOT NULL AND u.is_active)
         OR (dtm.contact_id IS NOT NULL AND c.is_active)
         OR (dtm.user_id IS NULL AND dtm.contact_id IS NULL AND dtm.member_email IS NOT NULL)
       )
     LIMIT 1
  `);
  if ((stillAssigned.rows?.length ?? 0) > 0) return;

  // Revoke: delete this recipient's tokens on every scorecard belonging to the deal.
  await tenantDb.execute(sql`
    DELETE FROM scorecard_corrective_action_tokens
     WHERE LOWER(recipient_email) = ${email}
       AND scorecard_id IN (SELECT id FROM field_scorecards WHERE deal_id = ${dealId})
  `);
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
