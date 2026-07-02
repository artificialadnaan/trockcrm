import { eq, asc, and, sql } from "drizzle-orm";
import {
  users,
  userCommissionSettings,
  userOfficeAccess,
  offices,
  userExternalIdentities,
  userLocalAuth,
  userLocalAuthEvents,
} from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { isAssignableCrmRole, type CrmAssignableRole, type UserRole } from "@trock-crm/shared/types";
import {
  stripsAdminPrivilege,
  evaluateUpdateUserGuards,
  planSessionInvalidation,
} from "@trock-crm/shared/lib/userProvisioningGuards";
import { resolveEffectiveCapxRate } from "@trock-crm/shared/lib/commission-structure";
import {
  incrementTokenVersion,
  revokeLocalAuthOnDeactivate,
  clearLocalAuthRevocation,
  closeUserSseConnections,
} from "../auth/session-invalidation.js";
import { recalculateAllCommissionsForRep } from "../commissions/recompute-service.js";
import {
  getLocalAuthStatus,
  type LocalAuthStatus,
} from "../auth/local-auth-service.js";

type ExecuteRows<T> = { rows: T[] } | T[];

function rowsFromExecute<T>(result: ExecuteRows<T>): T[] {
  return Array.isArray(result) ? result : result.rows;
}

interface UserLocalAuthEventSqlRow extends Record<string, unknown> {
  id: string;
  event_type: string;
  actor_user_id: string | null;
  metadata: unknown;
  created_at: Date | string;
  actor_display_name: string | null;
}

interface ActiveUserOfficeAccessSqlRow extends Record<string, unknown> {
  id: string;
  email: string;
  display_name: string;
  office_id: string | null;
  is_active: boolean;
}

function assertRate(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AppError(400, `${name} must be between 0 and 1`);
  }
}

function assertNonNegative(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError(400, `${name} must be greater than or equal to 0`);
  }
}

function assertPositiveInteger(name: string, value: number) {
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError(400, `${name} must be an integer greater than or equal to 1`);
  }
}

function assertCommissionStructure(value: string): asserts value is "solo" | "mixed" {
  if (value !== "solo" && value !== "mixed") {
    throw new AppError(400, "commissionStructure must be 'solo' or 'mixed'");
  }
}

export async function listUsers(officeId?: string) {
  const rows = officeId
    ? await db.execute(sql`
        SELECT
          u.id,
          u.email,
          u.display_name,
          u.role,
          u.office_id,
          u.reports_to,
          u.is_active,
          u.created_at
        FROM users u
        WHERE u.office_id = ${officeId}
          OR EXISTS (
            SELECT 1
            FROM user_office_access uoa
            WHERE uoa.user_id = u.id
              AND uoa.office_id = ${officeId}
          )
        ORDER BY u.display_name ASC
      `)
    : await db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          role: users.role,
          officeId: users.officeId,
          reportsTo: users.reportsTo,
          isActive: users.isActive,
          createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(asc(users.displayName));

  const resultRows = (rows as any).rows ?? rows;
  return resultRows.map((row: any) =>
    officeId
      ? {
          id: row.id,
          email: row.email,
          displayName: row.display_name,
          role: row.role,
          officeId: row.office_id,
          reportsTo: row.reports_to,
          isActive: row.is_active,
          createdAt: row.created_at,
        }
      : row
  );
}

export async function getUserById(id: string) {
  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  if (!userRows[0]) return null;

  const accessRows = await db
    .select({
      officeId: userOfficeAccess.officeId,
      officeName: offices.name,
      roleOverride: userOfficeAccess.roleOverride,
    })
    .from(userOfficeAccess)
    .innerJoin(offices, eq(offices.id, userOfficeAccess.officeId))
    .where(eq(userOfficeAccess.userId, id));

  return { ...userRows[0], officeAccess: accessRows };
}

export interface CreateCrmUserInput {
  email: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  role: string;
  officeId: string;
  reportsTo?: string | null;
}

