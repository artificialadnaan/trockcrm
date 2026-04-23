-- Migration 0028: Sales workflow realignment
-- Adds the CRM-owned lead workflow fields and the read-only bid board mirror
-- metadata needed for the estimating handoff.

DO $$ BEGIN
  CREATE TYPE lead_pipeline_type AS ENUM ('service', 'normal');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE lead_disqualification_reason AS ENUM (
    'no_budget',
    'not_a_fit',
    'no_authority',
    'no_timeline',
    'duplicate',
    'unresponsive',
    'customer_declined',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE deal_pipeline_type_snapshot AS ENUM ('service', 'normal');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = nspname
          AND table_name = 'leads'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = nspname
          AND table_name = 'deals'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS pipeline_type lead_pipeline_type',
      schema_name
    );

    EXECUTE format(
      'UPDATE %I.leads
         SET pipeline_type = COALESCE(pipeline_type, ''normal''::lead_pipeline_type)',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ALTER COLUMN pipeline_type SET DEFAULT ''normal''::lead_pipeline_type',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ALTER COLUMN pipeline_type SET NOT NULL',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS existing_customer_resolution VARCHAR(50)',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS existing_customer_resolved_at TIMESTAMPTZ',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS existing_customer_resolved_by UUID REFERENCES public.users(id)',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS project_type_id UUID REFERENCES public.project_type_config(id)',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS qualification_payload JSONB NOT NULL DEFAULT ''{}''::jsonb',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS project_type_question_payload JSONB NOT NULL DEFAULT ''{}''::jsonb',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS pre_qual_value NUMERIC(14,2)',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS submission_started_at TIMESTAMPTZ',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS submission_completed_at TIMESTAMPTZ',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS submission_duration_seconds INTEGER',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS executive_decision VARCHAR(50)',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS executive_decision_at TIMESTAMPTZ',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS executive_decision_by UUID REFERENCES public.users(id)',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS disqualification_reason lead_disqualification_reason',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS disqualification_reason_notes TEXT',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS disqualified_at TIMESTAMPTZ',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.leads
         ADD COLUMN IF NOT EXISTS disqualified_by UUID REFERENCES public.users(id)',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS is_bid_board_owned BOOLEAN NOT NULL DEFAULT FALSE',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS bid_board_stage_slug VARCHAR(100)',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS bid_board_stage_status VARCHAR(50)',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS bid_board_stage_entered_at TIMESTAMPTZ',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS bid_board_stage_exited_at TIMESTAMPTZ',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS bid_board_stage_duration INTERVAL',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS bid_board_mirror_source_entered_at TIMESTAMPTZ',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS bid_board_mirror_source_exited_at TIMESTAMPTZ',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS pipeline_type_snapshot deal_pipeline_type_snapshot',
      schema_name
    );

    EXECUTE format(
      'UPDATE %I.deals
         SET pipeline_type_snapshot = COALESCE(
           pipeline_type_snapshot,
           CASE
             WHEN workflow_route = ''service'' THEN ''service''::deal_pipeline_type_snapshot
             ELSE ''normal''::deal_pipeline_type_snapshot
           END::deal_pipeline_type_snapshot
         )
       WHERE pipeline_type_snapshot IS NULL',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ALTER COLUMN pipeline_type_snapshot SET DEFAULT ''normal''::deal_pipeline_type_snapshot',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ALTER COLUMN pipeline_type_snapshot SET NOT NULL',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS region_classification VARCHAR(50)',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS is_read_only_mirror BOOLEAN NOT NULL DEFAULT FALSE',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS is_read_only_sync_dirty BOOLEAN NOT NULL DEFAULT FALSE',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.deals
         ADD COLUMN IF NOT EXISTS read_only_synced_at TIMESTAMPTZ',
      schema_name
    );
  END LOOP;
END $$;
