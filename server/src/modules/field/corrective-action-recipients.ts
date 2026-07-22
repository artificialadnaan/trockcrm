import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CorrectiveRecipient {
  role: "superintendent" | "project_manager";
  name: string;
  email: string;
  /** Set => a CRM user (respond in TRock Cam via a deep link). null => email-only (respond via a web token). */
  userId: string | null;
}

interface RecipientRow {
  role: string;
  name: string | null;
  email: string | null;
  user_id: string | null;
}

/**
 * Resolve the corrective-action recipients for a deal — the assigned superintendent + project_manager (spec
 * §6), across the HYBRID cases:
 *   1. an assigned CRM user  → email/name from public.users (must be an ACTIVE user), userId set;
 *   2. a directory contact   → email/name from the tenant contacts row (must be ACTIVE), userId null;
 *   3. an email-only member  → user_id + contact_id both NULL, member_email/member_name on the row (spec
 *      §4.4), userId null.
 *
 * Selection mirrors resolveActiveScorecardTeamRows in deals/team-service.ts: only ACTIVE deal_team_members
 * rows, only the two roles, and — for user/contact-backed rows — only when the linked identity is itself
 * active. If a role is assigned more than once, the most-recently-created eligible row wins (DISTINCT ON).
 *
 * A row whose email can't be resolved (no active identity, or an email-only row with a blank member_email)
 * is dropped — never emailed. Callers get 0..2 recipients.
 */
export async function resolveCorrectiveActionRecipients(
  db: TenantDb,
  dealId: string,
): Promise<CorrectiveRecipient[]> {
  const result = await db.execute(
    sql`
      SELECT DISTINCT ON (dtm.role)
             dtm.role AS "role",
             dtm.user_id AS "user_id",
             COALESCE(
               CASE WHEN dtm.user_id IS NOT NULL AND u.is_active THEN u.display_name END,
               CASE WHEN dtm.contact_id IS NOT NULL AND c.is_active THEN TRIM(CONCAT(c.first_name, ' ', c.last_name)) END,
               dtm.member_name
             ) AS "name",
             COALESCE(
               CASE WHEN dtm.user_id IS NOT NULL AND u.is_active THEN u.email END,
               CASE WHEN dtm.contact_id IS NOT NULL AND c.is_active THEN c.email END,
               dtm.member_email
             ) AS "email"
      FROM deal_team_members dtm
      LEFT JOIN public.users u ON dtm.user_id = u.id
      LEFT JOIN contacts c ON dtm.contact_id = c.id
      WHERE dtm.deal_id = ${dealId}
        AND dtm.is_active = TRUE
        AND dtm.role IN ('superintendent', 'project_manager')
        -- Only rows with a resolvable ACTIVE identity: an active user, an active contact, or an email-only
        -- member (both fks null). A row whose user/contact was deactivated/archived falls through and is
        -- skipped by the outer email-null filter after COALESCE lands on NULL.
        AND (
          (dtm.user_id IS NOT NULL AND u.is_active)
          OR (dtm.contact_id IS NOT NULL AND c.is_active)
          OR (dtm.user_id IS NULL AND dtm.contact_id IS NULL)
        )
      ORDER BY dtm.role, dtm.created_at DESC
    `,
  );
  const rows = ((result as { rows?: unknown[] }).rows ?? []) as RecipientRow[];

  const recipients: CorrectiveRecipient[] = [];
  for (const row of rows) {
    const email = row.email?.trim();
    if (!email) continue; // no resolvable email — drop (never emailed).
    const role = row.role as CorrectiveRecipient["role"];
    if (role !== "superintendent" && role !== "project_manager") continue;
    recipients.push({
      role,
      name: row.name?.trim() || email,
      email,
      userId: row.user_id ?? null,
    });
  }
  return recipients;
}

/**
 * The CRM base roles authorized to read/respond to a corrective action on ANY deal (spec §7.1). These are
 * management/oversight roles — everyone else (rep, construction, field_contractor) may respond ONLY when
 * they are the deal's assigned superintendent/project_manager.
 */
const CORRECTIVE_ACTION_MANAGEMENT_ROLES = new Set(["admin", "director"]);

export function isCorrectiveActionManagementRole(role: string | null | undefined): boolean {
  return !!role && CORRECTIVE_ACTION_MANAGEMENT_ROLES.has(role);
}

/**
 * Whether a SESSION user may read/respond to this deal's corrective action (spec §7.1). Two admits:
 *   1. the user holds an authorized management role (admin/director) — allowed on any deal; OR
 *   2. the user is an ACTIVE deal_team_members row on THIS deal whose role is superintendent or
 *      project_manager (matched by user_id) — the assigned super/PM.
 *
 * This is NARROWER than assertActiveFieldProject (which merely checks the deal is browsable): a
 * field_contractor/construction/rep who is not on the team — even though they can browse the project — is
 * NOT authorized to respond or auto-close. Membership is matched by user_id only (contact/email-only rows
 * are token-authed, never session-authed).
 */
export async function isAssignedCorrectiveActionResponder(
  db: TenantDb,
  dealId: string,
  user: { id: string; role: string | null | undefined },
): Promise<boolean> {
  if (isCorrectiveActionManagementRole(user.role)) return true;
  const result = await db.execute(
    sql`
      SELECT 1
        FROM deal_team_members dtm
       WHERE dtm.deal_id = ${dealId}
         AND dtm.user_id = ${user.id}
         AND dtm.is_active = TRUE
         AND dtm.role IN ('superintendent', 'project_manager')
       LIMIT 1
    `,
  );
  const rows = (result as { rows?: unknown[] }).rows ?? [];
  return rows.length > 0;
}
