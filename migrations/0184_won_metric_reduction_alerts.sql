-- Migration 0184: durable alerts when a published Won figure decreases.
--
-- This is intentionally an OUTBOX, not a route hook. Deals are changed through CRM edits, Bid Board
-- sync, imports, scripts, and direct SQL; an AFTER trigger is the only common transaction boundary.
-- The event preserves the before/after contribution at write time, and the worker sends after commit.
--
-- Published figures covered here are office and assigned-rep Won all-time, WTD, MTD, QTD, and YTD.
-- Ad hoc report-builder filters are deliberately out of scope: there is no stable finite set to watch.

DO $$
BEGIN
  ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'won_metric_decrease';
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.won_metric_reduction_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_schema text NOT NULL,
  deal_id uuid,
  event_kind text NOT NULL CHECK (event_kind IN ('deal_mutation', 'report_definition_change')),
  transaction_id bigint,
  action_label text NOT NULL,
  reason_code text NOT NULL,
  changed_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  impacts jsonb NOT NULL DEFAULT '{}'::jsonb,
  audit_reference jsonb NOT NULL DEFAULT '{}'::jsonb,
  old_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  deal_name text,
  deal_number text,
  report_metric_key text,
  definition_version text,
  definition_hash text,
  release_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A single physical deal mutation may update several Won-affecting fields. The trigger folds those writes
-- into the same immutable event for the transaction and the worker receives one outbox job.
CREATE UNIQUE INDEX IF NOT EXISTS won_metric_reduction_events_transaction_deal_uidx
  ON public.won_metric_reduction_events (tenant_schema, transaction_id, deal_id)
  WHERE event_kind = 'deal_mutation';

CREATE INDEX IF NOT EXISTS won_metric_reduction_events_created_idx
  ON public.won_metric_reduction_events (created_at DESC);

CREATE TABLE IF NOT EXISTS public.won_metric_reduction_delivery_receipts (
  event_id uuid NOT NULL REFERENCES public.won_metric_reduction_events(id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  resend_message_id text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  PRIMARY KEY (event_id, recipient_email)
);

-- Each deployed metric definition keeps its most-recent measured baseline. A future definition/hash change
-- compares against this baseline and emits a release-cited alert if it lowers the displayed figure. This is
-- the backstop for incidents such as a new query predicate excluding change orders: no deal audit row exists.
CREATE TABLE IF NOT EXISTS public.won_metric_definition_snapshots (
  tenant_schema text NOT NULL,
  metric_key text NOT NULL,
  definition_version text NOT NULL,
  definition_hash text NOT NULL,
  won_count integer NOT NULL,
  won_value numeric(14,2) NOT NULL,
  release_reference text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_schema, metric_key)
);

