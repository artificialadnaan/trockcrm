import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export async function resolveTeamRepIds(
  tenantDb: TenantDb,
  userId: string,
  activeOfficeId: string | null
): Promise<string[]> {
  const conditions = [eq(users.reportsTo, userId), eq(users.isActive, true)];
  if (activeOfficeId) {
    conditions.push(eq(users.officeId, activeOfficeId));
  }

  const rows = await tenantDb
    .select({ id: users.id })
    .from(users)
    .where(and(...conditions));

  return rows.map((user) => user.id);
}
