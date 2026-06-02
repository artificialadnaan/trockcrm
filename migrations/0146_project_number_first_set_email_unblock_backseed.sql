-- 0146_project_number_first_set_email_unblock_backseed.sql
--
-- FIX: the #498 back-seed (migration 0138) inserted a `project_number_first_set` audit marker
-- (transition='existing') for every deal that already had a project_number at deploy. The trigger
-- gated the email enqueue on the audit INSERT succeeding:
--
--     INSERT INTO ...audit_log (...) ON CONFLICT DO NOTHING RETURNING id INTO inserted_audit_id;
--     IF inserted_audit_id IS NULL THEN RETURN NEW;   -- <-- skipped the job_queue insert
--
-- and the dedup index is on record_id alone. So for any back-seeded (or previously-set) deal, a
-- genuine null->non-null assignment hit the conflict, inserted_audit_id came back NULL, and the
-- email was silently never enqueued.
--
-- This migration replaces ONLY the shared trigger function. The per-tenant
-- `deals_project_number_first_set_email_trg` triggers already point at it, so CREATE OR REPLACE
-- FUNCTION makes the fix live for every office_* schema with no trigger / index / back-seed changes
-- and no data migration. On an audit-INSERT conflict we now look up the EXISTING marker's id and
-- still enqueue. The public.project_number_first_set_email_receipts ledger (tenant_schema,
-- audit_log_id) plus the Resend idempotencyKey remain the real "exactly once" email guard (see
-- worker/src/jobs/project-number-email.ts), so a back-seeded deal sends on its next genuine
-- assignment and never duplicates.

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

  -- FIX: a pre-existing marker (the #498 back-seed `transition='existing'`, or a prior genuine
  -- first-set) must NOT block a real assignment. Reuse the existing marker's id and still enqueue;
  -- the receipts ledger is the email idempotency, so the deal sends once on its next real assignment
  -- and never duplicates on retries or repeated clear/re-set cycles.
  IF inserted_audit_id IS NULL THEN
    EXECUTE format(
      $sql$
        SELECT id
        FROM %I.audit_log
        WHERE table_name = 'deals'
          AND record_id = $1
          AND actor_system_process = 'project_number_first_set'
        ORDER BY id
        LIMIT 1
      $sql$,
      TG_TABLE_SCHEMA
    )
    INTO inserted_audit_id
    USING NEW.id;
  END IF;

  IF inserted_audit_id IS NULL THEN
    -- Unreachable in practice: a conflict can only fire on the first-set partial unique index (the
    -- only unique index on audit_log the trigger can violate), and the reuse-SELECT looks up that
    -- exact row by record_id. Surface it loudly if the invariant is ever broken, rather than
    -- silently skipping the notification.
    RAISE WARNING 'enqueue_project_number_first_set_email: no project_number_first_set audit marker resolvable for deal %, skipping notification enqueue', NEW.id;
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
