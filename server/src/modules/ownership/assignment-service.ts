import { and, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { companies, contacts, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;
type OwnershipActor = { id: string; role: string };
type OwnedTable = typeof companies | typeof contacts;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertDirectorOrAdmin(actor: OwnershipActor) {
  if (actor.role !== "admin" && actor.role !== "director") {
    throw new AppError(403, "Only directors and admins can reassign ownership");
  }
}

async function assertActiveOwner(tenantDb: TenantDb, ownerUserId: string) {
  if (!UUID_PATTERN.test(ownerUserId)) {
    throw new AppError(400, "ownerUserId must be a valid user id or null");
  }

  const [targetUser] = await tenantDb
    .select({ id: users.id, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, ownerUserId))
    .limit(1);

  if (!targetUser || !targetUser.isActive) {
    throw new AppError(400, "Owner must be an active CRM user");
  }
}

async function assignOwnerToSelf(tenantDb: TenantDb, table: OwnedTable, recordId: string, actor: OwnershipActor) {
  const [updated] = await tenantDb
    .update(table)
    .set({ ownerId: actor.id, updatedAt: new Date() })
    .where(and(eq(table.id, recordId), eq(table.isActive, true), isNull(table.ownerId)))
    .returning();

  if (updated) return updated;

  const [existing] = await tenantDb
    .select({ id: table.id, ownerId: table.ownerId, isActive: table.isActive })
    .from(table)
    .where(eq(table.id, recordId))
    .limit(1);

  if (!existing || !existing.isActive) {
    throw new AppError(404, "Record not found");
  }

  throw new AppError(409, "Record already has an owner");
}

async function reassignOwner(
  tenantDb: TenantDb,
  table: OwnedTable,
  recordId: string,
  ownerUserId: string | null,
  actor: OwnershipActor
) {
  assertDirectorOrAdmin(actor);

  if (ownerUserId !== null) {
    await assertActiveOwner(tenantDb, ownerUserId);
  }

  const [updated] = await tenantDb
    .update(table)
    .set({ ownerId: ownerUserId, updatedAt: new Date() })
    .where(and(eq(table.id, recordId), eq(table.isActive, true)))
    .returning();

  if (!updated) {
    throw new AppError(404, "Record not found");
  }

  return updated;
}

export function assignCompanyOwnerToSelf(tenantDb: TenantDb, companyId: string, actor: OwnershipActor) {
  return assignOwnerToSelf(tenantDb, companies, companyId, actor);
}

export function assignContactOwnerToSelf(tenantDb: TenantDb, contactId: string, actor: OwnershipActor) {
  return assignOwnerToSelf(tenantDb, contacts, contactId, actor);
}

export function reassignCompanyOwner(
  tenantDb: TenantDb,
  companyId: string,
  ownerUserId: string | null,
  actor: OwnershipActor
) {
  return reassignOwner(tenantDb, companies, companyId, ownerUserId, actor);
}

export function reassignContactOwner(
  tenantDb: TenantDb,
  contactId: string,
  ownerUserId: string | null,
  actor: OwnershipActor
) {
  return reassignOwner(tenantDb, contacts, contactId, ownerUserId, actor);
}