-- Before/after membership/value calculator. `before`/`after`/`delta` are dollar amounts;
-- countBefore/countAfter/countDelta keep zero-value Won records observable as well. The caller supplies
-- the published stage definition and metric namespace, so canonical CRM Won (CRM stage) can never be
-- conflated with estimator-pipeline Won (Bid Board effective stage plus its base-project guard).
CREATE OR REPLACE FUNCTION public.won_metric_reduction_impacts(
  p_old jsonb,
  p_new jsonb,
  p_as_of date DEFAULT (now() AT TIME ZONE 'America/Chicago')::date,
  p_stage_key text DEFAULT 'canonicalStageSlug',
  p_metric_prefix text DEFAULT NULL,
  p_period_keys text[] DEFAULT ARRAY['won_all_time', 'won_wtd', 'won_mtd', 'won_qtd', 'won_ytd'],
  p_include_assigned_rep boolean DEFAULT true,
  p_exclude_change_orders boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  old_stage text := COALESCE(p_old->>p_stage_key, '');
  new_stage text := COALESCE(p_new->>p_stage_key, '');
  old_rep text := NULLIF(p_old->>'assignedRepId', '');
  new_rep text := NULLIF(p_new->>'assignedRepId', '');
  old_change_order boolean := COALESCE((p_old->>'isChangeOrder')::boolean, false);
  new_change_order boolean := COALESCE((p_new->>'isChangeOrder')::boolean, false);
  old_date date := NULLIF(p_old->>'wonClosedDate', '')::date;
  new_date date := NULLIF(p_new->>'wonClosedDate', '')::date;
  old_awarded numeric := COALESCE(NULLIF(p_old->>'awardedAmount', '')::numeric, 0);
  old_bid_board_total numeric := COALESCE(NULLIF(p_old->>'bidBoardTotalSales', '')::numeric, 0);
  old_bid numeric := COALESCE(NULLIF(p_old->>'bidEstimate', '')::numeric, 0);
  old_dd numeric := COALESCE(NULLIF(p_old->>'ddEstimate', '')::numeric, 0);
  new_awarded numeric := COALESCE(NULLIF(p_new->>'awardedAmount', '')::numeric, 0);
  new_bid_board_total numeric := COALESCE(NULLIF(p_new->>'bidBoardTotalSales', '')::numeric, 0);
  new_bid numeric := COALESCE(NULLIF(p_new->>'bidEstimate', '')::numeric, 0);
  new_dd numeric := COALESCE(NULLIF(p_new->>'ddEstimate', '')::numeric, 0);
  old_eligible boolean;
  new_eligible boolean;
  old_value numeric := 0;
  new_value numeric := 0;
  week_start date := p_as_of - EXTRACT(DOW FROM p_as_of)::integer;
  month_start date := date_trunc('month', p_as_of)::date;
  quarter_start date := date_trunc('quarter', p_as_of)::date;
  year_start date := date_trunc('year', p_as_of)::date;
  period_start date;
  key text;
  metric_key text;
  old_count integer;
  new_count integer;
  old_period_value numeric;
  new_period_value numeric;
  result jsonb := '{}'::jsonb;
BEGIN
  old_eligible :=
    COALESCE((p_old->>'isActive')::boolean, false)
    AND NOT COALESCE((p_old->>'isTestData')::boolean, false)
    AND NOT COALESCE((p_old->>'onHold')::boolean, false)
    AND (NOT p_exclude_change_orders OR NOT old_change_order)
    AND old_stage = ANY (ARRAY['won', 'sent_to_production', 'service_sent_to_production', 'service_scheduled', 'service_complete', 'closed_won']);
  new_eligible :=
    COALESCE((p_new->>'isActive')::boolean, false)
    AND NOT COALESCE((p_new->>'isTestData')::boolean, false)
    AND NOT COALESCE((p_new->>'onHold')::boolean, false)
    AND (NOT p_exclude_change_orders OR NOT new_change_order)
    AND new_stage = ANY (ARRAY['won', 'sent_to_production', 'service_sent_to_production', 'service_scheduled', 'service_complete', 'closed_won']);

  IF old_eligible THEN
    old_value := CASE
      WHEN old_awarded > 0 THEN old_awarded
      WHEN old_bid_board_total > 0 THEN old_bid_board_total
      WHEN old_bid > 0 THEN old_bid
      WHEN old_dd > 0 THEN old_dd
      ELSE 0
    END;
  END IF;
  IF new_eligible THEN
    new_value := CASE
      WHEN new_awarded > 0 THEN new_awarded
      WHEN new_bid_board_total > 0 THEN new_bid_board_total
      WHEN new_bid > 0 THEN new_bid
      WHEN new_dd > 0 THEN new_dd
      ELSE 0
    END;
  END IF;

  FOREACH key IN ARRAY p_period_keys LOOP
    period_start := CASE key
      WHEN 'won_wtd' THEN week_start
      WHEN 'won_mtd' THEN month_start
      WHEN 'won_qtd' THEN quarter_start
      WHEN 'won_ytd' THEN year_start
      ELSE NULL
    END;
    metric_key := CASE WHEN p_metric_prefix IS NULL OR p_metric_prefix = '' THEN key ELSE p_metric_prefix || '.' || key END;
    old_count := CASE WHEN old_eligible AND (period_start IS NULL OR old_date BETWEEN period_start AND p_as_of) THEN 1 ELSE 0 END;
    new_count := CASE WHEN new_eligible AND (period_start IS NULL OR new_date BETWEEN period_start AND p_as_of) THEN 1 ELSE 0 END;
    old_period_value := CASE WHEN old_count = 1 THEN old_value ELSE 0 END;
    new_period_value := CASE WHEN new_count = 1 THEN new_value ELSE 0 END;

    IF old_count <> new_count OR old_period_value <> new_period_value THEN
      result := result || jsonb_build_object(
        'office.' || metric_key,
        jsonb_build_object(
          'scope', 'office', 'scopeId', NULL, 'metric', metric_key,
          'countBefore', old_count, 'countAfter', new_count, 'countDelta', new_count - old_count,
          'before', old_period_value, 'after', new_period_value, 'delta', new_period_value - old_period_value,
          'unit', 'usd'
        )
      );
    END IF;

    IF p_include_assigned_rep AND old_rep IS NOT DISTINCT FROM new_rep THEN
      IF old_rep IS NOT NULL AND (old_count <> new_count OR old_period_value <> new_period_value) THEN
        result := result || jsonb_build_object(
          'assigned_rep.' || old_rep || '.' || metric_key,
          jsonb_build_object(
            'scope', 'assigned_rep', 'scopeId', old_rep, 'metric', metric_key,
            'countBefore', old_count, 'countAfter', new_count, 'countDelta', new_count - old_count,
            'before', old_period_value, 'after', new_period_value, 'delta', new_period_value - old_period_value,
            'unit', 'usd'
          )
        );
      END IF;
    ELSIF p_include_assigned_rep THEN
      IF old_rep IS NOT NULL AND (old_count <> 0 OR old_period_value <> 0) THEN
        result := result || jsonb_build_object(
          'assigned_rep.' || old_rep || '.' || metric_key,
          jsonb_build_object(
            'scope', 'assigned_rep', 'scopeId', old_rep, 'metric', metric_key,
            'countBefore', old_count, 'countAfter', 0, 'countDelta', -old_count,
            'before', old_period_value, 'after', 0, 'delta', -old_period_value,
            'unit', 'usd'
          )
        );
      END IF;
      IF new_rep IS NOT NULL AND (new_count <> 0 OR new_period_value <> 0) THEN
        result := result || jsonb_build_object(
          'assigned_rep.' || new_rep || '.' || metric_key,
          jsonb_build_object(
            'scope', 'assigned_rep', 'scopeId', new_rep, 'metric', metric_key,
            'countBefore', 0, 'countAfter', new_count, 'countDelta', new_count,
            'before', 0, 'after', new_period_value, 'delta', new_period_value,
            'unit', 'usd'
          )
        );
      END IF;
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.won_metric_impacts_have_reduction(p_impacts jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_each(COALESCE(p_impacts, '{}'::jsonb)) AS impact(key, value)
    WHERE COALESCE(NULLIF(value->>'delta', '')::numeric, 0) < 0
       OR COALESCE(NULLIF(value->>'countDelta', '')::integer, 0) < 0
  );
$$;

CREATE OR REPLACE FUNCTION public.won_metric_changed_fields(p_old jsonb, p_new jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  key text;
  output_key text;
  result jsonb := '{}'::jsonb;
BEGIN
  FOREACH key IN ARRAY ARRAY[
    'stageId', 'wonClosedDate', 'awardedAmount', 'bidBoardTotalSales', 'bidEstimate', 'ddEstimate',
    'onHold', 'isActive', 'isTestData', 'isChangeOrder', 'assignedRepId', 'bidBoardStageSlug'
  ] LOOP
    IF p_old->key IS DISTINCT FROM p_new->key THEN
      output_key := CASE key
        WHEN 'stageId' THEN 'stage_id'
        WHEN 'wonClosedDate' THEN 'won_closed_date'
        WHEN 'awardedAmount' THEN 'awarded_amount'
        WHEN 'bidBoardTotalSales' THEN 'bid_board_total_sales'
        WHEN 'bidEstimate' THEN 'bid_estimate'
        WHEN 'ddEstimate' THEN 'dd_estimate'
        WHEN 'onHold' THEN 'on_hold'
        WHEN 'isActive' THEN 'is_active'
        WHEN 'isTestData' THEN 'is_test_data'
        WHEN 'isChangeOrder' THEN 'is_change_order'
        WHEN 'assignedRepId' THEN 'assigned_rep_id'
        WHEN 'bidBoardStageSlug' THEN 'bid_board_stage_slug'
      END;
      result := result || jsonb_build_object(output_key, jsonb_build_object('from', p_old->key, 'to', p_new->key));
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.won_metric_reduction_reason(p_old jsonb, p_new jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_old->'stageId' IS DISTINCT FROM p_new->'stageId'
     OR p_old->'bidBoardStageSlug' IS DISTINCT FROM p_new->'bidBoardStageSlug' THEN
    RETURN 'won_stage_changed';
  END IF;
  IF COALESCE((p_old->>'onHold')::boolean, false) = false AND COALESCE((p_new->>'onHold')::boolean, false) = true THEN RETURN 'placed_on_hold'; END IF;
  IF COALESCE((p_old->>'isActive')::boolean, false) = true AND COALESCE((p_new->>'isActive')::boolean, false) = false THEN RETURN 'archived_or_deactivated'; END IF;
  IF COALESCE((p_old->>'isTestData')::boolean, false) = false AND COALESCE((p_new->>'isTestData')::boolean, false) = true THEN RETURN 'marked_test_data'; END IF;
  IF p_old->'isChangeOrder' IS DISTINCT FROM p_new->'isChangeOrder' THEN RETURN 'won_change_order_classification_changed'; END IF;
  IF p_old->'wonClosedDate' IS DISTINCT FROM p_new->'wonClosedDate' THEN RETURN 'won_date_rebucketed'; END IF;
  IF p_old->'assignedRepId' IS DISTINCT FROM p_new->'assignedRepId' THEN RETURN 'won_reassigned'; END IF;
  IF p_old->'awardedAmount' IS DISTINCT FROM p_new->'awardedAmount'
     OR p_old->'bidBoardTotalSales' IS DISTINCT FROM p_new->'bidBoardTotalSales'
     OR p_old->'bidEstimate' IS DISTINCT FROM p_new->'bidEstimate'
     OR p_old->'ddEstimate' IS DISTINCT FROM p_new->'ddEstimate' THEN RETURN 'won_value_reduced'; END IF;
  RETURN 'won_contribution_reduced';
END;
$$;

CREATE OR REPLACE FUNCTION public.capture_won_metric_reduction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_stage_slug text;
  new_stage_slug text;
  v_old_snapshot jsonb;
  v_new_snapshot jsonb;
  v_original_old_snapshot jsonb;
  v_canonical_impacts jsonb;
  v_estimator_impacts jsonb;
  v_impacts jsonb;
  v_changed_fields jsonb;
  v_as_of date := (now() AT TIME ZONE 'America/Chicago')::date;
  audit_id bigint;
  v_audit_reference jsonb;
  v_reason_code text;
  v_action_label text;
  v_event_id uuid;
  v_office_id uuid;
  existing boolean := false;
  deal_uuid uuid;
  deal_name_value text;
  deal_number_value text;
BEGIN
  IF COALESCE(NULLIF(current_setting('app.skip_won_metric_reduction_alert', true), ''), 'false') IN ('1', 'true', 'on') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT slug INTO new_stage_slug FROM public.pipeline_stage_config WHERE id = NEW.stage_id;
    SELECT slug INTO old_stage_slug FROM public.pipeline_stage_config WHERE id = OLD.stage_id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT slug INTO old_stage_slug FROM public.pipeline_stage_config WHERE id = OLD.stage_id;
  END IF;

  v_old_snapshot := jsonb_build_object(
    'dealId', OLD.id, 'dealName', OLD.name, 'dealNumber', OLD.deal_number,
    'stageId', OLD.stage_id, 'stageSlug', old_stage_slug, 'canonicalStageSlug', old_stage_slug,
    'estimatorStageSlug', COALESCE(NULLIF(OLD.bid_board_stage_slug, ''), old_stage_slug),
    'bidBoardStageSlug', OLD.bid_board_stage_slug,
    'wonClosedDate', OLD.won_closed_date,
    'isActive', OLD.is_active, 'isTestData', OLD.is_test_data, 'isChangeOrder', OLD.is_change_order, 'onHold', OLD.on_hold,
    'assignedRepId', OLD.assigned_rep_id, 'awardedAmount', OLD.awarded_amount,
    'bidBoardTotalSales', OLD.bid_board_total_sales, 'bidEstimate', OLD.bid_estimate, 'ddEstimate', OLD.dd_estimate
  );
  IF TG_OP = 'DELETE' THEN
    v_new_snapshot := '{}'::jsonb;
    deal_uuid := OLD.id;
    deal_name_value := OLD.name;
    deal_number_value := OLD.deal_number;
  ELSE
    v_new_snapshot := jsonb_build_object(
      'dealId', NEW.id, 'dealName', NEW.name, 'dealNumber', NEW.deal_number,
      'stageId', NEW.stage_id, 'stageSlug', new_stage_slug, 'canonicalStageSlug', new_stage_slug,
      'estimatorStageSlug', COALESCE(NULLIF(NEW.bid_board_stage_slug, ''), new_stage_slug),
      'bidBoardStageSlug', NEW.bid_board_stage_slug,
      'wonClosedDate', NEW.won_closed_date,
      'isActive', NEW.is_active, 'isTestData', NEW.is_test_data, 'isChangeOrder', NEW.is_change_order, 'onHold', NEW.on_hold,
      'assignedRepId', NEW.assigned_rep_id, 'awardedAmount', NEW.awarded_amount,
      'bidBoardTotalSales', NEW.bid_board_total_sales, 'bidEstimate', NEW.bid_estimate, 'ddEstimate', NEW.dd_estimate
    );
    deal_uuid := NEW.id;
    deal_name_value := NEW.name;
    deal_number_value := NEW.deal_number;
  END IF;

  SELECT e.old_snapshot INTO v_original_old_snapshot
  FROM public.won_metric_reduction_events e
  WHERE e.event_kind = 'deal_mutation'
    AND e.tenant_schema = TG_TABLE_SCHEMA
    AND e.transaction_id = txid_current()
    AND e.deal_id = deal_uuid
  FOR UPDATE;
  existing := FOUND;
  IF existing THEN
    v_canonical_impacts := public.won_metric_reduction_impacts(v_original_old_snapshot, v_new_snapshot, v_as_of);
    v_estimator_impacts := public.won_metric_reduction_impacts(
      v_original_old_snapshot, v_new_snapshot, v_as_of, 'estimatorStageSlug', 'estimator_pipeline', ARRAY['won_ytd'], false, true
    );
    v_impacts := v_canonical_impacts || v_estimator_impacts;
    v_changed_fields := public.won_metric_changed_fields(v_original_old_snapshot, v_new_snapshot);
    v_reason_code := CASE WHEN TG_OP = 'DELETE' THEN 'deal_deleted' ELSE public.won_metric_reduction_reason(v_original_old_snapshot, v_new_snapshot) END;
  ELSE
    v_canonical_impacts := public.won_metric_reduction_impacts(v_old_snapshot, v_new_snapshot, v_as_of);
    v_estimator_impacts := public.won_metric_reduction_impacts(
      v_old_snapshot, v_new_snapshot, v_as_of, 'estimatorStageSlug', 'estimator_pipeline', ARRAY['won_ytd'], false, true
    );
    v_impacts := v_canonical_impacts || v_estimator_impacts;
    v_changed_fields := public.won_metric_changed_fields(v_old_snapshot, v_new_snapshot);
    v_reason_code := CASE WHEN TG_OP = 'DELETE' THEN 'deal_deleted' ELSE public.won_metric_reduction_reason(v_old_snapshot, v_new_snapshot) END;
  END IF;

  -- Keep the first material contribution change even when it is positive: a later statement in the SAME
  -- transaction can partially reverse it. The worker evaluates the final aggregate and skips non-negative
  -- events, preventing a false alert from an intermediate value.
  IF NOT existing AND v_impacts = '{}'::jsonb THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  v_action_label := COALESCE(
    NULLIF(current_setting('app.won_metric_action', true), ''),
    CASE v_reason_code
      WHEN 'deal_deleted' THEN 'Deal deleted'
      WHEN 'won_stage_changed' THEN CASE
        WHEN (v_changed_fields ? 'bid_board_stage_slug') AND NOT (v_changed_fields ? 'stage_id') THEN 'Bid Board stage changed'
        ELSE 'Deal stage changed'
      END
      WHEN 'placed_on_hold' THEN 'Deal placed on hold'
      WHEN 'archived_or_deactivated' THEN 'Deal deactivated'
      WHEN 'marked_test_data' THEN 'Deal marked as test data'
      WHEN 'won_change_order_classification_changed' THEN 'Change-order classification changed'
      WHEN 'won_date_rebucketed' THEN 'Won closed date changed'
      WHEN 'won_reassigned' THEN 'Won deal reassigned'
      WHEN 'won_value_reduced' THEN 'Won value changed'
      ELSE 'Won contribution changed'
    END
  );

  IF to_regclass(format('%I.audit_log', TG_TABLE_SCHEMA)) IS NOT NULL THEN
    EXECUTE format(
      'SELECT id FROM %I.audit_log WHERE table_name = $1 AND record_id = $2 ORDER BY id DESC LIMIT 1',
      TG_TABLE_SCHEMA
    ) INTO audit_id USING 'deals', deal_uuid;
  END IF;
  v_audit_reference := jsonb_build_object(
    'tenantSchema', TG_TABLE_SCHEMA,
    'transactionId', txid_current(),
    'action', v_action_label,
    'auditLogIds', CASE WHEN audit_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(audit_id) END
  );

  IF existing THEN
    UPDATE public.won_metric_reduction_events e
       SET new_snapshot = v_new_snapshot,
           deal_name = deal_name_value,
           deal_number = deal_number_value,
           impacts = v_impacts,
           changed_fields = v_changed_fields,
           action_label = v_action_label,
           reason_code = v_reason_code,
           audit_reference = jsonb_build_object(
             'tenantSchema', TG_TABLE_SCHEMA,
             'transactionId', txid_current(),
             'action', v_action_label,
             'auditLogIds', COALESCE(e.audit_reference->'auditLogIds', '[]'::jsonb) || v_audit_reference->'auditLogIds'
           ),
           updated_at = now()
     WHERE e.event_kind = 'deal_mutation'
       AND e.tenant_schema = TG_TABLE_SCHEMA
       AND e.transaction_id = txid_current()
       AND e.deal_id = deal_uuid
     RETURNING e.id INTO v_event_id;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  INSERT INTO public.won_metric_reduction_events (
    tenant_schema, deal_id, event_kind, transaction_id, action_label, reason_code, changed_fields, impacts,
    audit_reference, old_snapshot, new_snapshot, deal_name, deal_number
  ) VALUES (
    TG_TABLE_SCHEMA, deal_uuid, 'deal_mutation', txid_current(), v_action_label,
    v_reason_code,
    v_changed_fields, v_impacts, v_audit_reference, v_old_snapshot, v_new_snapshot, deal_name_value, deal_number_value
  ) RETURNING id INTO v_event_id;

  SELECT id INTO v_office_id FROM public.offices WHERE ('office_' || slug) = TG_TABLE_SCHEMA LIMIT 1;
  INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
  VALUES (
    'won_metric_reduction_alert',
    jsonb_build_object('eventId', v_event_id),
    v_office_id,
    'pending',
    now()
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Call this when a published Won query definition changes. The main Deals Dashboard and Estimator
-- Pipeline register their deployed Won-YTD definitions on stable successful reads, which makes a reduction
-- caused solely by code or configuration visible even though no deals/audit rows changed.
CREATE OR REPLACE FUNCTION public.record_won_metric_definition_snapshot(
  p_tenant_schema text,
  p_metric_key text,
  p_definition_version text,
  p_definition_hash text,
  p_won_count integer,
  p_won_value numeric,
  p_release_reference text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  previous public.won_metric_definition_snapshots%ROWTYPE;
  event_id uuid;
  office_id uuid;
  impacts jsonb;
BEGIN
  IF p_tenant_schema !~ '^office_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Invalid tenant schema for Won metric snapshot';
  END IF;
  SELECT * INTO previous
  FROM public.won_metric_definition_snapshots
  WHERE tenant_schema = p_tenant_schema AND metric_key = p_metric_key
  FOR UPDATE;

  IF FOUND AND previous.definition_hash IS DISTINCT FROM p_definition_hash
     AND (p_won_value < previous.won_value OR p_won_count < previous.won_count) THEN
    impacts := jsonb_build_object(
      'office.' || p_metric_key,
      jsonb_build_object(
        'scope', 'office', 'scopeId', NULL, 'metric', p_metric_key,
        'countBefore', previous.won_count, 'countAfter', p_won_count, 'countDelta', p_won_count - previous.won_count,
        'before', previous.won_value, 'after', p_won_value, 'delta', p_won_value - previous.won_value,
        'unit', 'usd'
      )
    );
    INSERT INTO public.won_metric_reduction_events (
      tenant_schema, event_kind, action_label, reason_code, impacts, audit_reference, old_snapshot, new_snapshot,
      report_metric_key, definition_version, definition_hash, release_reference
    ) VALUES (
      p_tenant_schema, 'report_definition_change', 'Published Won metric definition changed', 'report_definition_change', impacts,
      jsonb_build_object('kind', 'release', 'previousDefinitionHash', previous.definition_hash, 'definitionHash', p_definition_hash),
      jsonb_build_object('wonCount', previous.won_count, 'wonValue', previous.won_value, 'definitionVersion', previous.definition_version),
      jsonb_build_object('wonCount', p_won_count, 'wonValue', p_won_value, 'definitionVersion', p_definition_version),
      p_metric_key, p_definition_version, p_definition_hash, p_release_reference
    ) RETURNING id INTO event_id;
    SELECT id INTO office_id FROM public.offices WHERE ('office_' || slug) = p_tenant_schema LIMIT 1;
    INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
    VALUES ('won_metric_reduction_alert', jsonb_build_object('eventId', event_id), office_id, 'pending', now());
  END IF;

  INSERT INTO public.won_metric_definition_snapshots (
    tenant_schema, metric_key, definition_version, definition_hash, won_count, won_value, release_reference, captured_at
  ) VALUES (
    p_tenant_schema, p_metric_key, p_definition_version, p_definition_hash, p_won_count, p_won_value, p_release_reference, now()
  ) ON CONFLICT (tenant_schema, metric_key) DO UPDATE SET
    definition_version = EXCLUDED.definition_version,
    definition_hash = EXCLUDED.definition_hash,
    won_count = EXCLUDED.won_count,
    won_value = EXCLUDED.won_value,
    release_reference = EXCLUDED.release_reference,
    captured_at = now();
  RETURN event_id;
END;
$$;

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS won_metric_reduction_update_trg ON %I.deals', schema_name);
    EXECUTE format('DROP TRIGGER IF EXISTS won_metric_reduction_delete_trg ON %I.deals', schema_name);
    EXECUTE format(
      'CREATE TRIGGER won_metric_reduction_update_trg AFTER UPDATE OF stage_id, won_closed_date, awarded_amount, bid_board_total_sales, bid_estimate, dd_estimate, on_hold, is_active, is_test_data, is_change_order, assigned_rep_id, bid_board_stage_slug ON %I.deals FOR EACH ROW EXECUTE FUNCTION public.capture_won_metric_reduction()',
      schema_name
    );
    EXECUTE format(
      'CREATE TRIGGER won_metric_reduction_delete_trg AFTER DELETE ON %I.deals FOR EACH ROW EXECUTE FUNCTION public.capture_won_metric_reduction()',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants are cloned from office_dallas by the provisioner.
-- TENANT_SCHEMA_START
DROP TRIGGER IF EXISTS won_metric_reduction_update_trg ON office_dallas.deals;
DROP TRIGGER IF EXISTS won_metric_reduction_delete_trg ON office_dallas.deals;
CREATE TRIGGER won_metric_reduction_update_trg
  AFTER UPDATE OF stage_id, won_closed_date, awarded_amount, bid_board_total_sales, bid_estimate, dd_estimate, on_hold, is_active, is_test_data, is_change_order, assigned_rep_id, bid_board_stage_slug
  ON office_dallas.deals
  FOR EACH ROW EXECUTE FUNCTION public.capture_won_metric_reduction();
CREATE TRIGGER won_metric_reduction_delete_trg
  AFTER DELETE ON office_dallas.deals
  FOR EACH ROW EXECUTE FUNCTION public.capture_won_metric_reduction();
-- TENANT_SCHEMA_END
