-- Migration 0045: Seed service pipeline stages for workflow routing
-- The workflow alignment release introduced service routing but did not seed
-- an active service_deal stage family. This forward migration backfills the
-- mirrored service stages so under-threshold opportunity routing can land in
-- the correct Bid Board-aligned service pipeline immediately.

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
  ('Service - Estimating', 'service_estimating', 3, 'service_deal', true, false, '#6B7280'),
  ('Estimate Under Review', 'service_estimate_under_review', 4, 'service_deal', true, false, '#4CAF50'),
  ('Estimate Sent to Client', 'service_estimate_sent_to_client', 5, 'service_deal', true, false, '#F97316'),
  ('Service - Sent to Production', 'service_sent_to_production', 6, 'service_deal', true, true, '#3B82F6'),
  ('Service - Lost', 'service_lost', 7, 'service_deal', true, true, '#D1D5DB')
ON CONFLICT (slug) DO UPDATE
SET
  name = EXCLUDED.name,
  display_order = EXCLUDED.display_order,
  workflow_family = EXCLUDED.workflow_family,
  is_active_pipeline = EXCLUDED.is_active_pipeline,
  is_terminal = EXCLUDED.is_terminal,
  color = EXCLUDED.color;
