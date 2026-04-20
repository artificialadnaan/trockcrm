-- Migration 0038: Intervention policy recommendations

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
      'CREATE TABLE IF NOT EXISTS %I.ai_policy_recommendation_snapshots (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         office_id UUID NOT NULL REFERENCES public.offices(id),
         status VARCHAR(24) NOT NULL,
         requested_by_user_id UUID REFERENCES public.users(id),
         supersedes_snapshot_id UUID,
         generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         stale_at TIMESTAMPTZ NOT NULL,
         superseded_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_policy_recommendation_snapshots_office_id_status_idx
       ON %I.ai_policy_recommendation_snapshots (office_id, status, generated_at DESC)',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS ai_policy_recommendation_snapshots_pending_uidx
       ON %I.ai_policy_recommendation_snapshots (office_id)
       WHERE status = ''pending''',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.ai_policy_recommendation_rows (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         snapshot_id UUID NOT NULL REFERENCES %I.ai_policy_recommendation_snapshots(id) ON DELETE CASCADE,
         office_id UUID NOT NULL REFERENCES public.offices(id),
         recommendation_id UUID NOT NULL,
         taxonomy VARCHAR(48) NOT NULL,
         primary_grouping_key VARCHAR(120) NOT NULL,
         title VARCHAR(255) NOT NULL,
         statement VARCHAR(500) NOT NULL,
         why_now VARCHAR(500) NOT NULL,
         expected_impact VARCHAR(500) NOT NULL,
         confidence VARCHAR(16) NOT NULL,
         priority INTEGER NOT NULL,
         suggested_action VARCHAR(500) NOT NULL,
         counter_signal VARCHAR(500),
         render_status VARCHAR(24) NOT NULL DEFAULT ''active'',
         evidence_json JSONB NOT NULL DEFAULT ''[]''::jsonb,
         generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         stale_at TIMESTAMPTZ NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_policy_recommendation_rows_snapshot_idx
       ON %I.ai_policy_recommendation_rows (snapshot_id, priority DESC)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_policy_recommendation_rows_recommendation_idx
       ON %I.ai_policy_recommendation_rows (office_id, recommendation_id)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.ai_policy_recommendation_feedback (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         office_id UUID NOT NULL REFERENCES public.offices(id),
         recommendation_id UUID NOT NULL,
         user_id UUID NOT NULL REFERENCES public.users(id),
         feedback_value VARCHAR(24) NOT NULL,
         comment TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS ai_policy_recommendation_feedback_office_id_recommendation_id_user_id_uidx
       ON %I.ai_policy_recommendation_feedback (office_id, recommendation_id, user_id)',
      schema_name
    );
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  CREATE TABLE IF NOT EXISTS ai_policy_recommendation_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    office_id UUID NOT NULL REFERENCES public.offices(id),
    status VARCHAR(24) NOT NULL,
    requested_by_user_id UUID REFERENCES public.users(id),
    supersedes_snapshot_id UUID,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stale_at TIMESTAMPTZ NOT NULL,
    superseded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ai_policy_recommendation_snapshots_office_id_status_idx
    ON ai_policy_recommendation_snapshots (office_id, status, generated_at DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS ai_policy_recommendation_snapshots_pending_uidx
    ON ai_policy_recommendation_snapshots (office_id)
    WHERE status = 'pending';

  CREATE TABLE IF NOT EXISTS ai_policy_recommendation_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id UUID NOT NULL REFERENCES ai_policy_recommendation_snapshots(id) ON DELETE CASCADE,
    office_id UUID NOT NULL REFERENCES public.offices(id),
    recommendation_id UUID NOT NULL,
    taxonomy VARCHAR(48) NOT NULL,
    primary_grouping_key VARCHAR(120) NOT NULL,
    title VARCHAR(255) NOT NULL,
    statement VARCHAR(500) NOT NULL,
    why_now VARCHAR(500) NOT NULL,
    expected_impact VARCHAR(500) NOT NULL,
    confidence VARCHAR(16) NOT NULL,
    priority INTEGER NOT NULL,
    suggested_action VARCHAR(500) NOT NULL,
    counter_signal VARCHAR(500),
    render_status VARCHAR(24) NOT NULL DEFAULT 'active',
    evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stale_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ai_policy_recommendation_rows_snapshot_idx
    ON ai_policy_recommendation_rows (snapshot_id, priority DESC);

  CREATE INDEX IF NOT EXISTS ai_policy_recommendation_rows_recommendation_idx
    ON ai_policy_recommendation_rows (office_id, recommendation_id);

  CREATE TABLE IF NOT EXISTS ai_policy_recommendation_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    office_id UUID NOT NULL REFERENCES public.offices(id),
    recommendation_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES public.users(id),
    feedback_value VARCHAR(24) NOT NULL,
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS ai_policy_recommendation_feedback_office_id_recommendation_id_user_id_uidx
    ON ai_policy_recommendation_feedback (office_id, recommendation_id, user_id);
END $tenant$;
-- TENANT_SCHEMA_END
