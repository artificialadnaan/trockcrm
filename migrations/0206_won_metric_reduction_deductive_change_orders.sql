-- Migration 0206: make the Won-reduction alert (0184) fire for DEDUCTIVE change orders.
--
-- A deductive change order is a real Won CHILD deal (0156) whose awarded_amount is NEGATIVE: creating one
-- LOWERS the published Won figure. Migration 0184 exists to alert leadership when exactly that happens, and
-- today it stays silent. TWO independent halves are why, and either one alone leaves the alert inert:
--
--   (a) THERE IS NO INSERT TRIGGER. 0184 installs won_metric_reduction_update_trg as
--       `AFTER UPDATE OF (stage_id, won_closed_date, awarded_amount, ...)` and won_metric_reduction_delete_trg
--       as `AFTER DELETE`. Creating a deductive CO INSERTS a child row, so capture_won_metric_reduction is
--       never invoked — no durable event, no email, nothing to skip or suppress.
--   (b) THE IMPACT CHAIN ZEROES NEGATIVES. won_metric_reduction_impacts resolves old_value/new_value through
--       a `> 0`-gated fallback chain ending in `ELSE 0`, so a negative awarded_amount measures as 0. The
--       canonical calls pass p_exclude_change_orders = false — change orders ARE in scope; they just score
--       as nothing. Half (a) alone therefore produces a trigger that fires, computes an empty impacts map,
--       and returns without an event. Half (b) alone still misses creation entirely.
--
-- Half (b) is also why a pure deductive-amount EDIT (−10,000 -> −25,000) produces no event today: both
-- snapshots resolve to 0, the counts are unchanged, and v_impacts comes out '{}'.
--
-- WHAT "OLD CONTRIBUTION" MEANS FOR AN INSERT: the row did not exist, so it contributed nothing — the old
-- snapshot is the EMPTY jsonb, which won_metric_reduction_impacts already scores as ineligible (count 0,
-- value 0) on every metric. That makes creation a comparison of 0 against the new row's own contribution.
--
-- WHY THAT DOES NOT FIRE ON EVERY NEW WON DEAL — the real risk of adding an INSERT trigger to a reduction
-- detector: against a zero baseline, an ordinary win (or an ADDITIVE change order) is a pure INCREASE, and
-- only a row whose OWN contribution is negative can lower a published figure. The INSERT path is therefore
-- gated on an actual reduction (won_metric_impacts_have_reduction) instead of on "the impacts map is
-- non-empty". 0184's deliberate keep-the-first-positive-baseline rule — which preserves a positive
-- intermediate so a later statement in the same transaction cannot be misread — is an UPDATE/DELETE rule
-- about a row whose prior contribution was real; it has no meaning for a creation whose before is
-- definitionally zero, and applying it there is precisely what would spam an event per new Won deal.
-- A cheap pre-check on the four value columns short-circuits before any catalog read, so bulk deal imports
-- pay ~nothing.
--
-- SCOPE OF THE VALUE CHANGE: only the change-order branch is added, mirroring deal-value-sql.ts's
-- changeOrderBranchSql verbatim — `CASE WHEN COALESCE(is_change_order,false) THEN COALESCE(awarded_amount,0)
-- ELSE <chain> END`. A NON-change-order deal keeps the identical `> 0` fallback chain, and the ESTIMATOR
-- calls (p_exclude_change_orders = true) are untouched by construction: they mark every change order
-- INELIGIBLE before the value is resolved, so the new branch is unreachable for them.
--
-- The two functions are public (shared by every tenant) so they are simply CREATE OR REPLACEd. The TRIGGERS
-- are per-tenant, so the new insert trigger needs BOTH the `DO $tenant$` loop over office_% AND the
-- TENANT_SCHEMA marker block the office provisioner clones for a NEW tenant. Idempotent / replayable.
-- (The marker text itself is deliberately not spelled out anywhere above: the provisioner locates the block
-- with a plain indexOf on the first occurrence, so a mention in a comment would truncate what it clones.)

-- Half (b): teach the before/after calculator a change order's real, possibly negative contribution.
-- Replaces 0184's definition verbatim apart from the two CASE chains flagged below.
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
  old_assigned_rep text := NULLIF(p_old->>'assignedRepId', '');
  new_assigned_rep text := NULLIF(p_new->>'assignedRepId', '');
  old_estimator_rep text := NULLIF(p_old->>'estimatorUserId', '');
  new_estimator_rep text := NULLIF(p_new->>'estimatorUserId', '');
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
  -- Keep both before/after eligibility checks on one local copy of the shared six-slug Won family.
  -- Raw migration SQL cannot import TypeScript; the runtime parity test guards this list against
  -- shared/src/types/workflow.ts's WON_DEAL_STAGE_SLUGS contract.
  won_stage_slugs constant text[] := ARRAY[
    'won', 'sent_to_production', 'service_sent_to_production',
    'service_scheduled', 'service_complete', 'closed_won'
  ];
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
  involved_rep text;
  processed_involved_reps text[] := ARRAY[]::text[];
  old_involved boolean;
  new_involved boolean;
  old_involved_count integer;
  new_involved_count integer;
  old_involved_value numeric;
  new_involved_value numeric;
  result jsonb := '{}'::jsonb;
