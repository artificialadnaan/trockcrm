import { and, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { companies, contacts, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { isCrmUserRole } from "../../middleware/field-auth.js";
import { listUsers } from "../admin/users-service.js";

type TenantDb = NodePgDatabase<typeof schema>;
type OwnershipActor = { id: string; role: string; activeOfficeId?: string | null; officeId?: string | null };
type OwnedTable = typeof companies | typeof contacts;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, fieldName: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError(400, `${fieldName} must be a valid UUID`);
  }
}

function isDirectorOrAdmin(actor: OwnershipActor) {
  return actor.role === "admin" || actor.role === "director";
}

function getActorOfficeId(actor: OwnershipActor) {
  const officeId = actor.activeOfficeId ?? actor.officeId;
  if (!officeId) {
    throw new AppError(400, "Office context is required to reassign ownership");
  }
  return officeId;
}

async function assertActiveCrmOwner(tenantDb: TenantDb, ownerUserId: string) {
  assertUuid(ownerUserId, "ownerUserId");

  const [targetUser] = await tenantDb
    .select({ id: users.id, isActive: users.isActive, role: users.role })
    .from(users)
    .where(eq(users.id, ownerUserId))
    .limit(1);

  if (!targetUser || !targetUser.isActive || !isCrmUserRole(targetUser.role)) {
    throw new AppError(400, "Owner must be an active CRM user");
  }
}

async function assertActiveOwnerInOffice(tenantDb: TenantDb, ownerUserId: string, officeId: string) {
  await assertActiveCrmOwner(tenantDb, ownerUserId);

  const assignableUsers = await listUsers(officeId);
  if (!assignableUsers.some((user: { id: string; isActive: boolean }) => user.id === ownerUserId && user.isActive)) {
    throw new AppError(400, "Owner must be active in the current office");
  }
}

async function assignOwnerToSelf(tenantDb: TenantDb, table: OwnedTable, recordId: string, actor: OwnershipActor) {
  assertUuid(recordId, "recordId");

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
  assertUuid(recordId, "recordId");

  if (isDirectorOrAdmin(actor)) {
    if (ownerUserId !== null) {
      await assertActiveOwnerInOffice(tenantDb, ownerUserId, getActorOfficeId(actor));
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

  if (ownerUserId === null) {
    throw new AppError(400, "Owner-initiated reassignment requires an active owner");
  }

  const [existing] = await tenantDb
    .select({ id: table.id, ownerId: table.ownerId, isActive: table.isActive })
    .from(table)
    .where(eq(table.id, recordId))
    .limit(1);

  if (!existing || !existing.isActive) {
    throw new AppError(404, "Record not found");
  }

  if (existing.ownerId !== actor.id) {
    throw new AppError(403, "Only the current owner can reassign this record");
  }

  // Owner-initiated handoff intentionally allows cross-office targets. This is
  // separate from the admin/director path above, which remains office-scoped.
  await assertActiveCrmOwner(tenantDb, ownerUserId);

  const [updated] = await tenantDb
    .update(table)
    .set({ ownerId: ownerUserId, updatedAt: new Date() })
    .where(and(eq(table.id, recordId), eq(table.isActive, true), eq(table.ownerId, actor.id)))
    .returning();

  if (!updated) {
    throw new AppError(409, "Record ownership changed; refresh before reassigning");
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
