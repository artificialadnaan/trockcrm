-- 0138_project_number_first_set_notification.sql
-- For existing tenants, server/src/migrations/runner.ts pre-creates the
-- audit_log_project_number_first_set_uidx index CONCURRENTLY before executing
-- this file, so the `CREATE UNIQUE INDEX IF NOT EXISTS` statements below become
-- no-ops on existing tenants (the audit_log scan happens once, without holding a
-- write lock). For newly-provisioned tenants the audit_log is empty, so the plain
-- CREATE UNIQUE INDEX inside the DO block / TENANT_SCHEMA_START block is safe.

CREATE OR REPLACE FUNCTION public.enqueue_project_number_first_set_email()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  new_project_number text;
  old_project_number text;
  actor_user_id uuid;
  inserted_audit_id bigint;
BEGIN
  new_project_number := NULLIF(BTRIM(NEW.project_number), '');
  IF new_project_number IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_project_number := NULLIF(BTRIM(OLD.project_number), '');
    IF old_project_number IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  IF lower(coalesce(current_setting('app.skip_project_number_email', true), '')) IN ('1', 'true', 'yes', 'on') THEN
    RETURN NEW;
  END IF;

  BEGIN
    actor_user_id := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    actor_user_id := NULL;
  END;

  EXECUTE format(
    $sql$
      INSERT INTO %I.audit_log (
        table_name,
        record_id,
        action,
        changed_by,
        actor_system_process,
        entity_type,
        entity_name_snapshot,
        entity_secondary_id_snapshot,
        field_changes_jsonb,
        changes,
        visibility_scope
      )
      VALUES (
        'deals',
        $1,
        'update'::public.audit_action,
        $2,
        'project_number_first_set',
        'deal',
        $3,
        $4,
        jsonb_build_array(jsonb_build_object(
          'key', 'projectNumber',
          'label', 'Project Number',
          'fromDisplay', NULL,
          'toDisplay', $4,
          'fromFull', NULL,
          'toFull', $4,
          'transition', 'set',
          'masked', false
        )),
        jsonb_build_object('projectNumber', jsonb_build_object('from', NULL, 'to', $4)),
        'internal'
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    $sql$,
    TG_TABLE_SCHEMA
  )
  INTO inserted_audit_id
  USING NEW.id, actor_user_id, NEW.name, new_project_number;

  IF inserted_audit_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
  VALUES (
    'project_number_first_set_email',
    jsonb_build_object(
      'tenantSchema', TG_TABLE_SCHEMA,
      'dealId', NEW.id,
      'projectNumber', new_project_number,
      'auditLogId', inserted_audit_id
    ),
    NULL,
    'pending',
    NOW()
  );

  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.project_number_first_set_email_receipts (
  tenant_schema text NOT NULL,
  audit_log_id bigint NOT NULL,
  deal_id uuid NOT NULL,
  project_number text NOT NULL,
  recipient_email text,
  resend_message_id text,
  sent_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE public.project_number_first_set_email_receipts
  DROP CONSTRAINT IF EXISTS project_number_first_set_email_receipts_pkey;

DO $receipt_pk$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.project_number_first_set_email_receipts'::regclass
      AND conname = 'project_number_first_set_email_receipts_pkey'
  ) THEN
    ALTER TABLE public.project_number_first_set_email_receipts
      ADD CONSTRAINT project_number_first_set_email_receipts_pkey PRIMARY KEY (tenant_schema, audit_log_id);
  END IF;
END
$receipt_pk$;

CREATE INDEX IF NOT EXISTS project_number_first_set_email_receipts_deal_idx
  ON public.project_number_first_set_email_receipts (tenant_schema, deal_id);

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
        CREATE UNIQUE INDEX IF NOT EXISTS audit_log_project_number_first_set_uidx
          ON %I.audit_log (record_id)
          WHERE table_name = 'deals'
            AND actor_system_process = 'project_number_first_set';

        INSERT INTO %I.audit_log (
          table_name,
          record_id,
          action,
          changed_by,
          actor_system_process,
          entity_type,
          entity_name_snapshot,
          entity_secondary_id_snapshot,
          field_changes_jsonb,
          changes,
          visibility_scope
        )
        SELECT
          'deals',
          d.id,
          'update'::public.audit_action,
          NULL,
          'project_number_first_set',
          'deal',
          d.name,
          NULLIF(BTRIM(d.project_number), ''),
          jsonb_build_array(jsonb_build_object(
            'key', 'projectNumber',
            'label', 'Project Number',
            'fromDisplay', NULL,
            'toDisplay', NULLIF(BTRIM(d.project_number), ''),
            'fromFull', NULL,
            'toFull', NULLIF(BTRIM(d.project_number), ''),
            'transition', 'existing',
            'masked', false
          )),
          jsonb_build_object('projectNumber', jsonb_build_object('from', NULL, 'to', NULLIF(BTRIM(d.project_number), ''))),
          'internal'
        FROM %I.deals d
        WHERE NULLIF(BTRIM(d.project_number), '') IS NOT NULL
        ON CONFLICT DO NOTHING;

        DROP TRIGGER IF EXISTS deals_project_number_first_set_email_trg ON %I.deals;

        CREATE TRIGGER deals_project_number_first_set_email_trg
          AFTER INSERT OR UPDATE OF project_number ON %I.deals
          FOR EACH ROW
          EXECUTE FUNCTION public.enqueue_project_number_first_set_email();
      $sql$,
      tenant_schema,
      tenant_schema,
      tenant_schema,
      tenant_schema,
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_project_number_first_set_uidx
  ON office_dallas.audit_log (record_id)
  WHERE table_name = 'deals'
    AND actor_system_process = 'project_number_first_set';

INSERT INTO office_dallas.audit_log (
  table_name,
  record_id,
  action,
  changed_by,
  actor_system_process,
  entity_type,
  entity_name_snapshot,
  entity_secondary_id_snapshot,
  field_changes_jsonb,
  changes,
  visibility_scope
)
SELECT
  'deals',
  d.id,
  'update'::public.audit_action,
  NULL,
  'project_number_first_set',
  'deal',
  d.name,
  NULLIF(BTRIM(d.project_number), ''),
  jsonb_build_array(jsonb_build_object(
    'key', 'projectNumber',
    'label', 'Project Number',
    'fromDisplay', NULL,
    'toDisplay', NULLIF(BTRIM(d.project_number), ''),
    'fromFull', NULL,
    'toFull', NULLIF(BTRIM(d.project_number), ''),
    'transition', 'existing',
    'masked', false
  )),
  jsonb_build_object('projectNumber', jsonb_build_object('from', NULL, 'to', NULLIF(BTRIM(d.project_number), ''))),
  'internal'
FROM office_dallas.deals d
WHERE NULLIF(BTRIM(d.project_number), '') IS NOT NULL
ON CONFLICT DO NOTHING;

DROP TRIGGER IF EXISTS deals_project_number_first_set_email_trg ON office_dallas.deals;

CREATE TRIGGER deals_project_number_first_set_email_trg
  AFTER INSERT OR UPDATE OF project_number ON office_dallas.deals
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_project_number_first_set_email();
-- TENANT_SCHEMA_END