// Pure, throwing validation — the create-flow's gate of record. The role decision is the gate-proven
// isAssignableCrmRole; the rest are simple presence checks.
// A pragmatic single-@ email shape — the create dialog isn't a <form>, so the field's type="email" is
// NOT a backstop; this is the server-side gate of record before the insert.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertCreatableCrmUser(input: CreateCrmUserInput): asserts input is CreateCrmUserInput & { role: CrmAssignableRole } {
  if (!input.email?.trim()) throw new AppError(400, "Email is required");
  if (!EMAIL_RE.test(input.email.trim())) throw new AppError(400, "Enter a valid email address");
  if (!input.displayName?.trim()) throw new AppError(400, "Display name is required");
  if (!input.officeId?.trim()) throw new AppError(400, "Office is required");
  // Validate the relationship ids are well-formed UUIDs before they reach the DB — a malformed value
  // otherwise hits Postgres and surfaces as a 500 (uuid 22P02) instead of a clean 400.
  if (!UUID_RE.test(input.officeId.trim())) throw new AppError(400, "Office is invalid");
  // Blank/whitespace reportsTo == "no manager" (normalized to null at insert); only a non-blank,
  // non-UUID value is an error.
  const reportsTo = input.reportsTo?.trim();
  if (reportsTo && !UUID_RE.test(reportsTo)) {
    throw new AppError(400, "Manager is invalid");
  }
  if (input.role === "field_contractor") throw new AppError(400, "Field contractors are created in the field-user flow");
  if (!isAssignableCrmRole(input.role)) throw new AppError(400, `Invalid role: ${input.role}`);
}

export async function createCrmUser(input: CreateCrmUserInput, actorUserId: string) {
  assertCreatableCrmUser(input);
  const email = input.email.trim().toLowerCase();

  const office = await db.select({ id: offices.id, isActive: offices.isActive }).from(offices).where(eq(offices.id, input.officeId)).limit(1);
  if (!office[0]) throw new AppError(400, "Office not found");
  if (!office[0].isActive) throw new AppError(400, "Office is not active");

  // Pre-check is case-insensitive (the stored constraint is case-sensitive, but emails are normalized
  // to lowercase on insert, so this catches mixed-case existing rows too).
  const existing = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (existing[0]) throw new AppError(409, "A user with this email already exists");

  try {
    const [created] = await db
      .insert(users)
      .values({
        email,
        displayName: input.displayName.trim(),
        firstName: input.firstName?.trim() || null,
        lastName: input.lastName?.trim() || null,
        role: input.role,
        officeId: input.officeId,
        reportsTo: input.reportsTo?.trim() || null,
        isActive: true,
        createdByUserId: actorUserId,
      })
      .returning();
    return created;
  } catch (e: unknown) {
    // Lost the race to a concurrent insert with the same email -> the unique constraint fires (23505).
    if (e && typeof e === "object" && (e as { code?: string }).code === "23505") {
      throw new AppError(409, "A user with this email already exists");
    }
    throw e;
  }
}

