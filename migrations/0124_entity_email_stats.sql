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
        ALTER TABLE %I.companies
          ADD COLUMN IF NOT EXISTS email_count integer NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS last_email_at timestamptz;

        ALTER TABLE %I.leads
          ADD COLUMN IF NOT EXISTS email_count integer NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS last_email_at timestamptz;

        ALTER TABLE %I.deals
          ADD COLUMN IF NOT EXISTS email_count integer NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS last_email_at timestamptz;

        ALTER TABLE %I.contacts
          ADD COLUMN IF NOT EXISTS email_count integer NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS last_email_at timestamptz;
      $sql$,
      tenant_schema,
      tenant_schema,
      tenant_schema,
      tenant_schema
    );

    EXECUTE format(
      $sql$
        UPDATE %1$I.companies company
        SET
          email_count = stats.email_count,
          last_email_at = stats.last_email_at
        FROM (
          SELECT
            company_id,
            COUNT(*)::int AS email_count,
            MAX(sent_at) AS last_email_at
          FROM (
            SELECT
              CASE
                WHEN e.assigned_entity_type = 'company' THEN e.assigned_entity_id
                WHEN e.deal_id IS NOT NULL THEN d.company_id
                WHEN e.contact_id IS NOT NULL THEN c.company_id
                WHEN e.assigned_entity_type = 'deal' THEN ad.company_id
                WHEN e.assigned_entity_type = 'contact' THEN ac.company_id
                ELSE NULL
              END AS company_id,
              e.sent_at
            FROM %1$I.emails e
            LEFT JOIN %1$I.deals d ON d.id = e.deal_id
            LEFT JOIN %1$I.contacts c ON c.id = e.contact_id
            LEFT JOIN %1$I.deals ad ON ad.id = e.assigned_entity_id AND e.assigned_entity_type = 'deal'
            LEFT JOIN %1$I.contacts ac ON ac.id = e.assigned_entity_id AND e.assigned_entity_type = 'contact'
            WHERE e.assignment_status <> 'ignored'
          ) linked
          WHERE company_id IS NOT NULL
          GROUP BY company_id
        ) stats
        WHERE company.id = stats.company_id;

        UPDATE %1$I.companies
        SET email_count = 0, last_email_at = NULL
        WHERE id NOT IN (
          SELECT DISTINCT company_id
          FROM (
            SELECT
              CASE
                WHEN e.assigned_entity_type = 'company' THEN e.assigned_entity_id
                WHEN e.deal_id IS NOT NULL THEN d.company_id
                WHEN e.contact_id IS NOT NULL THEN c.company_id
                WHEN e.assigned_entity_type = 'deal' THEN ad.company_id
                WHEN e.assigned_entity_type = 'contact' THEN ac.company_id
                ELSE NULL
              END AS company_id
            FROM %1$I.emails e
            LEFT JOIN %1$I.deals d ON d.id = e.deal_id
            LEFT JOIN %1$I.contacts c ON c.id = e.contact_id
            LEFT JOIN %1$I.deals ad ON ad.id = e.assigned_entity_id AND e.assigned_entity_type = 'deal'
            LEFT JOIN %1$I.contacts ac ON ac.id = e.assigned_entity_id AND e.assigned_entity_type = 'contact'
            WHERE e.assignment_status <> 'ignored'
          ) linked
          WHERE company_id IS NOT NULL
        );

        UPDATE %1$I.deals deal
        SET
          email_count = stats.email_count,
          last_email_at = stats.last_email_at
        FROM (
          SELECT
            deal_id,
            COUNT(*)::int AS email_count,
            MAX(sent_at) AS last_email_at
          FROM (
            SELECT
              CASE
                WHEN e.assigned_entity_type = 'deal' THEN e.assigned_entity_id
                ELSE e.deal_id
              END AS deal_id,
              e.sent_at
            FROM %1$I.emails e
            WHERE e.assignment_status <> 'ignored'
          ) linked
          WHERE deal_id IS NOT NULL
          GROUP BY deal_id
        ) stats
        WHERE deal.id = stats.deal_id;

        UPDATE %1$I.deals
        SET email_count = 0, last_email_at = NULL
        WHERE id NOT IN (
          SELECT DISTINCT deal_id
          FROM (
            SELECT
              CASE
                WHEN e.assigned_entity_type = 'deal' THEN e.assigned_entity_id
                ELSE e.deal_id
              END AS deal_id
            FROM %1$I.emails e
            WHERE e.assignment_status <> 'ignored'
          ) linked
          WHERE deal_id IS NOT NULL
        );

        UPDATE %1$I.leads lead
        SET
          email_count = stats.email_count,
          last_email_at = stats.last_email_at
        FROM (
          SELECT
            e.assigned_entity_id AS lead_id,
            COUNT(*)::int AS email_count,
            MAX(e.sent_at) AS last_email_at
          FROM %1$I.emails e
          WHERE e.assignment_status <> 'ignored'
            AND e.assigned_entity_type = 'lead'
            AND e.assigned_entity_id IS NOT NULL
          GROUP BY e.assigned_entity_id
        ) stats
        WHERE lead.id = stats.lead_id;

        UPDATE %1$I.leads
        SET email_count = 0, last_email_at = NULL
        WHERE id NOT IN (
          SELECT DISTINCT e.assigned_entity_id
          FROM %1$I.emails e
          WHERE e.assignment_status <> 'ignored'
            AND e.assigned_entity_type = 'lead'
            AND e.assigned_entity_id IS NOT NULL
        );

        UPDATE %1$I.contacts contact
        SET
          email_count = stats.email_count,
          last_email_at = stats.last_email_at
        FROM (
          SELECT
            contact_id,
            COUNT(*)::int AS email_count,
            MAX(sent_at) AS last_email_at
          FROM (
            SELECT
              CASE
                WHEN e.assigned_entity_type = 'contact' THEN e.assigned_entity_id
                ELSE e.contact_id
              END AS contact_id,
              e.sent_at
            FROM %1$I.emails e
            WHERE e.assignment_status <> 'ignored'
          ) linked
          WHERE contact_id IS NOT NULL
          GROUP BY contact_id
        ) stats
        WHERE contact.id = stats.contact_id;

        UPDATE %1$I.contacts
        SET email_count = 0, last_email_at = NULL
        WHERE id NOT IN (
          SELECT DISTINCT contact_id
          FROM (
            SELECT
              CASE
                WHEN e.assigned_entity_type = 'contact' THEN e.assigned_entity_id
                ELSE e.contact_id
              END AS contact_id
            FROM %1$I.emails e
            WHERE e.assignment_status <> 'ignored'
          ) linked
          WHERE contact_id IS NOT NULL
        );
      $sql$,
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.companies
  ADD COLUMN IF NOT EXISTS email_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_email_at timestamptz;

ALTER TABLE office_dallas.leads
  ADD COLUMN IF NOT EXISTS email_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_email_at timestamptz;

ALTER TABLE office_dallas.deals
  ADD COLUMN IF NOT EXISTS email_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_email_at timestamptz;

ALTER TABLE office_dallas.contacts
  ADD COLUMN IF NOT EXISTS email_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_email_at timestamptz;
-- TENANT_SCHEMA_END
