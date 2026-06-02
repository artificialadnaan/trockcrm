-- 0147_deal_opportunity_first_entry_email.sql
--
-- Re-key the Christy/Adnaan "project number assigned" notification to fire on a deal's FIRST entry
-- into the Opportunity stage, carrying deal_number (the operative business "project number").
--
-- WHY: the original notification (migration 0138/0146) fired on `project_number` going null->non-null.
-- `project_number` is an operator-assigned column with no UI that is effectively never set, so the
-- email almost never fired. The real business event is "a deal becomes a real Opportunity" — which is
-- exactly when its deal_number is meaningful — reached by BOTH genuine CRM creation paths:
--   (1) New Service Opportunity button  -> createDeal INSERT born in the Opportunity stage;
--   (2) lead conversion                 -> createDeal INSERT born in the Opportunity stage;
-- and also reachable by a later stage move into Opportunity. So this trigger fires on
-- `AFTER INSERT OR UPDATE OF stage_id`, mirroring the existing record_stage_history() backstop
-- (migration 0143), and reads NEW.deal_number (NOT NULL by schema, present at both INSERT and UPDATE).
--
-- DESIGN INVARIANTS (see PR for the adversarial review that locked these):
--   * First entry ONLY. The dedup marker is keyed on `record_id` ALONE (one marker per deal, forever),
--     so a deal that leaves and re-enters Opportunity (e.g. a director backward move) can never mint a
--     NEW notification id. On a marker conflict we reuse the existing id and still enqueue; the
--     receipts ledger (public.deal_opportunity_first_entry_email_receipts, keyed
--     (tenant_schema, audit_log_id)) + the Resend idempotencyKey are the real exactly-once guard, so a
--     re-entry re-enqueues with the SAME id and the worker collapses it to a no-op. This is safe ONLY
--     because the dedup is record_id-alone — do NOT widen the index with stage_entered_at / any
--     per-entry column, and do NOT add an event-type filter to the reuse-SELECT.
--   * CRM-genuine ONLY. The origin guard requires created_by_user_id IS NOT NULL — the positive
--     "an app user created this deal" signal, set by both genuine paths. SyncHub/Procore/HubSpot-import
--     /legacy deals leave it NULL and do NOT email. (source_lead_id is deliberately NOT used: migrations
--     0026/0027 synthesize it on imported deals, so it is not a safe CRM-origin signal.)
--   * NO-SEED. This migration does NOT back-seed markers for deals already in Opportunity. That avoids
--     re-creating the #498/#602 suppression trap, and the historical cohort is covered by the one-time
--     backfill report instead. A pre-existing Opportunity deal only notifies if it makes a genuine new
--     first entry, which the record_id marker still guards.
--
-- This is ADDITIVE: the prior project_number trigger (0138/0146) is left intact and dormant
-- (project_number is operator-assigned and effectively unused). The new opportunity-entry trigger is
-- the one that fires in normal CRM flows.
--
-- The per-tenant marker index below is a PARTIAL unique index on
-- actor_system_process='deal_opportunity_first_entry'. Under the NO-SEED posture zero rows match, so
-- the index itself is empty and the build is fast. Note the (non-concurrent) CREATE UNIQUE INDEX still
-- scans the audit_log heap to evaluate the predicate and holds a brief SHARE lock — concurrent SELECTs
-- proceed, but concurrent audit_log writes (i.e. deal mutations) block for the scan's duration. That
-- window is short on this CRM's audit_log and strictly cheaper than 0138 (which additionally
-- back-seeded under lock), so no CONCURRENTLY pre-create is wired for 0147. New tenants get an empty
-- audit_log, so the build is a true no-op there.

CREATE OR REPLACE FUNCTION public.enqueue_deal_opportunity_first_entry_email()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_opportunity_stage_id uuid;
  new_deal_number text;
  actor_user_id uuid;
  inserted_audit_id bigint;
