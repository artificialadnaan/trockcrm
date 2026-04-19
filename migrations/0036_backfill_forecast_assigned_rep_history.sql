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

    IF NOT audit_log_exists THEN
      CONTINUE;
    END IF;

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
         COALESCE(NULLIF(a.full_row->>''workflow_route'', ''''), ''estimating''),
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
         NULLIF(a.full_row->>''source'', ''''),
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
      schema_name
    );

    EXECUTE format(
      'UPDATE %I.deal_forecast_milestones m
       SET assigned_rep_id = src.assigned_rep_id
       FROM (
         SELECT
           m_inner.id AS milestone_id,
           NULLIF(a.full_row->>''assigned_rep_id'', '''')::uuid AS assigned_rep_id
         FROM %I.deal_forecast_milestones m_inner
         JOIN %I.audit_log a
           ON a.record_id = m_inner.deal_id
          AND a.table_name = ''deals''
          AND a.action = ''insert''
          AND a.full_row IS NOT NULL
         WHERE m_inner.milestone_key = ''initial''
           AND m_inner.capture_source = ''audit_backfill''
       ) src
       WHERE m.id = src.milestone_id
         AND src.assigned_rep_id IS NOT NULL
         AND m.assigned_rep_id IS DISTINCT FROM src.assigned_rep_id',
      schema_name,
      schema_name,
      schema_name
    );

    EXECUTE format(
      'WITH close_events AS (
         SELECT DISTINCT ON (dsh.deal_id)
           dsh.deal_id,
           dsh.to_stage_id AS stage_id,
           dsh.created_at AS captured_at
         FROM %I.deal_stage_history dsh
         JOIN public.pipeline_stage_config psc ON psc.id = dsh.to_stage_id
         WHERE psc.slug = ''closed_won''
         ORDER BY dsh.deal_id, dsh.created_at DESC
       )
       INSERT INTO %I.deal_forecast_milestones (
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
         COALESCE(close_events.captured_at, %s, d.updated_at, NOW()),
         NULL,
         COALESCE(close_snapshot.assigned_rep_id, d.assigned_rep_id),
         COALESCE(close_events.stage_id, d.stage_id),
         COALESCE(close_snapshot.workflow_route, %s, ''estimating''),
         COALESCE(close_snapshot.expected_close_date, %s),
         COALESCE(close_snapshot.dd_estimate, %s),
         COALESCE(close_snapshot.bid_estimate, %s),
         COALESCE(close_snapshot.awarded_amount, %s),
         COALESCE(
           close_snapshot.awarded_amount,
           close_snapshot.bid_estimate,
           close_snapshot.dd_estimate,
           %s,
           %s,
           %s,
           0
         ),
         COALESCE(close_snapshot.source, %s),
         ''audit_backfill''::%I.forecast_milestone_capture_source
       FROM %I.deals d
       LEFT JOIN close_events ON close_events.deal_id = d.id
       LEFT JOIN LATERAL (
         SELECT
           NULLIF(a.full_row->>''assigned_rep_id'', '''')::uuid AS assigned_rep_id,
           NULLIF(a.full_row->>''workflow_route'', '''') AS workflow_route,
           NULLIF(a.full_row->>''expected_close_date'', '''')::date AS expected_close_date,
           NULLIF(a.full_row->>''dd_estimate'', '''')::numeric AS dd_estimate,
           NULLIF(a.full_row->>''bid_estimate'', '''')::numeric AS bid_estimate,
           NULLIF(a.full_row->>''awarded_amount'', '''')::numeric AS awarded_amount,
           NULLIF(a.full_row->>''source'', '''') AS source
         FROM %I.audit_log a
         WHERE a.table_name = ''deals''
           AND a.record_id = d.id
           AND a.full_row IS NOT NULL
           AND a.created_at <= COALESCE(close_events.captured_at, %s, d.updated_at, NOW())
         ORDER BY a.created_at DESC
         LIMIT 1
       ) close_snapshot ON TRUE
       LEFT JOIN public.pipeline_stage_config current_stage ON current_stage.id = d.stage_id
       WHERE close_events.deal_id IS NOT NULL OR current_stage.slug = ''closed_won''
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
      schema_name,
      deal_actual_close_date_expr
    );

    EXECUTE format(
      'WITH close_events AS (
         SELECT DISTINCT ON (dsh.deal_id)
           dsh.deal_id,
           dsh.to_stage_id AS stage_id,
           dsh.created_at AS captured_at
         FROM %I.deal_stage_history dsh
         JOIN public.pipeline_stage_config psc ON psc.id = dsh.to_stage_id
         WHERE psc.slug = ''closed_won''
         ORDER BY dsh.deal_id, dsh.created_at DESC
       )
       UPDATE %I.deal_forecast_milestones m
       SET
         assigned_rep_id = COALESCE(src.assigned_rep_id, m.assigned_rep_id),
         stage_id = COALESCE(src.stage_id, m.stage_id),
         workflow_route = COALESCE(src.workflow_route, m.workflow_route),
         expected_close_date = COALESCE(src.expected_close_date, m.expected_close_date),
         dd_estimate = COALESCE(src.dd_estimate, m.dd_estimate),
         bid_estimate = COALESCE(src.bid_estimate, m.bid_estimate),
         awarded_amount = COALESCE(src.awarded_amount, m.awarded_amount),
         forecast_amount = COALESCE(
           src.awarded_amount,
           src.bid_estimate,
           src.dd_estimate,
           m.forecast_amount
         ),
         source = COALESCE(src.source, m.source)
       FROM (
         SELECT
           m_inner.id AS milestone_id,
           COALESCE(close_snapshot.assigned_rep_id, d.assigned_rep_id) AS assigned_rep_id,
           COALESCE(close_events.stage_id, m_inner.stage_id) AS stage_id,
           COALESCE(close_snapshot.workflow_route, %s, ''estimating'') AS workflow_route,
           COALESCE(close_snapshot.expected_close_date, %s) AS expected_close_date,
           COALESCE(close_snapshot.dd_estimate, %s) AS dd_estimate,
           COALESCE(close_snapshot.bid_estimate, %s) AS bid_estimate,
           COALESCE(close_snapshot.awarded_amount, %s) AS awarded_amount,
           COALESCE(close_snapshot.source, %s) AS source
         FROM %I.deal_forecast_milestones m_inner
         JOIN %I.deals d ON d.id = m_inner.deal_id
         LEFT JOIN close_events ON close_events.deal_id = m_inner.deal_id
         LEFT JOIN LATERAL (
           SELECT
             NULLIF(a.full_row->>''assigned_rep_id'', '''')::uuid AS assigned_rep_id,
             NULLIF(a.full_row->>''workflow_route'', '''') AS workflow_route,
             NULLIF(a.full_row->>''expected_close_date'', '''')::date AS expected_close_date,
             NULLIF(a.full_row->>''dd_estimate'', '''')::numeric AS dd_estimate,
             NULLIF(a.full_row->>''bid_estimate'', '''')::numeric AS bid_estimate,
             NULLIF(a.full_row->>''awarded_amount'', '''')::numeric AS awarded_amount,
             NULLIF(a.full_row->>''source'', '''') AS source
           FROM %I.audit_log a
         WHERE a.table_name = ''deals''
           AND a.record_id = m_inner.deal_id
           AND a.full_row IS NOT NULL
           AND a.created_at <= COALESCE(close_events.captured_at, %s, m_inner.captured_at)
          ORDER BY a.created_at DESC
          LIMIT 1
        ) close_snapshot ON TRUE
         WHERE m_inner.milestone_key = ''closed_won''
           AND m_inner.capture_source = ''audit_backfill''
       ) src
       WHERE m.id = src.milestone_id',
      schema_name,
      schema_name,
      schema_name,
      schema_name,
      deal_workflow_route_expr,
      deal_expected_close_date_expr,
      deal_dd_estimate_expr,
      deal_bid_estimate_expr,
      deal_awarded_amount_expr,
      deal_source_expr,
      schema_name,
      deal_actual_close_date_expr
    );
  END LOOP;
END $$;
