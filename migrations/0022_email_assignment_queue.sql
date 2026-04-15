-- Migration 0022: Email assignment queue and persisted assignment metadata

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.emails
         ADD COLUMN IF NOT EXISTS assigned_entity_type varchar(20),
         ADD COLUMN IF NOT EXISTS assigned_entity_id uuid,
         ADD COLUMN IF NOT EXISTS assignment_confidence varchar(20),
         ADD COLUMN IF NOT EXISTS assignment_ambiguity_reason varchar(255)',
      schema_name
    );

    EXECUTE format(
      'UPDATE %I.emails e
         SET assigned_entity_type = CASE
               WHEN e.deal_id IS NOT NULL THEN ''deal''
               WHEN e.deal_id IS NULL AND c.company_id IS NOT NULL THEN ''company''
               ELSE e.assigned_entity_type
             END,
             assigned_entity_id = CASE
               WHEN e.deal_id IS NOT NULL THEN e.deal_id
               WHEN e.deal_id IS NULL AND c.company_id IS NOT NULL THEN c.company_id
               ELSE e.assigned_entity_id
             END,
             assignment_confidence = COALESCE(
               e.assignment_confidence,
               CASE
                 WHEN e.deal_id IS NOT NULL THEN ''high''
                 WHEN e.deal_id IS NULL AND c.company_id IS NOT NULL THEN ''low''
                 ELSE NULL
               END
             ),
             assignment_ambiguity_reason = COALESCE(
               e.assignment_ambiguity_reason,
               CASE
                 WHEN e.deal_id IS NULL AND c.company_id IS NOT NULL THEN ''legacy_company_only''
                 ELSE NULL
               END
             )
       FROM %I.contacts c
       WHERE c.id = e.contact_id',
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS emails_assignment_queue_idx
         ON %I.emails (direction, synced_at DESC)
         WHERE direction = ''inbound''
           AND (assignment_ambiguity_reason IS NOT NULL OR assigned_entity_type = ''company'')',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS emails_assigned_entity_idx
         ON %I.emails (assigned_entity_type, assigned_entity_id)',
      schema_name
    );
  END LOOP;
END $$;
