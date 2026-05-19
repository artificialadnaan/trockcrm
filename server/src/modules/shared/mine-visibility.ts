import { sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";

type TenantDbLike = {
  execute?: (query: any) => PromiseLike<unknown> | unknown;
};

type MineVisibilityOptions = {
  includeSubscriptions?: boolean;
};

const tableExistsCache = new WeakMap<object, Map<string, Promise<boolean>>>();

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

  const cacheKey = tenantDb as object;
  let entry = tableExistsCache.get(cacheKey);
  if (!entry) {
    entry = new Map<string, Promise<boolean>>();
    tableExistsCache.set(cacheKey, entry);
  }

  const existing = entry.get(tableName);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    try {
      const result = await tenantDb.execute!(
        sql`SELECT to_regclass(current_schema() || '.' || ${tableName}) AS relation_name`
      );
      const rows = Array.isArray(result)
        ? result
        : (((result as { rows?: Array<{ relation_name?: string | null }> }).rows) ?? []);
      return rows[0]?.relation_name != null;
    } catch {
      return true;
    }
  })();

  entry.set(tableName, promise);
  return promise;
}

export async function resolveMineVisibilityFeatures(tenantDb: TenantDbLike) {
  const [dealSubscriptions, leadSubscriptions] = await Promise.all([
    currentSchemaTableExists(tenantDb, "deal_subscriptions"),
    currentSchemaTableExists(tenantDb, "lead_subscriptions"),
  ]);

  return { dealSubscriptions, leadSubscriptions };
}

export function buildDealMineVisibilityCondition(
  userId: string,
  options: MineVisibilityOptions = {}
) {
  const activities = requireSchemaValue(schema.activities, "activities");
  const deals = requireSchemaValue(schema.deals, "deals");
  const clauses = [
    sql`assigned_rep_id = ${userId}`,
    sql`created_by_user_id = ${userId}`,
    sql`exists (
      select 1
      from ${activities} a
      where a.deal_id = ${deals.id}
        and a.performed_by_user_id = ${userId}
    )`,
  ];

  if (options.includeSubscriptions !== false) {
    const dealSubscriptions = requireSchemaValue(schema.dealSubscriptions, "dealSubscriptions");
    clauses.push(sql`exists (
      select 1
      from ${dealSubscriptions} ds
      where ds.deal_id = ${deals.id}
        and ds.user_id = ${userId}
        and ds.deleted_at is null
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
    sql`${recordAlias}.created_by_user_id = ${userId}`,
    sql`exists (
      select 1
      from ${activities} a
      where a.deal_id = ${recordAlias}.id
        and a.performed_by_user_id = ${userId}
    )`,
  ];

  if (options.includeSubscriptions !== false) {
    const dealSubscriptions = requireSchemaValue(schema.dealSubscriptions, "dealSubscriptions");
    clauses.push(sql`exists (
      select 1
      from ${dealSubscriptions} ds
      where ds.deal_id = ${recordAlias}.id
        and ds.user_id = ${userId}
        and ds.deleted_at is null
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
    sql`assigned_rep_id = ${userId}`,
    sql`created_by_user_id = ${userId}`,
    sql`exists (
      select 1
      from ${activities} a
      where a.lead_id = ${leads.id}
        and a.performed_by_user_id = ${userId}
    )`,
  ];

  if (options.includeSubscriptions !== false) {
    const leadSubscriptions = requireSchemaValue(schema.leadSubscriptions, "leadSubscriptions");
    clauses.push(sql`exists (
      select 1
      from ${leadSubscriptions} ls
      where ls.lead_id = ${leads.id}
        and ls.user_id = ${userId}
        and ls.deleted_at is null
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
    sql`${recordAlias}.created_by_user_id = ${userId}`,
    sql`exists (
      select 1
      from ${activities} a
      where a.lead_id = ${recordAlias}.id
        and a.performed_by_user_id = ${userId}
    )`,
  ];

  if (options.includeSubscriptions !== false) {
    const leadSubscriptions = requireSchemaValue(schema.leadSubscriptions, "leadSubscriptions");
    clauses.push(sql`exists (
      select 1
      from ${leadSubscriptions} ls
      where ls.lead_id = ${recordAlias}.id
        and ls.user_id = ${userId}
        and ls.deleted_at is null
    )`);
  }

  return sql`(
    ${buildSqlOr(clauses)}
  )`;
}
