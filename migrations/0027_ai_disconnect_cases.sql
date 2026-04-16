-- Migration 0027: AI disconnect case workspace tables

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
      'CREATE TABLE IF NOT EXISTS %I.ai_disconnect_cases (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         office_id UUID NOT NULL,
         scope_type VARCHAR(40) NOT NULL,
         scope_id UUID NOT NULL,
         deal_id UUID,
         company_id UUID,
         disconnect_type VARCHAR(80) NOT NULL,
         cluster_key VARCHAR(80),
         business_key VARCHAR(255) NOT NULL,
         severity VARCHAR(20) NOT NULL,
         status VARCHAR(20) NOT NULL DEFAULT ''open'',
         assigned_to UUID,
         generated_task_id UUID,
         escalated BOOLEAN NOT NULL DEFAULT false,
         snoozed_until TIMESTAMPTZ,
         reopen_count INTEGER NOT NULL DEFAULT 0,
         first_detected_at TIMESTAMPTZ NOT NULL,
         last_detected_at TIMESTAMPTZ NOT NULL,
         last_intervened_at TIMESTAMPTZ,
         resolved_at TIMESTAMPTZ,
         resolution_reason VARCHAR(80),
         metadata_json JSONB,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS ai_disconnect_cases_office_business_key_uidx
         ON %I.ai_disconnect_cases (office_id, business_key)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_disconnect_cases_status_idx
         ON %I.ai_disconnect_cases (status, escalated, assigned_to)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.ai_disconnect_case_history (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         disconnect_case_id UUID NOT NULL,
         action_type VARCHAR(40) NOT NULL,
         acted_by UUID NOT NULL,
         acted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         from_status VARCHAR(20),
         to_status VARCHAR(20),
         from_assignee UUID,
         to_assignee UUID,
         from_snoozed_until TIMESTAMPTZ,
         to_snoozed_until TIMESTAMPTZ,
         notes TEXT,
         metadata_json JSONB
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS ai_disconnect_case_history_case_idx
         ON %I.ai_disconnect_case_history (disconnect_case_id, acted_at DESC)',
      schema_name
    );
  END LOOP;
END $$;