export async function updateUser(
  id: string,
  input: Partial<{
    displayName: string;
    role: "admin" | "director" | "rep" | "construction";
    officeId: string;
    reportsTo: string | null;
    isActive: boolean;
    notificationPrefs: Record<string, unknown>;
    commissionStructure: "solo" | "mixed";
    capxRateSolo: number;
    capxRateMixed: number;
    serviceSourceRate: number;
    rollingFloor: number;
    overrideRate: number;
    estimatedMarginRate: number;
    minMarginPercent: number;
    newCustomerShareFloor: number;
    newCustomerWindowMonths: number;
    commissionConfigActive: boolean;
  }>,
  actorUserId: string
) {
  const result = await db.transaction(async (tx) => {
    let commissionRatesChanged = false;
    const existing = await tx
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    const existingUser = existing[0];
    if (!existingUser) throw new AppError(404, "User not found");

    const nextRole = input.role as UserRole | undefined;

    // --- Guards (decision + enforcement composition are gate-proven pure functions) ---
    // Only count active admins when admin privilege is actually being stripped, and lock the FULL
    // active-admin set FOR UPDATE so two concurrent admin-strips serialize (no last-admin TOCTOU:
    // the second tx blocks, then re-reads the first's committed deactivation and sees count 0).
    let otherActiveAdminCount = Number.MAX_SAFE_INTEGER;
    if (stripsAdminPrivilege(existingUser.role, nextRole, input.isActive)) {
      const activeAdmins = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.isActive, true)))
        .for("update");
      otherActiveAdminCount = activeAdmins.filter((row) => row.id !== id).length;
    }
    const violation = evaluateUpdateUserGuards({
      actorId: actorUserId,
      targetId: id,
      currentRole: existingUser.role,
      nextRole,
      nextIsActive: input.isActive,
      otherActiveAdminCount,
    });
    if (violation) throw new AppError(violation.status, violation.message);

    const updates: Record<string, unknown> = {};
    if (input.displayName !== undefined) updates.displayName = input.displayName;
    if (input.role !== undefined) updates.role = input.role;
    if (input.officeId !== undefined) updates.officeId = input.officeId;
    if (input.reportsTo !== undefined) updates.reportsTo = input.reportsTo;
    if (input.isActive !== undefined) updates.isActive = input.isActive;
    if (input.notificationPrefs !== undefined) updates.notificationPrefs = input.notificationPrefs;

    const hasBaseUserPatch = Object.keys(updates).length > 0;
    if (hasBaseUserPatch) {
      updates.updatedAt = new Date();
    }

    const updated = hasBaseUserPatch
      ? (
          await tx
            .update(users)
            .set(updates)
            .where(eq(users.id, id))
            .returning()
        )[0]
      : existingUser;

    // --- Session-kill wiring (epoch + revocation; SSE teardown happens post-commit) ---
    const now = new Date();
    const plan = planSessionInvalidation({
      currentIsActive: existingUser.isActive,
      currentRole: existingUser.role,
      nextIsActive: input.isActive,
      nextRole,
    });
    if (plan.bumpVersion) await incrementTokenVersion(tx, id);
    if (plan.revokeLocalAuth) await revokeLocalAuthOnDeactivate(tx, id, actorUserId, now);
    if (plan.clearLocalAuthRevocation) await clearLocalAuthRevocation(tx, id, now);

    const hasCommissionPatch =
      input.commissionStructure !== undefined ||
      input.capxRateSolo !== undefined ||
      input.capxRateMixed !== undefined ||
      input.serviceSourceRate !== undefined ||
      input.rollingFloor !== undefined ||
      input.overrideRate !== undefined ||
      input.estimatedMarginRate !== undefined ||
      input.minMarginPercent !== undefined ||
      input.newCustomerShareFloor !== undefined ||
      input.newCustomerWindowMonths !== undefined ||
      input.commissionConfigActive !== undefined;

    if (hasCommissionPatch) {
      const existingConfig = await tx
        .select()
        .from(userCommissionSettings)
        .where(eq(userCommissionSettings.userId, id))
        .limit(1)
        // Lock the row so concurrent PATCHes for the same rep serialize: the second tx blocks here,
        // then re-reads the first's committed values before deriving fallbacks — no lost update on
        // a field the other request didn't touch. (No row yet ⇒ the unique key serializes the insert.)
        .for("update");
      const current = existingConfig[0];

      const commissionStructure = input.commissionStructure ?? current?.commissionStructure ?? "solo";
      const capxRateSolo = input.capxRateSolo ?? Number(current?.capxRateSolo ?? 0);
      const capxRateMixed = input.capxRateMixed ?? Number(current?.capxRateMixed ?? 0);
      const serviceSourceRate = input.serviceSourceRate ?? Number(current?.serviceSourceRate ?? 0);
      const rollingFloor = input.rollingFloor ?? Number(current?.rollingFloor ?? 0);
      const overrideRate = input.overrideRate ?? Number(current?.overrideRate ?? 0);
      const estimatedMarginRate = input.estimatedMarginRate ?? Number(current?.estimatedMarginRate ?? 0.3);
      const minMarginPercent = input.minMarginPercent ?? Number(current?.minMarginPercent ?? 0.2);
      const newCustomerShareFloor = input.newCustomerShareFloor ?? Number(current?.newCustomerShareFloor ?? 0.1);
      const newCustomerWindowMonths = input.newCustomerWindowMonths ?? Number(current?.newCustomerWindowMonths ?? 6);
      const isActive = input.commissionConfigActive ?? Boolean(current?.isActive ?? true);

      assertCommissionStructure(commissionStructure);
      assertRate("capxRateSolo", capxRateSolo);
      assertRate("capxRateMixed", capxRateMixed);
      assertRate("serviceSourceRate", serviceSourceRate);
      assertNonNegative("rollingFloor", rollingFloor);
      assertRate("overrideRate", overrideRate);
      assertRate("estimatedMarginRate", estimatedMarginRate);
      assertRate("minMarginPercent", minMarginPercent);
      assertRate("newCustomerShareFloor", newCustomerShareFloor);
      assertPositiveInteger("newCustomerWindowMonths", newCustomerWindowMonths);

      // Denormalized mirror: commission_rate = the EFFECTIVE capX rate for the active structure,
      // so every existing engine read of commission_rate keeps working. This SINGLE line is the
      // only place the mirror is maintained; commission_rate is never written directly (the
      // structure + capX rates are the sole inputs).
      const commissionRate = resolveEffectiveCapxRate({
        commissionStructure,
        capxRateSolo,
        capxRateMixed,
        serviceSourceRate,
      });

      await tx
        .insert(userCommissionSettings)
        .values({
          userId: id,
          commissionRate: String(commissionRate),
          commissionStructure,
          capxRateSolo: String(capxRateSolo),
          capxRateMixed: String(capxRateMixed),
          serviceSourceRate: String(serviceSourceRate),
          rollingFloor: String(rollingFloor),
          overrideRate: String(overrideRate),
          estimatedMarginRate: String(estimatedMarginRate),
          minMarginPercent: String(minMarginPercent),
          newCustomerShareFloor: String(newCustomerShareFloor),
          newCustomerWindowMonths,
          isActive,
        })
        .onConflictDoUpdate({
          target: userCommissionSettings.userId,
          set: {
            commissionRate: String(commissionRate),
            commissionStructure,
            capxRateSolo: String(capxRateSolo),
            capxRateMixed: String(capxRateMixed),
            serviceSourceRate: String(serviceSourceRate),
            rollingFloor: String(rollingFloor),
            overrideRate: String(overrideRate),
            estimatedMarginRate: String(estimatedMarginRate),
            minMarginPercent: String(minMarginPercent),
            newCustomerShareFloor: String(newCustomerShareFloor),
            newCustomerWindowMonths,
            isActive,
            updatedAt: new Date(),
          },
        });

      // Only recompute when the EFFECTIVE capX rate actually moved. Editing an INACTIVE rate
      // (e.g. Mixed % while the rep is Solo), the service-source rate (unused for owner/estimator
      // rows in PR1), or a non-rate field leaves the mirror unchanged — so it must NOT trigger a
      // fan-out (which would otherwise re-rate deals to their current values for no reason). PR2
      // will additionally gate on the effective service-source rate once sales_source rows exist.
      const previousCommissionRate = resolveEffectiveCapxRate({
        commissionStructure: current?.commissionStructure ?? "solo",
        capxRateSolo: Number(current?.capxRateSolo ?? 0),
        capxRateMixed: Number(current?.capxRateMixed ?? 0),
        serviceSourceRate: Number(current?.serviceSourceRate ?? 0),
      });
      // Compare at the column's scale (numeric(7,6)). A raw float compare would treat a no-op blur
      // as a change — e.g. a stored 0.029000 comes back from the client as 2.9/100 = 0.02899999…,
      // which !== 0.029 and would spuriously fan out. Normalising both to 6 decimals avoids that.
      commissionRatesChanged = commissionRate.toFixed(6) !== previousCommissionRate.toFixed(6);
    }

    return { updated, closeStreams: plan.closeStreams, commissionRatesChanged };
  });

  // Best-effort, post-commit: drop the deactivated user's live SSE streams immediately. The
  // authoritative gate remains the per-request is_active + token-version re-check.
  if (result.closeStreams) closeUserSseConnections(id);

  // Fire-and-forget, post-commit: re-rating is best-effort and must never block the admin's save
  // nor fail the already-committed settings write (kicked off like closeUserSseConnections above).
  // The task owns its own logging. Only fires when the effective capX rate actually changed.
  if (result.commissionRatesChanged) {
    void (async () => {
      try {
        const summary = await recalculateAllCommissionsForRep(id, actorUserId);
        if (summary.officeFailures.length > 0) {
          console.error(
            `[commissions] rep ${id} recompute had office failures:`,
            JSON.stringify(summary.officeFailures),
          );
        }
      } catch (err) {
        console.error(`[commissions] rep ${id} recompute could not start:`, err);
      }
    })();
  }

  return result.updated;
}

