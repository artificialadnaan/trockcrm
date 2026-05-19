import { sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";

type TenantDbLike = {
  execute?: (query: any) => PromiseLike<unknown> | unknown;
};

type MineVisibilityOptions = {
  includeSubscriptions?: boolean;
  includeCreatedBy?: boolean;
  includeSubscriptionDeletedAt?: boolean;
};

const schemaCapabilityCache = new WeakMap<object, Map<string, Promise<boolean>>>();

function requireSchemaValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} is unavailable in @trock-crm/shared/schema`);
  }
  return value;
}

function sqlIdentifier(name: string) {
  return sql.raw(`"${name.replace(/"/g, "\"\"")}"`);
}

function buildSqlOr(clauses: ReturnType<typeof sql>[]) {
  return sql.join(clauses, sql`\n    or `);
}

async function currentSchemaTableExists(tenantDb: TenantDbLike, tableName: string): Promise<boolean> {
  if (!tenantDb.execute) {
    return true;
  }

  return currentSchemaCapability(tenantDb, `table:${tableName}`, async () => {
    const result = await tenantDb.execute!(
      sql`SELECT to_regclass(current_schema() || '.' || ${tableName}) AS relation_name`
    );
    const rows = Array.isArray(result)
      ? result
      : (((result as { rows?: Array<{ relation_name?: string | null }> }).rows) ?? []);
    return rows[0]?.relation_name != null;
  });
}

async function currentSchemaColumnExists(
  tenantDb: TenantDbLike,
  tableName: string,
  columnName: string
): Promise<boolean> {
  if (!tenantDb.execute) {
    return true;
  }

  return currentSchemaCapability(tenantDb, `column:${tableName}.${columnName}`, async () => {
    const result = await tenantDb.execute!(sql`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ${tableName}
          AND column_name = ${columnName}
      ) AS column_exists
    `);
    const rows = Array.isArray(result)
      ? result
      : (((result as { rows?: Array<{ column_exists?: boolean | string | null }> }).rows) ?? []);
    return rows[0]?.column_exists === true || rows[0]?.column_exists === "t";
  });
}

async function currentSchemaCapability(
  tenantDb: TenantDbLike,
  key: string,
  loader: () => Promise<boolean>
) {
  const cacheKey = tenantDb as object;
  let entry = schemaCapabilityCache.get(cacheKey);
  if (!entry) {
    entry = new Map<string, Promise<boolean>>();
    schemaCapabilityCache.set(cacheKey, entry);
  }

  const existing = entry.get(key);
  if (existing) {
    return existing;
  }

  const promise = loader();

  entry.set(key, promise);
  return promise;
}

export async function resolveMineVisibilityFeatures(tenantDb: TenantDbLike) {
  // Sequential probes required: tenantDb uses a single-client transaction.
  // Parallel queries on that client trigger "client already executing" in production.
  const dealSubscriptions = await currentSchemaTableExists(tenantDb, "deal_subscriptions");
  const leadSubscriptions = await currentSchemaTableExists(tenantDb, "lead_subscriptions");
  const dealSubscriptionsDeletedAt = await currentSchemaColumnExists(
    tenantDb,
    "deal_subscriptions",
    "deleted_at"
  );
  const leadSubscriptionsDeletedAt = await currentSchemaColumnExists(
    tenantDb,
    "lead_subscriptions",
    "deleted_at"
  );
  const dealsCreatedByUserId = await currentSchemaColumnExists(
    tenantDb,
    "deals",
    "created_by_user_id"
  );
  const leadsCreatedByUserId = await currentSchemaColumnExists(
    tenantDb,
    "leads",
    "created_by_user_id"
  );

  return {
    dealSubscriptions,
    leadSubscriptions,
    dealSubscriptionsDeletedAt,
    leadSubscriptionsDeletedAt,
    dealsCreatedByUserId,
    leadsCreatedByUserId,
  };
}

