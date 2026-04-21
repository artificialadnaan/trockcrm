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
import {
  getLocalAuthStatus,
  type LocalAuthStatus,
} from "../auth/local-auth-service.js";

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

export async function listUsers(officeId?: string) {
  const rows = await db
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
    .where(officeId ? eq(users.officeId, officeId) : undefined)
    .orderBy(asc(users.displayName));

  return rows;
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

export async function updateUser(
  id: string,
  input: Partial<{
    displayName: string;
    role: "admin" | "director" | "rep";
    officeId: string;
    reportsTo: string | null;
    isActive: boolean;
    notificationPrefs: Record<string, unknown>;
    commissionRate: number;
    rollingFloor: number;
    overrideRate: number;
    estimatedMarginRate: number;
    minMarginPercent: number;
    newCustomerShareFloor: number;
    newCustomerWindowMonths: number;
    commissionConfigActive: boolean;
  }>
) {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  if (!existing[0]) throw new AppError(404, "User not found");

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.displayName !== undefined) updates.displayName = input.displayName;
  if (input.role !== undefined) updates.role = input.role;
  if (input.officeId !== undefined) updates.officeId = input.officeId;
  if (input.reportsTo !== undefined) updates.reportsTo = input.reportsTo;
  if (input.isActive !== undefined) updates.isActive = input.isActive;
  if (input.notificationPrefs !== undefined) updates.notificationPrefs = input.notificationPrefs;

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, id))
    .returning();

  const hasCommissionPatch =
    input.commissionRate !== undefined ||
    input.rollingFloor !== undefined ||
    input.overrideRate !== undefined ||
    input.estimatedMarginRate !== undefined ||
    input.minMarginPercent !== undefined ||
    input.newCustomerShareFloor !== undefined ||
    input.newCustomerWindowMonths !== undefined ||
    input.commissionConfigActive !== undefined;

  if (hasCommissionPatch) {
    const existingConfig = await db
      .select()
      .from(userCommissionSettings)
      .where(eq(userCommissionSettings.userId, id))
      .limit(1);
    const current = existingConfig[0];

    const commissionRate = input.commissionRate ?? Number(current?.commissionRate ?? 0);
    const rollingFloor = input.rollingFloor ?? Number(current?.rollingFloor ?? 0);
    const overrideRate = input.overrideRate ?? Number(current?.overrideRate ?? 0);
    const estimatedMarginRate = input.estimatedMarginRate ?? Number(current?.estimatedMarginRate ?? 0.3);
    const minMarginPercent = input.minMarginPercent ?? Number(current?.minMarginPercent ?? 0.2);
    const newCustomerShareFloor = input.newCustomerShareFloor ?? Number(current?.newCustomerShareFloor ?? 0.1);
    const newCustomerWindowMonths = input.newCustomerWindowMonths ?? Number(current?.newCustomerWindowMonths ?? 6);
    const isActive = input.commissionConfigActive ?? Boolean(current?.isActive ?? true);

    assertRate("commissionRate", commissionRate);
    assertNonNegative("rollingFloor", rollingFloor);
    assertRate("overrideRate", overrideRate);
    assertRate("estimatedMarginRate", estimatedMarginRate);
    assertRate("minMarginPercent", minMarginPercent);
    assertRate("newCustomerShareFloor", newCustomerShareFloor);
    assertPositiveInteger("newCustomerWindowMonths", newCustomerWindowMonths);

    await db
      .insert(userCommissionSettings)
      .values({
        userId: id,
        commissionRate: String(commissionRate),
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
  }

  return updated;
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
    rollingFloor: Number(r.rolling_floor ?? 0),
    overrideRate: Number(r.override_rate ?? 0),
    estimatedMarginRate: Number(r.estimated_margin_rate ?? 0.30),
    minMarginPercent: Number(r.min_margin_percent ?? 0.20),
    newCustomerShareFloor: Number(r.new_customer_share_floor ?? 0.10),
    newCustomerWindowMonths: Number(r.new_customer_window_months ?? 6),
    commissionConfigActive: Boolean(r.commission_config_active ?? false),
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
  const result = await db.execute(sql`
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

  const rows = (result as any).rows ?? result;
  return rows.map((row: any) => ({
    id: row.id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    actorDisplayName: row.actor_display_name,
    metadata: row.metadata ?? null,
    createdAt: row.created_at,
  }));
}
