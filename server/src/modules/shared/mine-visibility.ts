import { sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";
import { aliasedEffectiveOnHoldConditionSql } from "./deal-value-sql.js";
import { readTenantSchemaTag } from "./tenant-schema.js";

type TenantDbLike = {
  execute?: (query: any) => PromiseLike<unknown> | unknown;
};

type MineVisibilityOptions = {
  includeSubscriptions?: boolean;
  includeCreatedBy?: boolean;
  includeSubscriptionDeletedAt?: boolean;
};

/**
 * Per-INSTANCE fallback for a db that carries no office-schema tag (unit tests, the worker, a direct
 * `drizzle(pool)`). Behaviour is exactly what this file has always had for those callers.
 */
const schemaCapabilityCache = new WeakMap<object, Map<string, Promise<boolean>>>();

/**
 * Per-OFFICE cache, which is the one that actually works in production.
 *
 * The instance cache above cannot hit under the API: `tenantMiddleware` builds a fresh
 * `drizzle(client)` per request, so every request arrived with a brand-new WeakMap key and re-ran all
 * six catalog probes (two `to_regclass`, four `information_schema.columns`) before it could even build
 * the Mine predicate. On the deals board that is six extra round trips on the single tenant client,
 * every load, for answers that change only when a MIGRATION runs.
 *
 * Keyed on the office schema name published by tenant.ts. TTL'd rather than permanent because migrations
 * run at API start but new offices are provisioned while the process is live — a bounded staleness window
 * keeps a freshly-provisioned schema from being pinned to a stale "capability missing" answer, which
 * would silently NARROW a Mine-scoped board instead of failing loudly.
 */
const SCHEMA_CAPABILITY_TTL_MS = 5 * 60 * 1000;
type CapabilityEntry = { promise: Promise<boolean>; expiresAt: number };
const officeCapabilityCache = new Map<string, Map<string, CapabilityEntry>>();

/** Test/ops hook: drop every cached capability answer (e.g. after provisioning or a migration). */
export function resetSchemaCapabilityCache(): void {
  officeCapabilityCache.clear();
}

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
  const officeSchema = readTenantSchemaTag(tenantDb);
  if (officeSchema == null) {
    return instanceScopedCapability(tenantDb, key, loader);
  }

  let entry = officeCapabilityCache.get(officeSchema);
  if (!entry) {
    entry = new Map<string, CapabilityEntry>();
    officeCapabilityCache.set(officeSchema, entry);
  }

  const existing = entry.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    return existing.promise;
  }

  const promise = loader();
  entry.set(key, { promise, expiresAt: Date.now() + SCHEMA_CAPABILITY_TTL_MS });
  // A FAILED probe must not be cached. The previous per-instance cache stored the promise itself, so a
  // rejection was memoised too — harmless there only because the instance died with the request. In a
  // process-wide cache a single transient error would pin the failure for the whole TTL and, once the
  // caller swallowed it, quietly answer "capability missing" for every request in that window.
  promise.catch(() => {
    if (entry!.get(key)?.promise === promise) entry!.delete(key);
  });
  return promise;
}

async function instanceScopedCapability(
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

// The "Watched" scope predicate = the deal_subscriptions EXISTS clause IN ISOLATION (NOT a 4th OR-arm
// on the Mine builder: Mine's assigned_rep + activity clauses are unconditional, so reusing it would
// over-broaden Watched). Mirrors the subscription clause used by buildDealMineVisibilityCondition.
export function buildDealWatchedCondition(
  userId: string,
  options: { includeSubscriptionDeletedAt?: boolean } = {}
) {
  const deals = requireSchemaValue(schema.deals, "deals");
  const dealSubscriptions = requireSchemaValue(schema.dealSubscriptions, "dealSubscriptions");
  return sql`exists (
    select 1
    from ${dealSubscriptions} ds
    where ds.deal_id = ${deals.id}
      and ds.user_id = ${userId}
      ${options.includeSubscriptionDeletedAt === false ? sql`` : sql`and ds.deleted_at is null`}
  )`;
}

export function buildAliasedDealWatchedCondition(
  alias: string,
  userId: string,
  options: { includeSubscriptionDeletedAt?: boolean } = {}
) {
  const recordAlias = sqlIdentifier(alias);
  const dealSubscriptions = requireSchemaValue(schema.dealSubscriptions, "dealSubscriptions");
  return sql`exists (
    select 1
    from ${dealSubscriptions} ds
    where ds.deal_id = ${recordAlias}.id
      and ds.user_id = ${userId}
      ${options.includeSubscriptionDeletedAt === false ? sql`` : sql`and ds.deleted_at is null`}
  )`;
}

// The "On Hold" scope predicate = effectively on hold: the stored `on_hold` flag OR — for an OPEN
// (non-terminal) deal — a hold horizon date far enough out (CLOSE_TARGET_HOLD_HORIZON_DAYS+ CT-days) to
// read as parked. That horizon is the close target everywhere except the genuine 'estimating' stage, where
// the shared predicate measures from `bid_due_date` instead (2026-07-27). TERMINAL-AWARE: a won/lost deal is realized/preserved, never auto-parked by a stale forecast date
// (only its stored flag holds it), so the caller passes `terminalStageIds` (won ∪ lost) to exempt those
// rows — matching the value-zeroing helpers and the TS isDealEffectivelyOnHold twin, so the pill, the $
// math, and the card $0 can never disagree. TWO independent terminal signals gate that leg and only ONE of
// them is caller-supplied: `terminalStageIds` covers the CRM `stage_id`, while a terminal
// `bid_board_stage_slug` is ALWAYS excluded inside aliasedEffectiveOnHoldConditionSql. So `[]` (the default)
// does not mean "no terminal exemption" — it means "this population has no CRM-terminal rows to exempt", and
// a Bid Board-mirrored terminal deal stays exempt either way. Unlike Watched
// there is NO optional table, so NO capability gate is needed
// (`on_hold`/`expected_close_date`/`bid_due_date`/`stage_id` are base deal columns). `identifierPath` qualifies the columns to the query's deals relation ("deals") or
// its alias ("d"); the shared builder regex-validates it.
export function buildDealOnHoldCondition(identifierPath = "deals", terminalStageIds: string[] = []) {
  return aliasedEffectiveOnHoldConditionSql(identifierPath, terminalStageIds);
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