export function buildDealMineVisibilityCondition(
  userId: string,
  options: MineVisibilityOptions = {}
) {
  const activities = requireSchemaValue(schema.activities, "activities");
  const deals = requireSchemaValue(schema.deals, "deals");
  const clauses = [
    sql`${deals.assignedRepId} = ${userId}`,
    sql`exists (
      select 1
      from ${activities} a
      where a.deal_id = ${deals.id}
        and a.performed_by_user_id = ${userId}
    )`,
  ];

  if (options.includeCreatedBy !== false) {
    clauses.unshift(sql`${deals.createdByUserId} = ${userId}`);
  }

  if (options.includeSubscriptions !== false) {
    const dealSubscriptions = requireSchemaValue(schema.dealSubscriptions, "dealSubscriptions");
    clauses.push(sql`exists (
      select 1
      from ${dealSubscriptions} ds
      where ds.deal_id = ${deals.id}
        and ds.user_id = ${userId}
        ${options.includeSubscriptionDeletedAt === false ? sql`` : sql`and ds.deleted_at is null`}
    )`);
  }

  return sql`(
    ${buildSqlOr(clauses)}
  )`;
}

export function buildAliasedDealMineVisibilityCondition(
  alias: string,
  userId: string,
  options: MineVisibilityOptions = {}
) {
  const activities = requireSchemaValue(schema.activities, "activities");
  const recordAlias = sqlIdentifier(alias);
  const clauses = [
    sql`${recordAlias}.assigned_rep_id = ${userId}`,
    sql`exists (
      select 1
      from ${activities} a
      where a.deal_id = ${recordAlias}.id
        and a.performed_by_user_id = ${userId}
    )`,
  ];

  if (options.includeCreatedBy !== false) {
    clauses.unshift(sql`${recordAlias}.created_by_user_id = ${userId}`);
  }

  if (options.includeSubscriptions !== false) {
    const dealSubscriptions = requireSchemaValue(schema.dealSubscriptions, "dealSubscriptions");
    clauses.push(sql`exists (
      select 1
      from ${dealSubscriptions} ds
      where ds.deal_id = ${recordAlias}.id
        and ds.user_id = ${userId}
        ${options.includeSubscriptionDeletedAt === false ? sql`` : sql`and ds.deleted_at is null`}
    )`);
  }

  return sql`(
    ${buildSqlOr(clauses)}
  )`;
}

export function buildLeadMineVisibilityCondition(
  userId: string,
  options: MineVisibilityOptions = {}
) {
  const activities = requireSchemaValue(schema.activities, "activities");
  const leads = requireSchemaValue(schema.leads, "leads");
  const clauses = [
    sql`${leads.assignedRepId} = ${userId}`,
    sql`exists (
      select 1
      from ${activities} a
      where a.lead_id = ${leads.id}
        and a.performed_by_user_id = ${userId}
    )`,
  ];

  if (options.includeCreatedBy !== false) {
    clauses.unshift(sql`${leads.createdByUserId} = ${userId}`);
  }

  if (options.includeSubscriptions !== false) {
    const leadSubscriptions = requireSchemaValue(schema.leadSubscriptions, "leadSubscriptions");
    clauses.push(sql`exists (
      select 1
      from ${leadSubscriptions} ls
      where ls.lead_id = ${leads.id}
        and ls.user_id = ${userId}
        ${options.includeSubscriptionDeletedAt === false ? sql`` : sql`and ls.deleted_at is null`}
    )`);
  }

  return sql`(
    ${buildSqlOr(clauses)}
  )`;
}

export function buildAliasedLeadMineVisibilityCondition(
  alias: string,
  userId: string,
  options: MineVisibilityOptions = {}
) {
  const activities = requireSchemaValue(schema.activities, "activities");
  const recordAlias = sqlIdentifier(alias);
  const clauses = [
    sql`${recordAlias}.assigned_rep_id = ${userId}`,
    sql`exists (
      select 1
      from ${activities} a
      where a.lead_id = ${recordAlias}.id
        and a.performed_by_user_id = ${userId}
    )`,
  ];

  if (options.includeCreatedBy !== false) {
    clauses.unshift(sql`${recordAlias}.created_by_user_id = ${userId}`);
  }

  if (options.includeSubscriptions !== false) {
    const leadSubscriptions = requireSchemaValue(schema.leadSubscriptions, "leadSubscriptions");
    clauses.push(sql`exists (
      select 1
      from ${leadSubscriptions} ls
      where ls.lead_id = ${recordAlias}.id
        and ls.user_id = ${userId}
        ${options.includeSubscriptionDeletedAt === false ? sql`` : sql`and ls.deleted_at is null`}
    )`);
  }

  return sql`(
    ${buildSqlOr(clauses)}
  )`;
}
