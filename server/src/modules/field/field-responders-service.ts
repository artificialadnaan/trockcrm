import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { fieldResponders, dealTeamMembers } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import {
  isFieldResponderRole,
  type FieldResponder,
  type FieldResponderAssignment,
  type FieldResponderRole,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { addTeamMember, isValidMemberEmail } from "../deals/team-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

// The two roster roles ARE the two email-only responder roles a deal assignment resolves for corrective
// actions — kept in lockstep with the shared FIELD_RESPONDER_ROLES union + the field_responders.role CHECK.
// The assignmentCount / assignments joins scope to these roles so a stray non-super/PM assignment (which the
// team layer forbids for email-only members anyway) can never inflate a responder's usage.
const RESPONDER_ASSIGNMENT_ROLES = sql`('superintendent', 'project_manager')`;

export interface CreateFieldResponderInput {
  name: string;
  email: string;
  role: string;
}

export interface UpdateFieldResponderInput {
  name?: string;
  email?: string;
  role?: string;
  isActive?: boolean;
}

/** Row shape for the roster list — the Drizzle columns plus the derived assignmentCount. */
interface FieldResponderListRow {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  assignmentCount: number;
}

function toFieldResponder(row: FieldResponderListRow): FieldResponder {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    // role is DB-constrained to the two roster roles (field_responders_role_check), so this cast is safe;
    // the create/update paths reject anything outside the union before it can reach a stored row.
    role: row.role as FieldResponderRole,
    isActive: row.isActive,
    assignmentCount: Number(row.assignmentCount) || 0,
  };
}

/**
 * The managed roster with a per-person assignmentCount. assignmentCount = the number of DISTINCT ACTIVE deals
 * on which this responder is currently an ACTIVE superintendent / project_manager deal_team_members row (i.e.
 * where dtm.responder_id = the roster id). A correlated subquery keeps the count exact even when a responder is
 * linked to the same deal twice (COUNT(DISTINCT deal_id)) and returns 0 for an unused responder. By default only
 * ACTIVE roster rows are returned; `includeInactive` surfaces deactivated people too (e.g. the admin roster page
 * with the "show inactive" toggle). Ordered active-first, then by name for a stable roster list.
 */
export async function listFieldResponders(
  tenantDb: TenantDb,
  opts?: { includeInactive?: boolean },
): Promise<{ responders: FieldResponder[] }> {
  const includeInactive = opts?.includeInactive === true;
  const result = await tenantDb.execute(sql`
    SELECT
      fr.id AS "id",
      fr.name AS "name",
      fr.email AS "email",
      fr.role AS "role",
      fr.is_active AS "isActive",
      (
        SELECT COUNT(DISTINCT dtm.deal_id)
          FROM deal_team_members dtm
          JOIN deals d ON d.id = dtm.deal_id
         WHERE dtm.responder_id = fr.id
           AND dtm.is_active = TRUE
           AND dtm.role IN ${RESPONDER_ASSIGNMENT_ROLES}
           AND d.is_active = TRUE
      )::int AS "assignmentCount"
    FROM field_responders fr
    ${includeInactive ? sql`` : sql`WHERE fr.is_active = TRUE`}
    ORDER BY fr.is_active DESC, LOWER(fr.name), fr.created_at
  `);
  const rows = (result.rows ?? []) as unknown as FieldResponderListRow[];
  return { responders: rows.map(toFieldResponder) };
}

/**
 * Create a roster person. Case-insensitive email uniqueness is enforced among ACTIVE rows only (a deactivated
 * person's email is free to be re-added) by the partial unique index field_responders_active_email_uidx; the
 * onConflictDoNothing turns a race / duplicate into a clean 409 rather than poisoning the caller's transaction
 * with a 23505 (which would abort an open txn). name/email are trimmed; role is validated against the union.
 */
