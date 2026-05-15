import { auditLog } from "@trock-crm/shared/schema";
import type { LogActivityInput } from "./audit-logger.js";
import { logActivity } from "./audit-logger.js";

export type PgActivityClient = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

const SAFE_TENANT_SCHEMA_PATTERN = /^office_[a-z][a-z0-9_]*$/;

export function quoteTenantSchema(schemaName: string): string {
  if (!SAFE_TENANT_SCHEMA_PATTERN.test(schemaName)) {
    throw new Error(`Unsafe tenant schema for audit logging: ${schemaName}`);
  }
  return `"${schemaName.replace(/"/g, '""')}"`;
}

function toJsonbParam(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function filterNoopFieldChanges(
  fieldChanges: LogActivityInput["fieldChanges"]
): LogActivityInput["fieldChanges"] {
  if (!fieldChanges) return fieldChanges;
  const filtered = Object.fromEntries(
    Object.entries(fieldChanges).filter(([, change]) => {
      const fromValue = change.from ?? null;
      const toValue = change.to ?? null;
      return !Object.is(fromValue, toValue);
    })
  );
  return Object.keys(filtered).length > 0 ? filtered : null;
}

export async function logActivityWithPgClient(input: Omit<LogActivityInput, "tenantDb"> & {
  client: PgActivityClient;
  schemaName: string;
}): Promise<void> {
  const schemaName = quoteTenantSchema(input.schemaName);
  const fieldChanges = filterNoopFieldChanges(input.fieldChanges);
  if (input.fieldChanges && !fieldChanges) return;
  const tenantDb = {
    insert(table: unknown) {
      if (table !== auditLog) {
        throw new Error("logActivityWithPgClient only supports audit_log inserts");
      }
      return {
        values: async (values: Record<string, unknown>) => {
          await input.client.query(
            `INSERT INTO ${schemaName}.audit_log
             (table_name, record_id, action, changed_by,
              actor_name, actor_role, actor_system_process,
              entity_type, entity_name_snapshot, entity_secondary_id_snapshot,
              impersonator_id, changes, field_changes_jsonb, full_row,
              visibility_scope, ip_address, user_agent)
             VALUES
             ($1, $2, $3, $4::uuid,
              $5, $6, $7,
              $8, $9, $10,
              $11::uuid, $12::jsonb, $13::jsonb, $14::jsonb,
              $15, $16::inet, $17)`,
            [
              values.tableName,
              values.recordId,
              values.action,
              values.changedBy,
              values.actorName,
              values.actorRole,
              values.actorSystemProcess,
              values.entityType,
              values.entityNameSnapshot,
              values.entitySecondaryIdSnapshot,
              values.impersonatorId,
              toJsonbParam(values.changes),
              toJsonbParam(values.fieldChangesJsonb),
              toJsonbParam(values.fullRow),
              values.visibilityScope,
              values.ipAddress,
              values.userAgent,
            ]
          );
          return [];
        },
      };
    },
  };

  await logActivity({
    tenantDb: tenantDb as never,
    actor: input.actor,
    action: input.action,
    entity: input.entity,
    fieldChanges,
    visibilityScope: input.visibilityScope,
    metadata: input.metadata,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
}
