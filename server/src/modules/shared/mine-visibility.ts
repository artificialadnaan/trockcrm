import { sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";

function requireSchemaValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} is unavailable in @trock-crm/shared/schema`);
  }
  return value;
}

function sqlIdentifier(name: string) {
  return sql.raw(`"${name.replace(/"/g, "\"\"")}"`);
}

export function buildDealMineVisibilityCondition(userId: string) {
  const activities = requireSchemaValue(schema.activities, "activities");
  const deals = requireSchemaValue(schema.deals, "deals");
  const dealSubscriptions = requireSchemaValue(schema.dealSubscriptions, "dealSubscriptions");
  return sql`(
    assigned_rep_id = ${userId}
    or created_by_user_id = ${userId}
    or exists (
      select 1
      from ${activities} a
      where a.deal_id = ${deals.id}
        and a.performed_by_user_id = ${userId}
    )
    or exists (
      select 1
      from ${dealSubscriptions} ds
      where ds.deal_id = ${deals.id}
        and ds.user_id = ${userId}
        and ds.deleted_at is null
    )
  )`;
}

export function buildAliasedDealMineVisibilityCondition(alias: string, userId: string) {
  const activities = requireSchemaValue(schema.activities, "activities");
  const dealSubscriptions = requireSchemaValue(schema.dealSubscriptions, "dealSubscriptions");
  const recordAlias = sqlIdentifier(alias);
  return sql`(
    ${recordAlias}.assigned_rep_id = ${userId}
    or ${recordAlias}.created_by_user_id = ${userId}
    or exists (
      select 1
      from ${activities} a
      where a.deal_id = ${recordAlias}.id
        and a.performed_by_user_id = ${userId}
    )
    or exists (
      select 1
      from ${dealSubscriptions} ds
      where ds.deal_id = ${recordAlias}.id
        and ds.user_id = ${userId}
        and ds.deleted_at is null
    )
  )`;
}

export function buildLeadMineVisibilityCondition(userId: string) {
  const activities = requireSchemaValue(schema.activities, "activities");
  const leads = requireSchemaValue(schema.leads, "leads");
  const leadSubscriptions = requireSchemaValue(schema.leadSubscriptions, "leadSubscriptions");
  return sql`(
    assigned_rep_id = ${userId}
    or created_by_user_id = ${userId}
    or exists (
      select 1
      from ${activities} a
      where a.lead_id = ${leads.id}
        and a.performed_by_user_id = ${userId}
    )
    or exists (
      select 1
      from ${leadSubscriptions} ls
      where ls.lead_id = ${leads.id}
        and ls.user_id = ${userId}
        and ls.deleted_at is null
    )
  )`;
}

export function buildAliasedLeadMineVisibilityCondition(alias: string, userId: string) {
  const activities = requireSchemaValue(schema.activities, "activities");
  const leadSubscriptions = requireSchemaValue(schema.leadSubscriptions, "leadSubscriptions");
  const recordAlias = sqlIdentifier(alias);
  return sql`(
    ${recordAlias}.assigned_rep_id = ${userId}
    or ${recordAlias}.created_by_user_id = ${userId}
    or exists (
      select 1
      from ${activities} a
      where a.lead_id = ${recordAlias}.id
        and a.performed_by_user_id = ${userId}
    )
    or exists (
      select 1
      from ${leadSubscriptions} ls
      where ls.lead_id = ${recordAlias}.id
        and ls.user_id = ${userId}
        and ls.deleted_at is null
    )
  )`;
}
