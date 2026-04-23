-- Migration 0047: Remap open leads out of legacy lead stages
-- Legacy lead stages were retired from the active pipeline. Existing tenant
-- lead rows still need to be reassigned into the aligned canonical stages.

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
  LOOP
    EXECUTE format(
      $sql$
        WITH stage_map AS (
          SELECT legacy.id AS legacy_stage_id, canonical.id AS canonical_stage_id
          FROM public.pipeline_stage_config legacy
          JOIN public.pipeline_stage_config canonical
            ON canonical.workflow_family = 'lead'
           AND (
             (legacy.slug = 'contacted' AND canonical.slug = 'lead_new') OR
             (legacy.slug = 'qualified_lead' AND canonical.slug = 'pre_qual_value_assigned') OR
             (legacy.slug = 'director_go_no_go' AND canonical.slug = 'lead_go_no_go') OR
             (legacy.slug = 'ready_for_opportunity' AND canonical.slug = 'qualified_for_opportunity')
           )
          WHERE legacy.workflow_family = 'lead'
            AND legacy.slug IN ('contacted', 'qualified_lead', 'director_go_no_go', 'ready_for_opportunity')
        )
        UPDATE %I.leads AS l
        SET stage_id = stage_map.canonical_stage_id
        FROM stage_map
        WHERE l.stage_id = stage_map.legacy_stage_id
          AND l.status = 'open'
          AND l.is_active = true
      $sql$,
      schema_name
    );
  END LOOP;
END $$;