BEGIN
  -- Resolve the single, globally-unique Opportunity stage id from the SHARED public config.
  -- pipeline_stage_config.slug is UNIQUE, so there is exactly one 'opportunity' row and one stage id,
  -- identical across every tenant and workflow route. (record_stage_history() reads this same shared
  -- table inside the trigger — see migration 0143.)
  SELECT id INTO v_opportunity_stage_id
  FROM public.pipeline_stage_config
  WHERE slug = 'opportunity';

  IF v_opportunity_stage_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only act when the deal is now in Opportunity.
  IF NEW.stage_id IS DISTINCT FROM v_opportunity_stage_id THEN
    RETURN NEW;
  END IF;

  -- On UPDATE, only act on a FRESH entry into Opportunity. If the deal was already in Opportunity
  -- (a no-op stage write, or some other column changed), it did not just enter -> skip. First-entry-
  -- ONLY across the deal's lifetime is still enforced by the record_id-alone marker below; this guard
  -- only avoids needless re-enqueues for non-entry updates.
  IF TG_OP = 'UPDATE' AND OLD.stage_id IS NOT DISTINCT FROM v_opportunity_stage_id THEN
    RETURN NEW;
  END IF;

  -- CRM-genuine origin guard: require created_by_user_id — the positive "an app user created this
  -- deal" signal. BOTH genuine paths set it going forward (New Service Opportunity and lead conversion
  -- both pass actorUserId to createDeal: service.ts createDeal -> created_by_user_id, and
  -- conversion-service passes actorUserId AND source_lead_id). It is immune to the import/sync trap:
  -- SyncHub/Procore mirror-creates and HubSpot/legacy imports leave created_by_user_id NULL. We do NOT
  -- also accept source_lead_id, because migrations 0026/0027 synthesize source_lead_id onto imported /
  -- legacy deals, so a non-null source_lead_id is NOT a reliable CRM-origin signal. The only deals
  -- excluded are pre-0128 rows created before the created_by_user_id column existed (2026-05-19) — and
  -- excluding those is correct: they predate this notification and are covered by the backfill report.
  IF NEW.created_by_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- deal_number is NOT NULL + UNIQUE by schema; guard defensively and carry it as the operative number.
  new_deal_number := NULLIF(BTRIM(NEW.deal_number), '');
  IF new_deal_number IS NULL THEN
    RETURN NEW;
  END IF;

  -- Bulk-script / migration escape hatch (mirrors app.skip_project_number_email on the 0138 trigger).
  IF lower(coalesce(current_setting('app.skip_deal_opportunity_email', true), '')) IN ('1', 'true', 'yes', 'on') THEN
    RETURN NEW;
  END IF;

  BEGIN
    actor_user_id := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    actor_user_id := NULL;
  END;

  -- Best-effort from here on: a notification-path failure must NEVER abort the deal write that fired
  -- this trigger. This mirrors record_stage_history() (migration 0143), which is best-effort on this
  -- same AFTER INSERT OR UPDATE OF stage_id path. A genuine ON CONFLICT is NOT an error (it is handled
  -- below), so this block only catches real failures (e.g. a job_queue / audit_log outage): it logs a
  -- WARNING and leaves the deal INSERT / stage change intact. Exactly-once on the success path is
  -- unchanged (the marker + receipts ledger still commit atomically with the deal on success).
  BEGIN
  -- First-entry dedup marker: record_id ALONE. The partial unique index physically forbids a second
  -- marker for the same deal, so a re-entry can never create a new notification id.
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
        'deal_opportunity_first_entry',
        'deal',
        $3,
        $4,
        jsonb_build_array(jsonb_build_object(
          'key', 'dealNumber',
          'label', 'Project Number',
          'fromDisplay', NULL,
          'toDisplay', $4,
          'fromFull', NULL,
          'toFull', $4,
          'transition', 'opportunity_entered',
          'masked', false
        )),
        jsonb_build_object('dealNumber', jsonb_build_object('from', NULL, 'to', $4)),
        'internal'
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    $sql$,
    TG_TABLE_SCHEMA
  )
  INTO inserted_audit_id
  USING NEW.id, actor_user_id, NEW.name, new_deal_number;

  -- Reuse-and-enqueue (the #602 pattern): on a marker conflict the deal already has its first-entry
  -- marker; reuse that id and STILL enqueue. The receipts ledger is the real exactly-once guard, so a
  -- re-entry re-enqueues with the SAME id and the worker dedups it. Safe ONLY because the dedup is
  -- record_id-alone (reuse always returns the same id). DO NOT add an event-type filter here.
  IF inserted_audit_id IS NULL THEN
    EXECUTE format(
      $sql$
        SELECT id
        FROM %I.audit_log
        WHERE table_name = 'deals'
          AND record_id = $1
          AND actor_system_process = 'deal_opportunity_first_entry'
        ORDER BY id
        LIMIT 1
      $sql$,
      TG_TABLE_SCHEMA
    )
    INTO inserted_audit_id
    USING NEW.id;
  END IF;

  IF inserted_audit_id IS NOT NULL THEN
    INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
    VALUES (
      'deal_opportunity_first_entry_email',
      jsonb_build_object(
        'tenantSchema', TG_TABLE_SCHEMA,
        'dealId', NEW.id,
        'dealNumber', new_deal_number,
        'auditLogId', inserted_audit_id
      ),
      NULL,
      'pending',
      NOW()
    );
  ELSE
    -- Unreachable in practice: a conflict can only fire on the first-entry partial unique index, and
    -- the reuse-SELECT looks that exact row up by record_id. Surface it loudly rather than silently
    -- dropping the notification.
    RAISE WARNING 'enqueue_deal_opportunity_first_entry_email: no first-entry audit marker resolvable for deal %, skipping notification enqueue', NEW.id;
  END IF;
  EXCEPTION WHEN others THEN
    -- The notification is strictly secondary: never let an audit_log / job_queue failure roll back the
    -- deal INSERT or stage change that fired this trigger. Log loudly and let the deal write commit.
    RAISE WARNING 'enqueue_deal_opportunity_first_entry_email: notification enqueue failed for deal % (deal write preserved): %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

-- Sent-email receipt ledger (worker retry idempotency). Keyed (tenant_schema, audit_log_id) — the
-- same scheme as the project_number receipts, kept as an independent table so the two notifications
-- have fully separate ledgers and the deal_number is stored under its own column.
CREATE TABLE IF NOT EXISTS public.deal_opportunity_first_entry_email_receipts (
  tenant_schema text NOT NULL,
  audit_log_id bigint NOT NULL,
  deal_id uuid NOT NULL,
  deal_number text NOT NULL,
  recipient_email text,
  resend_message_id text,
  sent_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_schema, audit_log_id)
);

