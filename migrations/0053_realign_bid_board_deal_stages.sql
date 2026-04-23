-- Migration 0053: Realign downstream deal stages to the Bid Board mirror model.
-- CRM owns Opportunity. After handoff, the mirrored downstream pipelines are:
-- normal:  estimate_in_progress -> estimate_under_review -> estimate_sent_to_client -> sent_to_production -> production_lost
-- service: service_estimating   -> estimate_under_review -> estimate_sent_to_client -> service_sent_to_production -> service_lost

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
  ('Estimate in Progress', 'estimate_in_progress', 3, 'standard_deal', true, false, '#93C5FD'),
  ('Estimate Under Review', 'estimate_under_review', 4, 'standard_deal', true, false, '#4CAF50'),
  ('Estimate Sent to Client', 'estimate_sent_to_client', 5, 'standard_deal', true, false, '#F97316'),
  ('Sent to Production', 'sent_to_production', 6, 'standard_deal', true, true, '#CCFBF1'),
  ('Production Lost', 'production_lost', 7, 'standard_deal', true, true, '#DC2626'),
  ('Service - Estimating', 'service_estimating', 3, 'service_deal', true, false, '#6B7280'),
  ('Estimate Under Review', 'service_estimate_under_review', 4, 'service_deal', true, false, '#4CAF50'),
  ('Estimate Sent to Client', 'service_estimate_sent_to_client', 5, 'service_deal', true, false, '#F97316'),
  ('Service - Sent to Production', 'service_sent_to_production', 6, 'service_deal', true, true, '#3B82F6'),
  ('Service - Lost', 'service_lost', 7, 'service_deal', true, true, '#D1D5DB')
ON CONFLICT (slug) DO NOTHING;

UPDATE public.pipeline_stage_config
SET
  is_active_pipeline = false,
  is_terminal = false
WHERE slug IN (
  'estimating',
  'bid_sent',
  'in_production',
  'close_out',
  'closed_won',
  'closed_lost',
  'service_review',
  'service_proposal_sent',
  'service_scheduled',
  'service_complete'
);

DO $$
DECLARE
  office_schema text;
BEGIN
  FOR office_schema IN
    SELECT schemata.schema_name
    FROM information_schema.schemata AS schemata
    WHERE schemata.schema_name LIKE 'office_%'
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = office_schema
        AND table_name = 'deals'
    ) THEN
      EXECUTE format(
        $sql$
        UPDATE %I.deals AS d
        SET stage_id = mapped.target_stage_id
        FROM (
          SELECT
            current_stage.id AS current_stage_id,
            CASE
              WHEN d_inner.workflow_route = 'service' AND current_stage.slug = 'estimating' THEN service_estimating.id
              WHEN d_inner.workflow_route = 'service' AND current_stage.slug = 'service_review' THEN service_under_review.id
              WHEN d_inner.workflow_route = 'service' AND current_stage.slug IN ('bid_sent', 'service_proposal_sent') THEN service_sent_to_client.id
              WHEN d_inner.workflow_route = 'service' AND current_stage.slug IN ('in_production', 'close_out', 'closed_won', 'service_scheduled', 'service_complete') THEN service_sent_to_production.id
              WHEN d_inner.workflow_route = 'service' AND current_stage.slug = 'closed_lost' THEN service_lost.id
              WHEN current_stage.slug = 'estimating' THEN normal_estimating.id
              WHEN current_stage.slug = 'bid_sent' THEN normal_sent_to_client.id
              WHEN current_stage.slug IN ('in_production', 'close_out', 'closed_won') THEN normal_sent_to_production.id
              WHEN current_stage.slug = 'closed_lost' THEN normal_lost.id
              ELSE NULL
            END AS target_stage_id
          FROM %I.deals AS d_inner
          JOIN public.pipeline_stage_config AS current_stage
            ON current_stage.id = d_inner.stage_id
          CROSS JOIN LATERAL (
            SELECT id FROM public.pipeline_stage_config
            WHERE workflow_family = 'standard_deal' AND slug = 'estimate_in_progress'
            LIMIT 1
          ) AS normal_estimating
          CROSS JOIN LATERAL (
            SELECT id FROM public.pipeline_stage_config
            WHERE workflow_family = 'standard_deal' AND slug = 'estimate_sent_to_client'
            LIMIT 1
          ) AS normal_sent_to_client
          CROSS JOIN LATERAL (
            SELECT id FROM public.pipeline_stage_config
            WHERE workflow_family = 'standard_deal' AND slug = 'sent_to_production'
            LIMIT 1
          ) AS normal_sent_to_production
          CROSS JOIN LATERAL (
            SELECT id FROM public.pipeline_stage_config
            WHERE workflow_family = 'standard_deal' AND slug = 'production_lost'
            LIMIT 1
          ) AS normal_lost
          CROSS JOIN LATERAL (
            SELECT id FROM public.pipeline_stage_config
            WHERE workflow_family = 'service_deal' AND slug = 'service_estimating'
            LIMIT 1
          ) AS service_estimating
          CROSS JOIN LATERAL (
            SELECT id FROM public.pipeline_stage_config
            WHERE workflow_family = 'service_deal' AND slug = 'service_estimate_under_review'
            LIMIT 1
          ) AS service_under_review
          CROSS JOIN LATERAL (
            SELECT id FROM public.pipeline_stage_config
            WHERE workflow_family = 'service_deal' AND slug = 'service_estimate_sent_to_client'
            LIMIT 1
          ) AS service_sent_to_client
          CROSS JOIN LATERAL (
            SELECT id FROM public.pipeline_stage_config
            WHERE workflow_family = 'service_deal' AND slug = 'service_sent_to_production'
            LIMIT 1
          ) AS service_sent_to_production
          CROSS JOIN LATERAL (
            SELECT id FROM public.pipeline_stage_config
            WHERE workflow_family = 'service_deal' AND slug = 'service_lost'
            LIMIT 1
          ) AS service_lost
        ) AS mapped
        WHERE d.stage_id = mapped.current_stage_id
          AND mapped.target_stage_id IS NOT NULL
        $sql$,
        office_schema,
        office_schema
      );
    END IF;
  END LOOP;
END $$;
