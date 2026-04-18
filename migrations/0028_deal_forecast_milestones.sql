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
      'DO $inner$
       BEGIN
         IF NOT EXISTS (
           SELECT 1
           FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE t.typname = ''forecast_milestone_key''
             AND n.nspname = %L
         ) THEN
           EXECUTE ''CREATE TYPE %I.forecast_milestone_key AS ENUM (''''initial'''', ''''qualified'''', ''''estimating'''', ''''closed_won'''')'';
         END IF;

         IF NOT EXISTS (
           SELECT 1
           FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE t.typname = ''forecast_milestone_capture_source''
             AND n.nspname = %L
         ) THEN
           EXECUTE ''CREATE TYPE %I.forecast_milestone_capture_source AS ENUM (''''live'''', ''''audit_backfill'''')'';
         END IF;
       END
       $inner$;',
      schema_name,
      schema_name,
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.deal_forecast_milestones (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL,
         milestone_key %I.forecast_milestone_key NOT NULL,
         captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         captured_by UUID,
         assigned_rep_id UUID NOT NULL,
         stage_id UUID,
         workflow_route %I.workflow_route NOT NULL,
         expected_close_date DATE,
         dd_estimate NUMERIC(14, 2),
         bid_estimate NUMERIC(14, 2),
         awarded_amount NUMERIC(14, 2),
         forecast_amount NUMERIC(14, 2) NOT NULL,
         source VARCHAR(100),
         capture_source %I.forecast_milestone_capture_source NOT NULL DEFAULT ''live'',
         CONSTRAINT deal_forecast_milestones_deal_fk
           FOREIGN KEY (deal_id) REFERENCES %I.deals(id) ON DELETE CASCADE
       )',
      schema_name,
      schema_name,
      schema_name,
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS deal_forecast_milestones_deal_milestone_uidx
         ON %I.deal_forecast_milestones (deal_id, milestone_key)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deal_forecast_milestones_captured_at_idx
         ON %I.deal_forecast_milestones (captured_at)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deal_forecast_milestones_stage_idx
         ON %I.deal_forecast_milestones (stage_id, captured_at)',
      schema_name
    );

    EXECUTE format(
      'INSERT INTO %I.deal_forecast_milestones (
         deal_id,
         milestone_key,
         captured_at,
         captured_by,
         assigned_rep_id,
         stage_id,
         workflow_route,
         expected_close_date,
         dd_estimate,
         bid_estimate,
         awarded_amount,
         forecast_amount,
         source,
         capture_source
       )
       SELECT
         dsh.deal_id,
         ''qualified''::%I.forecast_milestone_key,
         MIN(dsh.created_at),
         NULL,
         d.assigned_rep_id,
         MIN(dsh.to_stage_id),
         d.workflow_route,
         d.expected_close_date,
         d.dd_estimate,
         d.bid_estimate,
         d.awarded_amount,
         COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0),
         d.source,
         ''audit_backfill''::%I.forecast_milestone_capture_source
       FROM %I.deal_stage_history dsh
       JOIN %I.deals d ON d.id = dsh.deal_id
       JOIN public.pipeline_stage_config psc ON psc.id = dsh.to_stage_id
       WHERE psc.slug = ''dd''
       GROUP BY dsh.deal_id, d.workflow_route, d.expected_close_date, d.dd_estimate, d.bid_estimate, d.awarded_amount, d.source
       ON CONFLICT (deal_id, milestone_key) DO NOTHING',
      schema_name,
      schema_name,
      schema_name,
      schema_name,
      schema_name
    );

    EXECUTE format(
      'INSERT INTO %I.deal_forecast_milestones (
         deal_id,
         milestone_key,
         captured_at,
         captured_by,
         assigned_rep_id,
         stage_id,
         workflow_route,
         expected_close_date,
         dd_estimate,
         bid_estimate,
         awarded_amount,
         forecast_amount,
         source,
         capture_source
       )
       SELECT
         dsh.deal_id,
         ''estimating''::%I.forecast_milestone_key,
         MIN(dsh.created_at),
         NULL,
         d.assigned_rep_id,
         MIN(dsh.to_stage_id),
         d.workflow_route,
         d.expected_close_date,
         d.dd_estimate,
         d.bid_estimate,
         d.awarded_amount,
         COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0),
         d.source,
         ''audit_backfill''::%I.forecast_milestone_capture_source
       FROM %I.deal_stage_history dsh
       JOIN %I.deals d ON d.id = dsh.deal_id
       JOIN public.pipeline_stage_config psc ON psc.id = dsh.to_stage_id
       WHERE psc.slug = ''estimating''
       GROUP BY dsh.deal_id, d.workflow_route, d.expected_close_date, d.dd_estimate, d.bid_estimate, d.awarded_amount, d.source
       ON CONFLICT (deal_id, milestone_key) DO NOTHING',
      schema_name,
      schema_name,
      schema_name,
      schema_name,
      schema_name
    );

    EXECUTE format(
      'INSERT INTO %I.deal_forecast_milestones (
         deal_id,
         milestone_key,
         captured_at,
         captured_by,
         assigned_rep_id,
         stage_id,
         workflow_route,
         expected_close_date,
         dd_estimate,
         bid_estimate,
         awarded_amount,
         forecast_amount,
         source,
         capture_source
       )
       SELECT
         a.record_id,
         ''initial''::%I.forecast_milestone_key,
         a.created_at,
         a.changed_by,
         d.assigned_rep_id,
         NULLIF(a.full_row->>''stage_id'', '''')::uuid,
         COALESCE(NULLIF(a.full_row->>''workflow_route'', ''''), d.workflow_route::text)::%I.workflow_route,
         NULLIF(a.full_row->>''expected_close_date'', '''')::date,
         NULLIF(a.full_row->>''dd_estimate'', '''')::numeric,
         NULLIF(a.full_row->>''bid_estimate'', '''')::numeric,
         NULLIF(a.full_row->>''awarded_amount'', '''')::numeric,
         COALESCE(
           NULLIF(a.full_row->>''awarded_amount'', '''')::numeric,
           NULLIF(a.full_row->>''bid_estimate'', '''')::numeric,
           NULLIF(a.full_row->>''dd_estimate'', '''')::numeric,
           0
         ),
         COALESCE(NULLIF(a.full_row->>''source'', ''''), d.source),
         ''audit_backfill''::%I.forecast_milestone_capture_source
       FROM %I.audit_log a
       JOIN %I.deals d ON d.id = a.record_id
       WHERE a.table_name = ''deals''
         AND a.action = ''insert''
         AND a.full_row IS NOT NULL
       ON CONFLICT (deal_id, milestone_key) DO NOTHING',
      schema_name,
      schema_name,
      schema_name,
      schema_name,
      schema_name,
      schema_name
    );

    EXECUTE format(
      'INSERT INTO %I.deal_forecast_milestones (
         deal_id,
         milestone_key,
         captured_at,
         captured_by,
         assigned_rep_id,
         stage_id,
         workflow_route,
         expected_close_date,
         dd_estimate,
         bid_estimate,
         awarded_amount,
         forecast_amount,
         source,
         capture_source
       )
       SELECT
         d.id,
         ''closed_won''::%I.forecast_milestone_key,
         COALESCE(d.actual_close_date::timestamptz, d.updated_at, NOW()),
         NULL,
         d.assigned_rep_id,
         d.stage_id,
         d.workflow_route,
         d.expected_close_date,
         d.dd_estimate,
         d.bid_estimate,
         d.awarded_amount,
         COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0),
         d.source,
         ''audit_backfill''::%I.forecast_milestone_capture_source
       FROM %I.deals d
       JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
       WHERE psc.slug = ''closed_won''
       ON CONFLICT (deal_id, milestone_key) DO NOTHING',
      schema_name,
      schema_name,
      schema_name,
      schema_name
    );
  END LOOP;
END $$;