CREATE INDEX IF NOT EXISTS deal_opportunity_first_entry_email_receipts_deal_idx
  ON public.deal_opportunity_first_entry_email_receipts (tenant_schema, deal_id);

-- Existing tenants: create the first-entry dedup index (empty predicate set under NO-SEED) and attach
-- the trigger. NO back-seed.
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
        CREATE UNIQUE INDEX IF NOT EXISTS audit_log_deal_opportunity_first_entry_uidx
          ON %I.audit_log (record_id)
          WHERE table_name = 'deals'
            AND actor_system_process = 'deal_opportunity_first_entry';

        DROP TRIGGER IF EXISTS deals_opportunity_first_entry_email_trg ON %I.deals;

        CREATE TRIGGER deals_opportunity_first_entry_email_trg
          AFTER INSERT OR UPDATE OF stage_id ON %I.deals
          FOR EACH ROW
          EXECUTE FUNCTION public.enqueue_deal_opportunity_first_entry_email();
      $sql$,
      tenant_schema,
      tenant_schema,
      tenant_schema
    );
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_deal_opportunity_first_entry_uidx
  ON office_dallas.audit_log (record_id)
  WHERE table_name = 'deals'
    AND actor_system_process = 'deal_opportunity_first_entry';

DROP TRIGGER IF EXISTS deals_opportunity_first_entry_email_trg ON office_dallas.deals;

CREATE TRIGGER deals_opportunity_first_entry_email_trg
  AFTER INSERT OR UPDATE OF stage_id ON office_dallas.deals
  FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_deal_opportunity_first_entry_email();
-- TENANT_SCHEMA_END
