import { eq, asc, and, sql } from "drizzle-orm";
import { users, userOfficeAccess, offices } from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";

export async function listUsers(officeId?: string) {
  const rows = await db
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
  return rows.map((r: any) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    officeId: r.office_id,
    officeName: r.office_name,
    isActive: r.is_active,
    extraOfficeCount: Number(r.extra_office_count ?? 0),
  }));
}