export async function createFieldResponder(
  tenantDb: TenantDb,
  input: CreateFieldResponderInput,
): Promise<FieldResponder> {
  // The route forwards req.body verbatim (no runtime typing), so name/email may not actually be strings. Coerce a
  // non-string to "" here so it falls through to the 400 guards below rather than throwing a 500 on .trim().
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const role = input.role;
  if (!name) throw new AppError(400, "A name is required.");
  if (!email || !isValidMemberEmail(email)) throw new AppError(400, "A valid email is required.");
  if (!isFieldResponderRole(role)) {
    throw new AppError(400, "Role must be 'superintendent' or 'project_manager'.");
  }

  // ON CONFLICT on the partial EXPRESSION index (lower(email) WHERE is_active) — Drizzle's typed onConflict
  // can't target an expression index, so use raw SQL. A collision with an ACTIVE same-email row is swallowed
  // and reported as a clean 409 below; an inactive same-email row does not conflict (a deactivated email may
  // be re-added). The partial index is the race backstop.
  const insertResult = await tenantDb.execute(sql`
    INSERT INTO field_responders (name, email, role)
    VALUES (${name}, ${email}, ${role})
    ON CONFLICT (lower(email)) WHERE is_active = TRUE DO NOTHING
    RETURNING id, name, email, role, is_active AS "isActive"
  `);
  const inserted = (insertResult.rows ?? []) as Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    isActive: boolean;
  }>;

  if (inserted.length === 0) {
    throw new AppError(
      409,
      "A responder with this email already exists on the roster.",
      "FIELD_RESPONDER_EMAIL_DUPLICATE",
    );
  }
  return {
    id: inserted[0].id,
    name: inserted[0].name,
    email: inserted[0].email,
    role: inserted[0].role as FieldResponderRole,
    isActive: inserted[0].isActive,
    assignmentCount: 0,
  };
}

/**
 * Update / deactivate a roster person. Any subset of name/email/role/isActive may be sent; an empty patch is a
 * no-op read. Editing the email is validated + de-dup-checked against OTHER active rows (case-insensitively) so
 * a rename can't collide with a different active responder; reactivating a row whose email now collides with an
 * active holder is likewise rejected. Editing email/name does NOT cascade to existing deal_team_members rows —
 * those copied the name+email at assign time (a known v1 follow-up); this only updates the roster row. Returns
 * the updated responder with its freshly-recomputed assignmentCount.
 */
export async function updateFieldResponder(
  tenantDb: TenantDb,
  id: string,
  input: UpdateFieldResponderInput,
): Promise<FieldResponder> {
  const updates: Record<string, unknown> = {};
  // As in create: a non-string name/email from the untyped body coerces to "" and hits the 400 guard rather than
  // throwing a 500 on .trim().
  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new AppError(400, "A name is required.");
    updates.name = name;
  }
  let nextEmail: string | null = null;
  if (input.email !== undefined) {
    const email = typeof input.email === "string" ? input.email.trim() : "";
    if (!email || !isValidMemberEmail(email)) throw new AppError(400, "A valid email is required.");
    updates.email = email;
    nextEmail = email;
  }
  if (input.role !== undefined) {
    if (!isFieldResponderRole(input.role)) {
      throw new AppError(400, "Role must be 'superintendent' or 'project_manager'.");
    }
    updates.role = input.role;
  }
  if (input.isActive !== undefined) {
    // Reject a non-boolean isActive (null, "true", 0, …) rather than silently coercing it to false — the route
    // forwards req.body.isActive verbatim, and a malformed patch must not deactivate a responder as a side
    // effect. A legitimate client always sends a real boolean.
    if (typeof input.isActive !== "boolean") {
      throw new AppError(400, "isActive must be true or false.");
    }
    updates.isActive = input.isActive;
  }

  const [existing] = await tenantDb
    .select()
    .from(fieldResponders)
    .where(eq(fieldResponders.id, id))
    .limit(1);
  if (!existing) throw new AppError(404, "Field responder not found.");

  if (Object.keys(updates).length === 0) {
    return toFieldResponder({ ...existing, assignmentCount: await assignmentCountFor(tenantDb, id) });
  }

  // Guard the active-email uniqueness BEFORE the write so a rename/reactivation collision surfaces as a clean
  // 409 rather than a raw 23505 that aborts the caller's transaction. The row is considered ACTIVE-after-update
  // if isActive is being set true, or it was already active and isActive isn't being set false. The email under
  // test is the incoming email if provided, else the current one. Only an ACTIVE holder (a different id) blocks.
  const willBeActive =
    input.isActive !== undefined ? input.isActive === true : existing.isActive;
  const emailUnderTest = nextEmail ?? existing.email;
  if (willBeActive) {
    const [collision] = await tenantDb
      .select({ id: fieldResponders.id })
      .from(fieldResponders)
      .where(
        and(
          sql`LOWER(${fieldResponders.email}) = LOWER(${emailUnderTest})`,
          eq(fieldResponders.isActive, true),
          sql`${fieldResponders.id} <> ${id}`,
        ),
      )
      .limit(1);
    if (collision) {
      throw new AppError(
        409,
        "A responder with this email already exists on the roster.",
        "FIELD_RESPONDER_EMAIL_DUPLICATE",
      );
    }
  }

  updates.updatedAt = new Date();
  let updated: (typeof fieldResponders.$inferSelect)[];
  try {
    updated = await tenantDb
      .update(fieldResponders)
      .set(updates)
      .where(eq(fieldResponders.id, id))
      .returning();
  } catch (err) {
    // TOCTOU backstop: two concurrent renames/reactivations targeting the same active email can both clear the
    // pre-check SELECT above before either UPDATE lands. The partial unique index (field_responders_active_
    // email_uidx) then rejects the loser with 23505 — the only unique constraint an UPDATE here can violate.
    // Translate that into the same clean 409 an ordinary duplicate returns instead of leaking a generic 500.
    if (isUniqueViolation(err)) {
      throw new AppError(
        409,
        "A responder with this email already exists on the roster.",
        "FIELD_RESPONDER_EMAIL_DUPLICATE",
      );
    }
    throw err;
  }
  if (updated.length === 0) throw new AppError(404, "Field responder not found.");

  return toFieldResponder({
    ...updated[0],
    assignmentCount: await assignmentCountFor(tenantDb, id),
  });
}

