DO $$
DECLARE
  schema_name text;
  intake_table_exists boolean;
  deal_workflow_route_expr text;
  deal_assigned_rep_id_expr text;
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
      'deal_scoping_intake'
    ) INTO intake_table_exists;

    IF NOT intake_table_exists THEN
      CONTINUE;
    END IF;

    deal_workflow_route_expr := CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = schema_name
          AND table_name = 'deals'
          AND column_name = 'workflow_route'
      ) THEN 'd.workflow_route'
      ELSE quote_literal('estimating')
    END;

    deal_assigned_rep_id_expr := CASE
      WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = schema_name
          AND table_name = 'deals'
          AND column_name = 'assigned_rep_id'
      ) THEN 'd.assigned_rep_id'
      ELSE 'NULL::uuid'
    END;

    EXECUTE format(
      'INSERT INTO %I.deal_scoping_intake (
         deal_id,
         office_id,
         workflow_route_snapshot,
         status,
         section_data,
         completion_state,
         readiness_errors,
         last_autosaved_at,
         created_by,
         last_edited_by,
         created_at,
         updated_at
       )
       SELECT
         d.id,
         u.office_id,
         %s,
         ''draft''::%I.deal_scoping_intake_status,
         ''{}''::jsonb,
         ''{}''::jsonb,
         ''{}''::jsonb,
         COALESCE(d.updated_at, d.created_at, NOW()),
         %s,
         %s,
         COALESCE(d.created_at, NOW()),
         COALESCE(d.updated_at, d.created_at, NOW())
       FROM %I.deals d
       JOIN public.users u ON u.id = %s
       LEFT JOIN %I.deal_scoping_intake dsi ON dsi.deal_id = d.id
       WHERE dsi.deal_id IS NULL
         AND u.office_id IS NOT NULL
       ON CONFLICT (deal_id) DO NOTHING',
      schema_name,
      deal_workflow_route_expr,
      deal_assigned_rep_id_expr,
      deal_assigned_rep_id_expr,
      schema_name,
      deal_assigned_rep_id_expr,
      schema_name,
      schema_name
    );
  END LOOP;
END $$;
