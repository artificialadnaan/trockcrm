import { auditLog } from "@trock-crm/shared/schema";
import type { AuditAction, UserRole } from "@trock-crm/shared/types";
import type * as schema from "@trock-crm/shared/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  formatAuditFieldChanges,
  redactAuditFieldChangesForRole,
  type RawAuditFieldChange,
} from "./field-formatters.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type ActivityVisibilityScope = "internal" | "customer_safe" | "role_restricted";

export interface AuditActorUser {
  type: "user";
  userId: string;
  name: string;
  role: UserRole | string;
  impersonatorId?: string | null;
}

export interface AuditActorSystem {
  type: "system";
  systemProcess: string;
  userId?: string | null;
  name?: string | null;
  role?: UserRole | string | null;
  impersonatorId?: string | null;
}

export type AuditActor = AuditActorUser | AuditActorSystem;

export interface AuditEntity {
  tableName: string;
  entityType: "deal" | "lead";
  recordId: string;
  nameSnapshot: string;
  secondaryIdSnapshot?: string | null;
}

export interface AuditContext {
  actor: AuditActor;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface LogActivityInput {
  tenantDb: Pick<TenantDb, "insert">;
  actor: AuditActor;
  action: AuditAction;
  entity: AuditEntity;
  fieldChanges?: Record<string, RawAuditFieldChange> | null;
  visibilityScope?: ActivityVisibilityScope;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function buildAuditActorFromUser(input: {
  userId: string;
  name: string;
  role: UserRole | string;
  impersonatorId?: string | null;
}): AuditActorUser {
  return {
    type: "user",
    userId: input.userId,
    name: input.name,
    role: input.role,
    impersonatorId: input.impersonatorId ?? null,
  };
}

export function buildAuditActorFromSystem(input: {
  systemProcess: string;
  userId?: string | null;
  name?: string | null;
  role?: UserRole | string | null;
  impersonatorId?: string | null;
}): AuditActorSystem {
  return {
    type: "system",
    systemProcess: input.systemProcess,
    userId: input.userId ?? null,
    name: input.name ?? input.systemProcess,
    role: input.role ?? null,
    impersonatorId: input.impersonatorId ?? null,
  };
}

export function redactActivityForRole(
  input: { fieldChanges: Record<string, RawAuditFieldChange> | null | undefined },
  role: UserRole
) {
  return redactAuditFieldChangesForRole(
    formatAuditFieldChanges(input.fieldChanges ?? {}),
    role
  );
}

export async function logActivity(input: LogActivityInput): Promise<void> {
  const formattedChanges = formatAuditFieldChanges(input.fieldChanges ?? {});
  const actorName = input.actor.type === "system"
    ? input.actor.name ?? input.actor.systemProcess
    : input.actor.name;
  const actorRole = input.actor.role ?? null;
  const actorSystemProcess = input.actor.type === "system" ? input.actor.systemProcess : null;
  const changedBy = input.actor.userId ?? null;

  await input.tenantDb.insert(auditLog).values({
    tableName: input.entity.tableName,
    recordId: input.entity.recordId,
    action: input.action,
    changedBy,
    actorName,
    actorRole,
    actorSystemProcess,
    entityType: input.entity.entityType,
    entityNameSnapshot: input.entity.nameSnapshot,
    entitySecondaryIdSnapshot: input.entity.secondaryIdSnapshot ?? null,
    impersonatorId: input.actor.impersonatorId ?? null,
    changes: input.fieldChanges ?? null,
    fieldChangesJsonb: formattedChanges,
    fullRow: input.metadata ?? null,
    visibilityScope: input.visibilityScope ?? "internal",
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
}