/** The distinct-active-deals count for one responder — the same predicate as the list's correlated subquery. */
async function assignmentCountFor(tenantDb: TenantDb, responderId: string): Promise<number> {
  const res = await tenantDb.execute(sql`
    SELECT COUNT(DISTINCT dtm.deal_id)::int AS "count"
      FROM deal_team_members dtm
      JOIN deals d ON d.id = dtm.deal_id
     WHERE dtm.responder_id = ${responderId}
       AND dtm.is_active = TRUE
       AND dtm.role IN ${RESPONDER_ASSIGNMENT_ROLES}
       AND d.is_active = TRUE
  `);
  return Number((res.rows?.[0] as { count: number } | undefined)?.count ?? 0);
}

/**
 * The ACTIVE deals a responder is currently the super / PM on — the drill-down behind assignmentCount. Returns
 * the deal id, name, and the role that responder holds on that deal, DISTINCT per (deal, role) so a responder
 * linked twice under the same role on one deal appears once. Newest assignment first. 404s if the responder id
 * is unknown (so the endpoint distinguishes "no such responder" from "responder with zero assignments").
 */
export async function listFieldResponderAssignments(
  tenantDb: TenantDb,
  responderId: string,
): Promise<{ deals: FieldResponderAssignment[] }> {
  const [existing] = await tenantDb
    .select({ id: fieldResponders.id })
    .from(fieldResponders)
    .where(eq(fieldResponders.id, responderId))
    .limit(1);
  if (!existing) throw new AppError(404, "Field responder not found.");

  const result = await tenantDb.execute(sql`
    SELECT DISTINCT
      dtm.deal_id AS "dealId",
      d.name AS "dealName",
      dtm.role AS "role",
      MAX(dtm.created_at) AS "assignedAt"
      FROM deal_team_members dtm
      JOIN deals d ON d.id = dtm.deal_id
     WHERE dtm.responder_id = ${responderId}
       AND dtm.is_active = TRUE
       AND dtm.role IN ${RESPONDER_ASSIGNMENT_ROLES}
       AND d.is_active = TRUE
     GROUP BY dtm.deal_id, d.name, dtm.role
     ORDER BY MAX(dtm.created_at) DESC, d.name
  `);
  const rows = (result.rows ?? []) as unknown as Array<{ dealId: string; dealName: string; role: string }>;
  return {
    deals: rows.map((r) => ({
      dealId: r.dealId,
      dealName: r.dealName,
      role: r.role as FieldResponderRole,
    })),
  };
}

/**
 * Resolve an ACTIVE roster person for the assign-from-roster path (POST /deals/:id/team with a responderId).
 * Returns the copyable name + email + role the team layer stamps onto the new email-only deal_team_members row
 * (so corrective-action recipient resolution stays unchanged — it resolves member_email, not the roster row).
 * 404s a missing responder; 400s a deactivated one (an inactive person must not be freshly assignable).
 *
 * FOR UPDATE locks the roster row for the duration of the caller's request transaction (the route resolves then
 * inserts the team member, then commits — one tx). This serializes the active-check + assignment against a
 * concurrent director PATCH that deactivates or renames the same responder: that update blocks until this tx
 * commits, so we can't assign a responder that was concurrently deactivated, nor copy a stale name/email.
 */
