import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { userOfficeAccess, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export async function resolveActiveOfficeUserIds(
  tenantDb: TenantDb,
  activeOfficeId: string
): Promise<string[]> {
  const primaryRows = await tenantDb
    .select({ id: users.id })
    .from(users)
    .where(eq(users.officeId, activeOfficeId));
  const accessRows = await tenantDb
    .select({ userId: userOfficeAccess.userId })
    .from(userOfficeAccess)
    .where(eq(userOfficeAccess.officeId, activeOfficeId));

  return Array.from(new Set([
    ...primaryRows.map((user) => user.id),
    ...accessRows.map((access) => access.userId),
  ]));
}

export async function resolveTeamRepIds(
  tenantDb: TenantDb,
  userId: string,
  activeOfficeId: string | null
): Promise<string[]> {
  const conditions = [eq(users.reportsTo, userId), eq(users.isActive, true)];
  if (activeOfficeId) {
    const activeOfficeUserIds = await resolveActiveOfficeUserIds(tenantDb, activeOfficeId);
    if (activeOfficeUserIds.length === 0) return [];
    conditions.push(inArray(users.id, activeOfficeUserIds));
  }

  const rows = await tenantDb
    .select({ id: users.id })
    .from(users)
    .where(and(...conditions));

  return rows.map((user) => user.id);
}
