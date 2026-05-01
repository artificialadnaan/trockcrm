-- Migration 0064: Seed Bid Board stage-v2 canonical rows.
--
-- CRM keeps Opportunity as a CRM-only stage. Bid Board mirrored stages now use:
-- estimating, service_estimating, estimate_under_review, estimate_sent_to_client,
-- contract, won, lost.
--
-- Legacy rows stay in public.pipeline_stage_config as inactive historical aliases
-- so closed/lost historical deal rows can keep their original stage_id.

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
  ('Opportunity', 'opportunity', 2, 'standard_deal', true, false, '#F59E0B'),
  ('Estimating', 'estimating', 3, 'standard_deal', true, false, '#93C5FD'),
  ('Service Estimating', 'service_estimating', 3, 'service_deal', true, false, '#6B7280'),
  ('Estimate Under Review', 'estimate_under_review', 4, 'standard_deal', true, false, '#4CAF50'),
  ('Estimate Sent to Client', 'estimate_sent_to_client', 5, 'standard_deal', true, false, '#F97316'),
  ('Contract', 'contract', 6, 'standard_deal', true, false, '#8B5CF6'),
  ('Won', 'won', 7, 'standard_deal', true, true, '#10B981'),
  ('Lost', 'lost', 8, 'standard_deal', true, true, '#DC2626')
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
  is_terminal = CASE
    WHEN slug IN (
      'sent_to_production',
      'service_sent_to_production',
      'production_lost',
      'service_lost',
      'closed_won',
      'closed_lost'
    ) THEN true
    ELSE false
  END
WHERE slug IN (
  'estimate_in_progress',
  'service_estimate_under_review',
  'service_estimate_sent_to_client',
  'sent_to_production',
  'service_sent_to_production',
  'production_lost',
  'service_lost',
  'closed_won',
  'closed_lost'
);