export async function resolveResponderForAssignment(
  tenantDb: TenantDb,
  responderId: string,
): Promise<{ id: string; name: string; email: string; role: FieldResponderRole }> {
  const [row] = await tenantDb
    .select({
      id: fieldResponders.id,
      name: fieldResponders.name,
      email: fieldResponders.email,
      role: fieldResponders.role,
      isActive: fieldResponders.isActive,
    })
    .from(fieldResponders)
    .where(eq(fieldResponders.id, responderId))
    .limit(1)
    .for("update");
  if (!row) throw new AppError(404, "Field responder not found.");
  if (!row.isActive) throw new AppError(400, "This field responder is deactivated and cannot be assigned.");
  return { id: row.id, name: row.name, email: row.email, role: row.role as FieldResponderRole };
}

/** True when a thrown DB error is a Postgres unique-violation (23505). Drizzle wraps driver errors in a
 * DrizzleQueryError whose `.cause` carries the raw pg error, so walk the cause chain to detect it at either
 * level (mirrors the isUniqueViolation helper in the deals rfp-vote service). */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    if (cur !== null && typeof cur === "object" && (cur as { code?: string }).code === "23505") return true;
    const msg = cur instanceof Error ? cur.message : String(cur);
    if (/duplicate key value|unique constraint|field_responders_active_email_uidx/i.test(msg)) return true;
    cur = cur !== null && typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * Resolve a scorecard's free-text super/PM NAME to a UNIQUE active roster person of that role (case-insensitive).
 * Returns null when the name is blank, matches nothing, OR matches more than one active responder — we never
 * guess which same-named person is meant. Powers the field-driven deal assignment below (the scorecard picker
 * stores a name, and a name picked from the roster dropdown maps back to exactly one roster row).
 */
export async function resolveActiveResponderByName(
  tenantDb: TenantDb,
  name: string | null | undefined,
  role: FieldResponderRole,
): Promise<{ id: string; name: string; email: string; role: FieldResponderRole } | null> {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  const rows = await tenantDb
    .select({
      id: fieldResponders.id,
      name: fieldResponders.name,
      email: fieldResponders.email,
      role: fieldResponders.role,
    })
    .from(fieldResponders)
    .where(
      and(
        eq(fieldResponders.isActive, true),
        eq(fieldResponders.role, role),
        sql`LOWER(${fieldResponders.name}) = LOWER(${trimmed})`,
      ),
    )
    .limit(2);
  if (rows.length !== 1) return null; // 0 = no match; >1 = ambiguous same-name — don't guess
  return { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: rows[0].role as FieldResponderRole };
}

/**
 * Field-driven deal assignment (scorecard → deal team). When a scorecard names a super/PM that maps to a UNIQUE
 * active roster person AND the deal has NO active member of that role, assign them to the deal team so BOTH the
 * completed-scorecard email and the corrective-action notification reach the person the field user picked on the
 * scorecard dropdown. "Only if unset" — it fills an empty role, never overrides an existing Team-tab assignment.
 * A custom/typed or ambiguous name resolves to null and is skipped (no wrong assignment, no wrong recipient). No
 * cycle restart (office omitted): it runs inside the scorecard-submission transaction, and that submission's own
 * corrective-action reconcile + the worker's send-time recipient resolution deliver the notification.
 */
export async function assignRosterResponderToDealIfUnset(
  tenantDb: TenantDb,
  dealId: string,
  name: string | null | undefined,
  role: FieldResponderRole,
): Promise<void> {
  // Serialize the vacancy-check-then-insert against a concurrent scorecard submission for the SAME (deal, role):
  // a per-(deal, role) transaction-scoped advisory lock makes the second caller block until the first commits,
  // so it then sees the newly-filled role and skips — rather than both passing an unlocked vacancy check and
  // double-inserting. Held to commit (this runs in the scorecard-submission transaction); a no-op under the
  // single-threaded test harness.
  await tenantDb.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${dealId}::text), hashtext(${role}::text))`,
  );

  const [existing] = await tenantDb
    .select({ id: dealTeamMembers.id })
    .from(dealTeamMembers)
    .where(
      and(
        eq(dealTeamMembers.dealId, dealId),
        eq(dealTeamMembers.role, role),
        eq(dealTeamMembers.isActive, true),
      ),
    )
    .limit(1);
  if (existing) return; // only-if-unset: the deal already has a super/PM for this role — leave it untouched
  const responder = await resolveActiveResponderByName(tenantDb, name, role);
  if (!responder) return; // no unique roster match (custom name / same-name collision) — nothing to assign
  await addTeamMember(tenantDb, {
    dealId,
    memberName: responder.name,
    memberEmail: responder.email,
    responderId: responder.id,
    role,
  });
}
