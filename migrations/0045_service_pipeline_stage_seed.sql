-- Migration 0045: Seed service pipeline stages for workflow routing
-- The workflow alignment release introduced service routing but did not seed
-- an active service_deal stage family. This forward migration backfills the
-- entry and working stages so under-threshold opportunity routing can land in
-- a valid pipeline immediately. Terminal closed_won/closed_lost stages remain
-- shared until the operating team finalizes dedicated service close states.

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
  ('Service Review', 'service_review', 1, 'service_deal', true, false, '#10B981'),
  ('Service Proposal Sent', 'service_proposal_sent', 2, 'service_deal', true, false, '#059669'),
  ('Service Scheduled', 'service_scheduled', 3, 'service_deal', true, false, '#14B8A6'),
  ('Service Complete', 'service_complete', 4, 'service_deal', true, false, '#0F766E')
ON CONFLICT (slug) DO UPDATE
SET
  name = EXCLUDED.name,
  display_order = EXCLUDED.display_order,
  workflow_family = EXCLUDED.workflow_family,
  is_active_pipeline = EXCLUDED.is_active_pipeline,
  is_terminal = EXCLUDED.is_terminal,
  color = EXCLUDED.color;
