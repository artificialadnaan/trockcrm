DO $tenant$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    EXECUTE format(
      $sql$
        UPDATE %1$I.deals deal
        SET
          email_count = stats.email_count,
          last_email_at = stats.last_email_at
        FROM (
          SELECT
            d.id AS deal_id,
            COUNT(e.id)::int AS email_count,
            MAX(e.sent_at) AS last_email_at
          FROM %1$I.deals d
          LEFT JOIN %1$I.emails e
            ON e.assignment_status <> 'ignored'
           AND (
             (e.assigned_entity_type = 'deal' AND e.assigned_entity_id = d.id)
             OR e.deal_id = d.id
             OR (
               d.source_lead_id IS NOT NULL
               AND e.assigned_entity_type = 'lead'
               AND e.assigned_entity_id = d.source_lead_id
             )
           )
          GROUP BY d.id
        ) stats
        WHERE deal.id = stats.deal_id;
      $sql$,
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
UPDATE office_dallas.deals deal
SET
  email_count = stats.email_count,
  last_email_at = stats.last_email_at
FROM (
  SELECT
    d.id AS deal_id,
    COUNT(e.id)::int AS email_count,
    MAX(e.sent_at) AS last_email_at
  FROM office_dallas.deals d
  LEFT JOIN office_dallas.emails e
    ON e.assignment_status <> 'ignored'
   AND (
     (e.assigned_entity_type = 'deal' AND e.assigned_entity_id = d.id)
     OR e.deal_id = d.id
     OR (
       d.source_lead_id IS NOT NULL
       AND e.assigned_entity_type = 'lead'
       AND e.assigned_entity_id = d.source_lead_id
     )
   )
  GROUP BY d.id
) stats
WHERE deal.id = stats.deal_id;
-- TENANT_SCHEMA_END