export async function grantOfficeAccess(
  userId: string,
  officeId: string,
  roleOverride?: "admin" | "director" | "rep"
) {
  await db
    .insert(userOfficeAccess)
    .values({ userId, officeId, roleOverride: roleOverride ?? null })
    .onConflictDoUpdate({
      target: [userOfficeAccess.userId, userOfficeAccess.officeId],
      set: { roleOverride: roleOverride ?? null },
    });
}

export async function revokeOfficeAccess(userId: string, officeId: string) {
  await db
    .delete(userOfficeAccess)
    .where(
      and(
        eq(userOfficeAccess.userId, userId),
        eq(userOfficeAccess.officeId, officeId)
      )
    );
}

export async function listActiveUsersWithOfficeAccess() {
  const result = await db.execute<ActiveUserOfficeAccessSqlRow>(sql`
    SELECT
      u.id,
      u.email,
      u.display_name,
      u.office_id,
      u.is_active
    FROM users u
    WHERE u.is_active = true
    ORDER BY u.display_name ASC
  `);

  const rows = rowsFromExecute(result);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    officeId: r.office_id,
    isActive: r.is_active,
  }));
}

/** Get all users with their office counts for the admin overview table. */
export async function getUsersWithStats() {
  const result = await db.execute(sql`
    SELECT
      u.id,
      u.email,
      u.display_name,
      u.role,
      u.office_id,
      u.reports_to,
      u.is_active,
      o.name AS office_name,
      COUNT(uoa.office_id)::int AS extra_office_count,
      cs.commission_rate,
      cs.commission_structure,
      cs.capx_rate_solo,
      cs.capx_rate_mixed,
      cs.service_source_rate,
      cs.rolling_floor,
      cs.override_rate,
      cs.estimated_margin_rate,
      cs.min_margin_percent,
      cs.new_customer_share_floor,
      cs.new_customer_window_months,
      cs.is_active AS commission_config_active
    FROM users u
    LEFT JOIN offices o ON o.id = u.office_id
    LEFT JOIN user_office_access uoa ON uoa.user_id = u.id
    LEFT JOIN user_commission_settings cs ON cs.user_id = u.id
    GROUP BY
      u.id,
      u.email,
      u.display_name,
      u.role,
      u.office_id,
      u.reports_to,
      u.is_active,
      o.name,
      cs.commission_rate,
      cs.commission_structure,
      cs.capx_rate_solo,
      cs.capx_rate_mixed,
      cs.service_source_rate,
      cs.rolling_floor,
      cs.override_rate,
      cs.estimated_margin_rate,
      cs.min_margin_percent,
      cs.new_customer_share_floor,
      cs.new_customer_window_months,
      cs.is_active
    ORDER BY u.display_name ASC
  `);

  const rows = (result as any).rows ?? result;
  const userIds = rows.map((row: any) => row.id);

  const [identityRows, localAuthRows, eventRows] = userIds.length
    ? await Promise.all([
        db
          .select({
            userId: userExternalIdentities.userId,
            sourceSystem: userExternalIdentities.sourceSystem,
          })
          .from(userExternalIdentities),
        db
          .select({
            userId: userLocalAuth.userId,
            isEnabled: userLocalAuth.isEnabled,
            mustChangePassword: userLocalAuth.mustChangePassword,
            inviteSentAt: userLocalAuth.inviteSentAt,
            inviteExpiresAt: userLocalAuth.inviteExpiresAt,
            lastLoginAt: userLocalAuth.lastLoginAt,
            failedLoginAttempts: userLocalAuth.failedLoginAttempts,
            lockedUntil: userLocalAuth.lockedUntil,
            passwordChangedAt: userLocalAuth.passwordChangedAt,
            revokedAt: userLocalAuth.revokedAt,
          })
          .from(userLocalAuth),
        db
          .select({
            userId: userLocalAuthEvents.userId,
            eventType: userLocalAuthEvents.eventType,
            actorUserId: userLocalAuthEvents.actorUserId,
            createdAt: userLocalAuthEvents.createdAt,
          })
          .from(userLocalAuthEvents),
      ])
    : [[], [], []];

  const sourceSystemsByUserId = new Map<string, string[]>();
  for (const row of identityRows) {
    const existing = sourceSystemsByUserId.get(row.userId) ?? [];
    if (!existing.includes(row.sourceSystem)) {
      existing.push(row.sourceSystem);
      sourceSystemsByUserId.set(row.userId, existing);
    }
  }

  const localAuthByUserId = new Map<
    string,
    {
      isEnabled: boolean;
      mustChangePassword: boolean;
      inviteSentAt: Date | null;
      inviteExpiresAt: Date | null;
      lastLoginAt: Date | null;
      failedLoginAttempts: number;
      lockedUntil: Date | null;
      passwordChangedAt: Date | null;
      revokedAt: Date | null;
    }
  >();
  for (const row of localAuthRows) {
    localAuthByUserId.set(row.userId, row);
  }

  const latestEventByUserId = new Map<
    string,
    {
      eventType: string;
      actorUserId: string | null;
      createdAt: Date;
    }
  >();
  for (const row of eventRows) {
    const current = latestEventByUserId.get(row.userId);
    if (!current || current.createdAt.getTime() < row.createdAt.getTime()) {
      latestEventByUserId.set(row.userId, row);
    }
  }

  return rows.map((r: any) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    officeId: r.office_id,
    reportsTo: r.reports_to,
    officeName: r.office_name,
    isActive: r.is_active,
    extraOfficeCount: Number(r.extra_office_count ?? 0),
    commissionRate: Number(r.commission_rate ?? 0),
    commissionStructure: (r.commission_structure ?? "solo") as "solo" | "mixed",
    capxRateSolo: Number(r.capx_rate_solo ?? 0),
    capxRateMixed: Number(r.capx_rate_mixed ?? 0),
    serviceSourceRate: Number(r.service_source_rate ?? 0),
    rollingFloor: Number(r.rolling_floor ?? 0),
    overrideRate: Number(r.override_rate ?? 0),
    estimatedMarginRate: Number(r.estimated_margin_rate ?? 0.30),
    minMarginPercent: Number(r.min_margin_percent ?? 0.20),
    newCustomerShareFloor: Number(r.new_customer_share_floor ?? 0.10),
    newCustomerWindowMonths: Number(r.new_customer_window_months ?? 6),
    commissionConfigActive: Boolean(r.commission_config_active ?? true),
    sourceSystems: sourceSystemsByUserId.get(r.id) ?? [],
    localAuthStatus: getLocalAuthStatus(localAuthByUserId.get(r.id) ?? null),
    inviteSentAt: localAuthByUserId.get(r.id)?.inviteSentAt ?? null,
    inviteExpiresAt: localAuthByUserId.get(r.id)?.inviteExpiresAt ?? null,
    lastLoginAt: localAuthByUserId.get(r.id)?.lastLoginAt ?? null,
    failedLoginAttempts: localAuthByUserId.get(r.id)?.failedLoginAttempts ?? 0,
    lockedUntil: localAuthByUserId.get(r.id)?.lockedUntil ?? null,
    passwordChangedAt: localAuthByUserId.get(r.id)?.passwordChangedAt ?? null,
    revokedAt: localAuthByUserId.get(r.id)?.revokedAt ?? null,
    latestLocalAuthEvent: latestEventByUserId.get(r.id) ?? null,
  }));
}

export async function getUserLocalAuthEvents(userId: string) {
  const result = await db.execute<UserLocalAuthEventSqlRow>(sql`
    SELECT
      e.id,
      e.event_type,
      e.actor_user_id,
      e.metadata,
      e.created_at,
      actor.display_name AS actor_display_name
    FROM user_local_auth_events e
    LEFT JOIN users actor ON actor.id = e.actor_user_id
    WHERE e.user_id = ${userId}
    ORDER BY e.created_at DESC
    LIMIT 20
  `);

  const rows = rowsFromExecute(result);
  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    actorDisplayName: row.actor_display_name,
    metadata: row.metadata ?? null,
    createdAt: row.created_at,
  }));
}
