import { eq, asc, and, sql } from "drizzle-orm";
import {
  users,
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

export async function listUsers(officeId?: string) {
  const rows = officeId
    ? await db.execute(sql`
        SELECT
          u.id,
          u.email,
          u.display_name,
          u.role,
          u.office_id,
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

export async function updateUser(
  id: string,
  input: Partial<{
    displayName: string;
    role: "admin" | "director" | "rep";
    officeId: string;
    isActive: boolean;
    notificationPrefs: Record<string, unknown>;
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
  if (input.isActive !== undefined) updates.isActive = input.isActive;
  if (input.notificationPrefs !== undefined) updates.notificationPrefs = input.notificationPrefs;

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, id))
    .returning();

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

export async function listActiveUsersWithOfficeAccess() {
  const result = await db.execute(sql`
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

  const rows = (result as any).rows ?? result;
  return rows.map((r: any) => ({
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
      u.is_active,
      o.name AS office_name,
      COUNT(uoa.office_id)::int AS extra_office_count
    FROM users u
    LEFT JOIN offices o ON o.id = u.office_id
    LEFT JOIN user_office_access uoa ON uoa.user_id = u.id
    GROUP BY u.id, u.email, u.display_name, u.role, u.office_id, u.is_active, o.name
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
    officeName: r.office_name,
    isActive: r.is_active,
    extraOfficeCount: Number(r.extra_office_count ?? 0),
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