BEGIN
  old_eligible :=
    COALESCE((p_old->>'isActive')::boolean, false)
    AND NOT COALESCE((p_old->>'isTestData')::boolean, false)
    AND NOT COALESCE((p_old->>'onHold')::boolean, false)
    AND (NOT p_exclude_change_orders OR NOT old_change_order)
    AND old_stage = ANY (won_stage_slugs);
  new_eligible :=
    COALESCE((p_new->>'isActive')::boolean, false)
    AND NOT COALESCE((p_new->>'isTestData')::boolean, false)
    AND NOT COALESCE((p_new->>'onHold')::boolean, false)
    AND (NOT p_exclude_change_orders OR NOT new_change_order)
    AND new_stage = ANY (won_stage_slugs);

  -- CHANGED IN 0206 (both chains): the leading change-order branch. A CO child's published value is
  -- awarded_amount VERBATIM — never the `> 0` fallback chain, which drops a DEDUCTIVE CO's negative amount
  -- and reports the deduction as $0. This mirrors deal-value-sql.ts's changeOrderBranchSql exactly, so the
  -- alert measures the same number the Won surfaces publish. Inert for a POSITIVE CO (awarded > 0 already
  -- won the chain's first arm) and for every non-change-order deal, whose chain below is untouched.
  IF old_eligible THEN
    old_value := CASE
      WHEN old_change_order THEN old_awarded
      WHEN old_awarded > 0 THEN old_awarded
      WHEN old_bid_board_total > 0 THEN old_bid_board_total
      WHEN old_bid > 0 THEN old_bid
      WHEN old_dd > 0 THEN old_dd
      ELSE 0
    END;
  END IF;
  IF new_eligible THEN
    new_value := CASE
      WHEN new_change_order THEN new_awarded
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

    IF p_include_assigned_rep THEN
      -- The Deals board's established assigned_rep scope includes every involved rep: the assignee
      -- and estimator. Keep that key/scope stable while counting a user only once if they hold both roles.
      processed_involved_reps := ARRAY[]::text[];
      FOREACH involved_rep IN ARRAY ARRAY[
        old_assigned_rep, old_estimator_rep, new_assigned_rep, new_estimator_rep
      ] LOOP
        IF involved_rep IS NULL OR involved_rep = ANY(processed_involved_reps) THEN CONTINUE; END IF;
        processed_involved_reps := array_append(processed_involved_reps, involved_rep);

        old_involved :=
          (old_assigned_rep IS NOT NULL AND involved_rep = old_assigned_rep)
          OR (old_estimator_rep IS NOT NULL AND involved_rep = old_estimator_rep);
        new_involved :=
          (new_assigned_rep IS NOT NULL AND involved_rep = new_assigned_rep)
          OR (new_estimator_rep IS NOT NULL AND involved_rep = new_estimator_rep);
        old_involved_count := CASE WHEN old_involved THEN old_count ELSE 0 END;
        new_involved_count := CASE WHEN new_involved THEN new_count ELSE 0 END;
        old_involved_value := CASE WHEN old_involved THEN old_period_value ELSE 0 END;
        new_involved_value := CASE WHEN new_involved THEN new_period_value ELSE 0 END;

        IF old_involved_count <> new_involved_count OR old_involved_value <> new_involved_value THEN
          result := result || jsonb_build_object(
            'assigned_rep.' || involved_rep || '.' || metric_key,
            jsonb_build_object(
              'scope', 'assigned_rep', 'scopeId', involved_rep, 'metric', metric_key,
              'countBefore', old_involved_count, 'countAfter', new_involved_count,
              'countDelta', new_involved_count - old_involved_count,
              'before', old_involved_value, 'after', new_involved_value,
              'delta', new_involved_value - old_involved_value,
              'unit', 'usd'
            )
          );
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

-- Half (a): make the capture function INSERT-safe and INSERT-aware.
-- Replaces 0184's definition verbatim apart from the four blocks flagged CHANGED IN 0206.
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

  -- CHANGED IN 0206 — INSERT short-circuit. Creation is measured against a zero baseline, so it can only
  -- LOWER a published figure when the created row's own contribution is negative. Every value the impacts
  -- chain can resolve comes from these four columns, so a row with none of them negative provably cannot
  -- produce a reduction and is dismissed before any catalog read, snapshot build or impacts call. This is
  -- what keeps an ordinary Won deal — and an ADDITIVE change order — from minting a spurious event, and it
  -- keeps a bulk deal import paying ~nothing per row.
  IF TG_OP = 'INSERT'
     AND COALESCE(NEW.awarded_amount, 0) >= 0
     AND COALESCE(NEW.bid_board_total_sales, 0) >= 0
     AND COALESCE(NEW.bid_estimate, 0) >= 0
     AND COALESCE(NEW.dd_estimate, 0) >= 0 THEN
    RETURN NEW;
  END IF;

  -- CHANGED IN 0206 — stage lookups keyed off the tuples that actually exist for this TG_OP.
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT slug INTO new_stage_slug FROM public.pipeline_stage_config WHERE id = NEW.stage_id;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT slug INTO old_stage_slug FROM public.pipeline_stage_config WHERE id = OLD.stage_id;
  END IF;

  -- CHANGED IN 0206 — OLD is unassigned on INSERT (reading it raises "record old is not assigned yet").
  -- The old contribution of a row that did not exist is the EMPTY snapshot, which
  -- won_metric_reduction_impacts already scores as ineligible: count 0 and value 0 on every metric. That is
  -- the exact mirror of how 0184 represents a DELETE's new snapshot.
  IF TG_OP = 'INSERT' THEN
    v_old_snapshot := '{}'::jsonb;
  ELSE
    v_old_snapshot := jsonb_build_object(
      'dealId', OLD.id, 'dealName', OLD.name, 'dealNumber', OLD.deal_number,
      'stageId', OLD.stage_id, 'stageSlug', old_stage_slug, 'canonicalStageSlug', old_stage_slug,
      'estimatorStageSlug', COALESCE(NULLIF(OLD.bid_board_stage_slug, ''), old_stage_slug),
      'bidBoardStageSlug', OLD.bid_board_stage_slug,
      'wonClosedDate', OLD.won_closed_date,
      'isActive', OLD.is_active, 'isTestData', OLD.is_test_data, 'isChangeOrder', OLD.is_change_order, 'onHold', OLD.on_hold,
      'assignedRepId', OLD.assigned_rep_id, 'estimatorUserId', OLD.estimator_user_id, 'awardedAmount', OLD.awarded_amount,
      'bidBoardTotalSales', OLD.bid_board_total_sales, 'bidEstimate', OLD.bid_estimate, 'ddEstimate', OLD.dd_estimate
    );
  END IF;
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
      'assignedRepId', NEW.assigned_rep_id, 'estimatorUserId', NEW.estimator_user_id, 'awardedAmount', NEW.awarded_amount,
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
    -- CHANGED IN 0206 — a creation is not a field edit, so name it for what it is. Every other reason code
    -- describes a transition on a row that already contributed; these two describe a row arriving negative.
    v_reason_code := CASE
      WHEN TG_OP = 'DELETE' THEN 'deal_deleted'
      WHEN TG_OP = 'INSERT' THEN CASE
        WHEN COALESCE((v_new_snapshot->>'isChangeOrder')::boolean, false) THEN 'deductive_change_order_created'
        ELSE 'negative_won_value_created'
      END
      ELSE public.won_metric_reduction_reason(v_old_snapshot, v_new_snapshot)
    END;
  END IF;

  -- CHANGED IN 0206 — the INSERT gate. 0184's keep-the-first-material-change rule below deliberately keeps
  -- a POSITIVE first impact so a partial reversal later in the same transaction cannot be misread; that rule
  -- is about a row whose prior contribution was real. A creation's "before" is definitionally zero, so
  -- applying it here would mint an event for every new Won deal. Gate creation on an ACTUAL reduction.
  IF TG_OP = 'INSERT' AND NOT existing AND NOT public.won_metric_impacts_have_reduction(v_impacts) THEN
    RETURN NEW;
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
      -- CHANGED IN 0206 — labels for the two creation reason codes above.
      WHEN 'deductive_change_order_created' THEN 'Deductive change order created'
      WHEN 'negative_won_value_created' THEN 'Won deal created with a negative value'
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
      WHEN 'won_estimator_reassigned' THEN 'Won deal estimator reassigned'
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
  PERFORM public.enqueue_won_metric_reduction_alert(v_event_id, v_office_id);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Existing tenants: install the INSERT trigger alongside 0184's UPDATE/DELETE pair. No column list is
-- possible (or meaningful) on an INSERT trigger — every created row is evaluated, and the function's
-- short-circuit above dismisses the non-negative ones immediately.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS won_metric_reduction_insert_trg ON %I.deals', schema_name);
    EXECUTE format(
      'CREATE TRIGGER won_metric_reduction_insert_trg AFTER INSERT ON %I.deals FOR EACH ROW EXECUTE FUNCTION public.capture_won_metric_reduction()',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by DROP ... IF EXISTS).
-- TENANT_SCHEMA_START
DROP TRIGGER IF EXISTS won_metric_reduction_insert_trg ON office_dallas.deals;
CREATE TRIGGER won_metric_reduction_insert_trg
  AFTER INSERT ON office_dallas.deals
  FOR EACH ROW EXECUTE FUNCTION public.capture_won_metric_reduction();
-- TENANT_SCHEMA_END
