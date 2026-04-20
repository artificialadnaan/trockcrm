-- Migration 0039: intervention policy recommendation evaluation and apply

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
      'ALTER TABLE %I.ai_policy_recommendation_rows
         ADD COLUMN IF NOT EXISTS proposed_change_json JSONB,
         ADD COLUMN IF NOT EXISTS review_details_json JSONB',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.ai_policy_recommendation_decisions (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         office_id UUID NOT NULL REFERENCES public.offices(id),
         snapshot_id UUID NOT NULL,
         recommendation_id UUID,
         taxonomy VARCHAR(48) NOT NULL,
         grouping_key VARCHAR(120) NOT NULL,
         decision VARCHAR(40) NOT NULL,
         suppression_reason VARCHAR(40),
         score INTEGER,
         impact_score INTEGER,
         volume_score INTEGER,
         persistence_score INTEGER,
         actionability_score INTEGER,
         confidence VARCHAR(16),
         qualified_at TIMESTAMPTZ,
         rendered_at TIMESTAMPTZ,
         used_fallback_copy BOOLEAN NOT NULL DEFAULT FALSE,
         used_fallback_structured_payload BOOLEAN NOT NULL DEFAULT FALSE,
         metrics_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_policy_recommendation_decisions_snapshot_idx
       ON %I.ai_policy_recommendation_decisions (office_id, snapshot_id, created_at DESC)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.ai_policy_recommendation_apply_events (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         office_id UUID NOT NULL REFERENCES public.offices(id),
         recommendation_id UUID NOT NULL,
         snapshot_id UUID NOT NULL,
         taxonomy VARCHAR(48) NOT NULL,
         actor_user_id UUID NOT NULL REFERENCES public.users(id),
         request_idempotency_key VARCHAR(120) NOT NULL,
         status VARCHAR(32) NOT NULL,
         target_type VARCHAR(48) NOT NULL,
         target_id VARCHAR(120) NOT NULL,
         before_state_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         proposed_state_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         applied_state_json JSONB NOT NULL DEFAULT ''{}''::jsonb,
         rejection_reason VARCHAR(64),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_policy_recommendation_apply_events_recommendation_idx
       ON %I.ai_policy_recommendation_apply_events (office_id, recommendation_id, created_at DESC)',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS ai_policy_recommendation_apply_events_idempotency_uidx
       ON %I.ai_policy_recommendation_apply_events (office_id, recommendation_id, request_idempotency_key)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.intervention_snooze_policies (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         office_id UUID NOT NULL REFERENCES public.offices(id),
         snooze_reason_key VARCHAR(120) NOT NULL,
         max_snooze_days INTEGER NOT NULL,
         breach_review_threshold_percent INTEGER,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS intervention_snooze_policies_office_reason_uidx
       ON %I.intervention_snooze_policies (office_id, snooze_reason_key)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.intervention_escalation_policies (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         office_id UUID NOT NULL REFERENCES public.offices(id),
         disconnect_type_key VARCHAR(120) NOT NULL,
         routing_mode VARCHAR(40) NOT NULL,
         escalation_threshold_percent INTEGER NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS intervention_escalation_policies_office_type_uidx
       ON %I.intervention_escalation_policies (office_id, disconnect_type_key)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.intervention_assignee_balancing_policies (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         office_id UUID NOT NULL REFERENCES public.offices(id),
         balancing_mode VARCHAR(40) NOT NULL,
         overload_share_percent INTEGER NOT NULL,
         min_high_risk_cases INTEGER NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS intervention_assignee_balancing_policies_office_uidx
       ON %I.intervention_assignee_balancing_policies (office_id)',
      schema_name
    );
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  ALTER TABLE ai_policy_recommendation_rows
    ADD COLUMN IF NOT EXISTS proposed_change_json JSONB,
    ADD COLUMN IF NOT EXISTS review_details_json JSONB;

  CREATE TABLE IF NOT EXISTS ai_policy_recommendation_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    office_id UUID NOT NULL REFERENCES public.offices(id),
    snapshot_id UUID NOT NULL,
    recommendation_id UUID,
    taxonomy VARCHAR(48) NOT NULL,
    grouping_key VARCHAR(120) NOT NULL,
    decision VARCHAR(40) NOT NULL,
    suppression_reason VARCHAR(40),
    score INTEGER,
    impact_score INTEGER,
    volume_score INTEGER,
    persistence_score INTEGER,
    actionability_score INTEGER,
    confidence VARCHAR(16),
    qualified_at TIMESTAMPTZ,
    rendered_at TIMESTAMPTZ,
    used_fallback_copy BOOLEAN NOT NULL DEFAULT FALSE,
    used_fallback_structured_payload BOOLEAN NOT NULL DEFAULT FALSE,
    metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ai_policy_recommendation_decisions_snapshot_idx
    ON ai_policy_recommendation_decisions (office_id, snapshot_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS ai_policy_recommendation_apply_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    office_id UUID NOT NULL REFERENCES public.offices(id),
    recommendation_id UUID NOT NULL,
    snapshot_id UUID NOT NULL,
    taxonomy VARCHAR(48) NOT NULL,
    actor_user_id UUID NOT NULL REFERENCES public.users(id),
    request_idempotency_key VARCHAR(120) NOT NULL,
    status VARCHAR(32) NOT NULL,
    target_type VARCHAR(48) NOT NULL,
    target_id VARCHAR(120) NOT NULL,
    before_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    proposed_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    applied_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    rejection_reason VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ai_policy_recommendation_apply_events_recommendation_idx
    ON ai_policy_recommendation_apply_events (office_id, recommendation_id, created_at DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS ai_policy_recommendation_apply_events_idempotency_uidx
    ON ai_policy_recommendation_apply_events (office_id, recommendation_id, request_idempotency_key);

  CREATE TABLE IF NOT EXISTS intervention_snooze_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    office_id UUID NOT NULL REFERENCES public.offices(id),
    snooze_reason_key VARCHAR(120) NOT NULL,
    max_snooze_days INTEGER NOT NULL,
    breach_review_threshold_percent INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS intervention_snooze_policies_office_reason_uidx
    ON intervention_snooze_policies (office_id, snooze_reason_key);

  CREATE TABLE IF NOT EXISTS intervention_escalation_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    office_id UUID NOT NULL REFERENCES public.offices(id),
    disconnect_type_key VARCHAR(120) NOT NULL,
    routing_mode VARCHAR(40) NOT NULL,
    escalation_threshold_percent INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS intervention_escalation_policies_office_type_uidx
    ON intervention_escalation_policies (office_id, disconnect_type_key);

  CREATE TABLE IF NOT EXISTS intervention_assignee_balancing_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    office_id UUID NOT NULL REFERENCES public.offices(id),
    balancing_mode VARCHAR(40) NOT NULL,
    overload_share_percent INTEGER NOT NULL,
    min_high_risk_cases INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS intervention_assignee_balancing_policies_office_uidx
    ON intervention_assignee_balancing_policies (office_id);
END $tenant$;
-- TENANT_SCHEMA_END
