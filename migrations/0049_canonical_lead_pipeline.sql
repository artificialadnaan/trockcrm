-- Migration 0049: Canonical lead pipeline
-- Promote the live lead pipeline to the approved CRM-owned stages:
-- New Lead -> Qualified Lead -> Sales Validation Stage.
-- Legacy lead stages remain in history but are retired from the active board.

INSERT INTO public.pipeline_stage_config (
  name,
  slug,
  display_order,
  workflow_family,
  is_active_pipeline,
  is_terminal,
  color
)
VALUES
  ('New Lead', 'new_lead', 1, 'lead', true, false, '#2563EB'),
  ('Qualified Lead', 'qualified_lead', 2, 'lead', true, false, '#0EA5E9'),
  ('Sales Validation Stage', 'sales_validation_stage', 3, 'lead', true, false, '#F59E0B')
ON CONFLICT (slug) DO UPDATE
SET
  name = EXCLUDED.name,
  display_order = EXCLUDED.display_order,
  workflow_family = EXCLUDED.workflow_family,
  is_active_pipeline = EXCLUDED.is_active_pipeline,
  is_terminal = EXCLUDED.is_terminal,
  color = EXCLUDED.color;

UPDATE public.pipeline_stage_config
SET
  is_active_pipeline = false,
  display_order = GREATEST(display_order, 90)
WHERE workflow_family = 'lead'
  AND slug IN ('contacted', 'lead_new', 'company_pre_qualified', 'scoping_in_progress', 'pre_qual_value_assigned', 'lead_go_no_go', 'qualified_for_opportunity', 'director_go_no_go', 'ready_for_opportunity');

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
             (legacy.slug IN ('contacted', 'lead_new', 'company_pre_qualified', 'scoping_in_progress', 'new_lead') AND canonical.slug = 'new_lead') OR
             (legacy.slug IN ('qualified_lead', 'pre_qual_value_assigned', 'director_go_no_go') AND canonical.slug = 'qualified_lead') OR
             (legacy.slug IN ('lead_go_no_go', 'qualified_for_opportunity', 'ready_for_opportunity', 'sales_validation_stage') AND canonical.slug = 'sales_validation_stage')
           )
          WHERE legacy.workflow_family = 'lead'
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
