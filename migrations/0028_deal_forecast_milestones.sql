DO $$
DECLARE
  schema_name text;
  audit_log_exists boolean;
  deal_workflow_route_expr text;
  deal_expected_close_date_expr text;
  deal_dd_estimate_expr text;
  deal_bid_estimate_expr text;
  deal_awarded_amount_expr text;
  deal_source_expr text;
  deal_actual_close_date_expr text;
  deal_group_by_expr text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
         FROM information_schema.tables
         WHERE table_schema = %L
           AND table_name = %L
       )',
      schema_name,
      'audit_log'
    ) INTO audit_log_exists;

    deal_workflow_route_expr := CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = schema_name
          AND table_name = 'deals'
          AND column_name = 'workflow_route'
      ) THEN 'd.workflow_route::text'
      ELSE quote_literal('estimating')
    END;

    deal_expected_close_date_expr := CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = schema_name
          AND table_name = 'deals'
          AND column_name = 'expected_close_date'
      ) THEN 'd.expected_close_date'
      ELSE 'NULL::date'
    END;

    deal_dd_estimate_expr := CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = schema_name
          AND table_name = 'deals'
          AND column_name = 'dd_estimate'
      ) THEN 'd.dd_estimate'
      ELSE 'NULL::numeric'
    END;

    deal_bid_estimate_expr := CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = schema_name
          AND table_name = 'deals'
          AND column_name = 'bid_estimate'
      ) THEN 'd.bid_estimate'
      ELSE 'NULL::numeric'
    END;

    deal_awarded_amount_expr := CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = schema_name
          AND table_name = 'deals'
          AND column_name = 'awarded_amount'
      ) THEN 'd.awarded_amount'
      ELSE 'NULL::numeric'
    END;

    deal_source_expr := CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = schema_name
          AND table_name = 'deals'
          AND column_name = 'source'
      ) THEN 'd.source'
      ELSE 'NULL::varchar'
    END;

    deal_actual_close_date_expr := CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = schema_name
          AND table_name = 'deals'
          AND column_name = 'actual_close_date'
      ) THEN 'd.actual_close_date::timestamptz'
      ELSE 'NULL::timestamptz'
    END;

    deal_group_by_expr := 'dsh.deal_id, d.assigned_rep_id';
    IF deal_workflow_route_expr = 'd.workflow_route::text' THEN
      deal_group_by_expr := deal_group_by_expr || ', d.workflow_route';
    END IF;
    IF deal_expected_close_date_expr = 'd.expected_close_date' THEN
      deal_group_by_expr := deal_group_by_expr || ', d.expected_close_date';
    END IF;
    IF deal_dd_estimate_expr = 'd.dd_estimate' THEN
      deal_group_by_expr := deal_group_by_expr || ', d.dd_estimate';
    END IF;
    IF deal_bid_estimate_expr = 'd.bid_estimate' THEN
      deal_group_by_expr := deal_group_by_expr || ', d.bid_estimate';
    END IF;
    IF deal_awarded_amount_expr = 'd.awarded_amount' THEN
      deal_group_by_expr := deal_group_by_expr || ', d.awarded_amount';
    END IF;
    IF deal_source_expr = 'd.source' THEN
      deal_group_by_expr := deal_group_by_expr || ', d.source';
    END IF;

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
         workflow_route VARCHAR(32) NOT NULL,
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
         (ARRAY_AGG(dsh.to_stage_id ORDER BY dsh.created_at ASC))[1],
         %s,
         %s,
         %s,
         %s,
         %s,
         COALESCE(%s, %s, %s, 0),
         %s,
         ''audit_backfill''::%I.forecast_milestone_capture_source
       FROM %I.deal_stage_history dsh
       JOIN %I.deals d ON d.id = dsh.deal_id
       JOIN public.pipeline_stage_config psc ON psc.id = dsh.to_stage_id
       WHERE psc.slug = ''dd''
       GROUP BY %s
      ON CONFLICT (deal_id, milestone_key) DO NOTHING',
      schema_name,
      schema_name,
      deal_workflow_route_expr,
      deal_expected_close_date_expr,
      deal_dd_estimate_expr,
      deal_bid_estimate_expr,
      deal_awarded_amount_expr,
      deal_awarded_amount_expr,
      deal_bid_estimate_expr,
      deal_dd_estimate_expr,
      deal_source_expr,
      schema_name,
      schema_name,
      schema_name,
      deal_group_by_expr
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
         (ARRAY_AGG(dsh.to_stage_id ORDER BY dsh.created_at ASC))[1],
         %s,
         %s,
         %s,
         %s,
         %s,
         COALESCE(%s, %s, %s, 0),
         %s,
         ''audit_backfill''::%I.forecast_milestone_capture_source
       FROM %I.deal_stage_history dsh
       JOIN %I.deals d ON d.id = dsh.deal_id
       JOIN public.pipeline_stage_config psc ON psc.id = dsh.to_stage_id
       WHERE psc.slug = ''estimating''
       GROUP BY %s
      ON CONFLICT (deal_id, milestone_key) DO NOTHING',
      schema_name,
      schema_name,
      deal_workflow_route_expr,
      deal_expected_close_date_expr,
      deal_dd_estimate_expr,
      deal_bid_estimate_expr,
      deal_awarded_amount_expr,
      deal_awarded_amount_expr,
      deal_bid_estimate_expr,
      deal_dd_estimate_expr,
      deal_source_expr,
      schema_name,
      schema_name,
      schema_name,
      deal_group_by_expr
    );

    IF audit_log_exists THEN
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
           COALESCE(NULLIF(a.full_row->>''assigned_rep_id'', '''')::uuid, d.assigned_rep_id),
           NULLIF(a.full_row->>''stage_id'', '''')::uuid,
           COALESCE(NULLIF(a.full_row->>''workflow_route'', ''''), %s),
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
           COALESCE(NULLIF(a.full_row->>''source'', ''''), %s),
           ''audit_backfill''::%I.forecast_milestone_capture_source
         FROM %I.audit_log a
         JOIN %I.deals d ON d.id = a.record_id
         WHERE a.table_name = ''deals''
           AND a.action = ''insert''
           AND a.full_row IS NOT NULL
        ON CONFLICT (deal_id, milestone_key) DO NOTHING',
        schema_name,
        schema_name,
        deal_workflow_route_expr,
        deal_source_expr,
        schema_name,
        schema_name,
        schema_name
      );
    END IF;

    IF audit_log_exists THEN
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
           COALESCE(%s, d.updated_at, NOW()),
           NULL,
           COALESCE(close_rep.assigned_rep_id, d.assigned_rep_id),
           d.stage_id,
           %s,
           %s,
           %s,
           %s,
           %s,
           COALESCE(%s, %s, %s, 0),
           %s,
           ''audit_backfill''::%I.forecast_milestone_capture_source
         FROM %I.deals d
         LEFT JOIN LATERAL (
           SELECT NULLIF(a.full_row->>''assigned_rep_id'', '''')::uuid AS assigned_rep_id
           FROM %I.audit_log a
           WHERE a.table_name = ''deals''
             AND a.record_id = d.id
             AND a.full_row IS NOT NULL
             AND a.created_at <= COALESCE(%s, d.updated_at, NOW())
           ORDER BY a.created_at DESC
           LIMIT 1
         ) close_rep ON TRUE
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         WHERE psc.slug = ''closed_won''
        ON CONFLICT (deal_id, milestone_key) DO NOTHING',
        schema_name,
        schema_name,
        deal_actual_close_date_expr,
        deal_workflow_route_expr,
        deal_expected_close_date_expr,
        deal_dd_estimate_expr,
        deal_bid_estimate_expr,
        deal_awarded_amount_expr,
        deal_awarded_amount_expr,
        deal_bid_estimate_expr,
        deal_dd_estimate_expr,
        deal_source_expr,
        schema_name,
        schema_name,
        schema_name,
        deal_actual_close_date_expr
      );
    ELSE
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
           COALESCE(%s, d.updated_at, NOW()),
           NULL,
           d.assigned_rep_id,
           d.stage_id,
           %s,
           %s,
           %s,
           %s,
           %s,
           COALESCE(%s, %s, %s, 0),
           %s,
           ''audit_backfill''::%I.forecast_milestone_capture_source
         FROM %I.deals d
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         WHERE psc.slug = ''closed_won''
        ON CONFLICT (deal_id, milestone_key) DO NOTHING',
        schema_name,
        schema_name,
        deal_actual_close_date_expr,
        deal_workflow_route_expr,
        deal_expected_close_date_expr,
        deal_dd_estimate_expr,
        deal_bid_estimate_expr,
        deal_awarded_amount_expr,
        deal_awarded_amount_expr,
        deal_bid_estimate_expr,
        deal_dd_estimate_expr,
        deal_source_expr,
        schema_name,
        schema_name
      );
    END IF;
  END LOOP;
END $$;
