-- Migration 0047: Remap open leads out of legacy lead stages
-- Earlier cleanup retired legacy stage slugs. Existing open leads still need to
-- be moved into the aligned canonical stages so they remain visible on the lead
-- board and follow the gated qualification workflow.

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
UPDATE public.leads AS l
SET stage_id = stage_map.canonical_stage_id
FROM stage_map
WHERE l.stage_id = stage_map.legacy_stage_id
  AND l.status = 'open'
  AND l.is_active = true;
