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
         d.workflow_route,
         ''draft''::%I.deal_scoping_intake_status,
         ''{}''::jsonb,
         ''{}''::jsonb,
         ''{}''::jsonb,
         COALESCE(d.updated_at, d.created_at, NOW()),
         d.assigned_rep_id,
         d.assigned_rep_id,
         COALESCE(d.created_at, NOW()),
         COALESCE(d.updated_at, d.created_at, NOW())
       FROM %I.deals d
       JOIN public.users u ON u.id = d.assigned_rep_id
       LEFT JOIN %I.deal_scoping_intake dsi ON dsi.deal_id = d.id
       WHERE dsi.deal_id IS NULL
         AND u.office_id IS NOT NULL
       ON CONFLICT (deal_id) DO NOTHING',
      schema_name,
      schema_name,
      schema_name,
      schema_name
    );
  END LOOP;
END $$;
