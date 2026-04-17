DO $$
DECLARE
  schema_name text;
BEGIN
  ALTER TYPE activity_source_entity ADD VALUE IF NOT EXISTS 'mailbox';

  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = nspname
          AND table_name = 'emails'
      )
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.email_thread_bindings (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         mailbox_account_id uuid NOT NULL,
         provider varchar(50) NOT NULL,
         provider_conversation_id varchar(500) NULL,
         normalized_subject varchar(500) NULL,
         participant_fingerprint varchar(500) NULL,
         deal_id uuid NULL,
         project_id uuid NULL,
         binding_source varchar(32) NOT NULL,
         confidence varchar(16) NOT NULL,
         assignment_reason varchar(255),
         provisional_until timestamptz NULL,
         created_by uuid NULL,
         updated_by uuid NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         detached_at timestamptz NULL,
         CONSTRAINT email_thread_bindings_single_target_chk CHECK (
           ((deal_id IS NOT NULL)::int + (project_id IS NOT NULL)::int) = 1
         ),
         CONSTRAINT email_thread_bindings_identity_chk CHECK (
           provider_conversation_id IS NOT NULL
           OR (normalized_subject IS NOT NULL AND participant_fingerprint IS NOT NULL)
         )
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_email_thread_bindings_active_conversation
         ON %I.email_thread_bindings (mailbox_account_id, provider, provider_conversation_id)
         WHERE detached_at IS NULL AND provider_conversation_id IS NOT NULL',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_email_thread_bindings_active_provisional
         ON %I.email_thread_bindings (mailbox_account_id, provider, normalized_subject, participant_fingerprint)
         WHERE detached_at IS NULL AND provider_conversation_id IS NULL',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.emails
         ADD COLUMN IF NOT EXISTS thread_binding_id uuid NULL',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.emails
         DROP CONSTRAINT IF EXISTS fk_emails_thread_binding',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.emails
         ADD CONSTRAINT fk_emails_thread_binding
         FOREIGN KEY (thread_binding_id)
         REFERENCES %I.email_thread_bindings(id)
         ON DELETE SET NULL',
      schema_name,
      schema_name
    );

    EXECUTE format(
      $sql$
      INSERT INTO %I.email_thread_bindings (
        mailbox_account_id,
        provider,
        provider_conversation_id,
        deal_id,
        binding_source,
        confidence,
        assignment_reason,
        created_at,
        updated_at
      )
      SELECT
        seeded.mailbox_account_id,
        'microsoft_graph',
        seeded.graph_conversation_id,
        seeded.deal_id,
        'migration_backfill',
        seeded.assignment_confidence,
        'backfilled_from_email_assignment',
        now(),
        now()
      FROM (
        SELECT
          ugt.id AS mailbox_account_id,
          e.graph_conversation_id,
          min(e.deal_id) AS deal_id,
          max(COALESCE(e.assignment_confidence, 'high')) AS assignment_confidence,
          count(DISTINCT e.deal_id) AS distinct_deal_count
        FROM %I.emails e
        JOIN public.user_graph_tokens ugt
          ON ugt.user_id = e.user_id
        WHERE e.graph_conversation_id IS NOT NULL
          AND e.deal_id IS NOT NULL
        GROUP BY ugt.id, e.graph_conversation_id
      ) seeded
      WHERE seeded.distinct_deal_count = 1
        AND NOT EXISTS (
          SELECT 1
          FROM %I.email_thread_bindings existing
          WHERE existing.mailbox_account_id = seeded.mailbox_account_id
            AND existing.provider = 'microsoft_graph'
            AND existing.provider_conversation_id = seeded.graph_conversation_id
            AND existing.detached_at IS NULL
        )
      $sql$,
      schema_name,
      schema_name,
      schema_name
    );
  END LOOP;
END $$;
