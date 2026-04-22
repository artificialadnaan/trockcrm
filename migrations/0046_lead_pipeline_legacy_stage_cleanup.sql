-- Migration 0046: Retire legacy lead pipeline stages after workflow alignment
-- The aligned lead workflow starts at New and should no longer expose the
-- pre-alignment Contacted/legacy intermediate stages in the active board.

UPDATE public.pipeline_stage_config
SET
  is_active_pipeline = false,
  display_order = GREATEST(display_order, 90)
WHERE workflow_family = 'lead'
  AND slug IN ('contacted', 'qualified_lead', 'director_go_no_go', 'ready_for_opportunity');

UPDATE public.pipeline_stage_config
SET
  is_active_pipeline = true,
  display_order = 1
WHERE workflow_family = 'lead'
  AND slug = 'lead_new';
