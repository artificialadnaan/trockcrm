import { SQL, sql } from "drizzle-orm";

function asSqlReference(reference: string | SQL): SQL {
  return typeof reference === "string" ? sql.raw(reference) : reference;
}

function asAlias(alias: string): SQL {
  return sql.raw(alias);
}

export function buildDealEmailLinkCondition(emailAlias: string, dealReference: string | SQL): SQL {
  const email = asAlias(emailAlias);
  const dealRef = asSqlReference(dealReference);

  return sql`(
    ${email}.deal_id = ${dealRef}
    OR (${email}.assigned_entity_type = 'deal' AND ${email}.assigned_entity_id = ${dealRef})
  )`;
}

export function buildDealEmailFollowupGapCondition(
  activityAlias: string,
  emailAlias: string,
  dealReference: string | SQL
): SQL {
  const activity = asAlias(activityAlias);
  const email = asAlias(emailAlias);
  const dealRef = asSqlReference(dealReference);

  return sql`NOT EXISTS (
    SELECT 1
    FROM activities ${activity}
    WHERE ${activity}.deal_id = ${dealRef}
      AND ${activity}.occurred_at >= ${email}.sent_at
      AND ${activity}.type IN ('call', 'email', 'meeting', 'note')
  )`;
}

export function buildCanonicalDealIdExpression(emailAlias: string): SQL {
  const email = asAlias(emailAlias);
  return sql`COALESCE(
    ${email}.deal_id,
    CASE
      WHEN ${email}.assigned_entity_type = 'deal' THEN ${email}.assigned_entity_id
      ELSE NULL
    END
  )`;
}
