-- Migration 0048: Reconcile lead records that already have successor deals
-- Some historical rows still appear as active/open leads even though a deal
-- already points back to them via source_lead_id. Mark those leads converted so
-- they no longer pollute the active lead dashboard or lead board.

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
      $sql$
        WITH converted_stage AS (
          SELECT id
          FROM public.pipeline_stage_config
          WHERE workflow_family = 'lead'
            AND slug = 'converted'
          LIMIT 1
        )
        UPDATE %I.leads AS l
        SET
          stage_id = converted_stage.id,
          status = 'converted',
          is_active = false,
          converted_at = COALESCE(l.converted_at, d.created_at, NOW()),
          updated_at = NOW()
        FROM %I.deals AS d
        CROSS JOIN converted_stage
        WHERE d.source_lead_id = l.id
          AND (
            l.status <> 'converted'
            OR l.is_active = true
            OR l.stage_id <> converted_stage.id
            OR l.converted_at IS NULL
          )
      $sql$,
      schema_name,
      schema_name
    );
  END LOOP;
END $$;
