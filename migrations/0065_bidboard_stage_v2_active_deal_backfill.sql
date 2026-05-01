-- Migration 0065: Move active deal rows to Bid Board stage-v2 canonical slugs.
--
-- Only active deals are updated. Inactive closed/lost historical rows remain on
-- inactive legacy pipeline_stage_config rows for historical reporting.

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schemata.schema_name
    FROM information_schema.schemata AS schemata
    WHERE schemata.schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'migration')
      AND schemata.schema_name NOT LIKE 'pg_%'
    ORDER BY schemata.schema_name
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = tenant_schema
        AND table_name = 'deals'
    ) THEN
      EXECUTE format(
        $sql$
        WITH target AS (
          SELECT
            estimating.id AS estimating_id,
            under_review.id AS estimate_under_review_id,
            sent_to_client.id AS estimate_sent_to_client_id,
            contract.id AS contract_id,
            won.id AS won_id,
            lost.id AS lost_id
          FROM public.pipeline_stage_config AS estimating
          CROSS JOIN public.pipeline_stage_config AS under_review
          CROSS JOIN public.pipeline_stage_config AS sent_to_client
          CROSS JOIN public.pipeline_stage_config AS contract
          CROSS JOIN public.pipeline_stage_config AS won
          CROSS JOIN public.pipeline_stage_config AS lost
          WHERE estimating.slug = 'estimating'
            AND under_review.slug = 'estimate_under_review'
            AND sent_to_client.slug = 'estimate_sent_to_client'
            AND contract.slug = 'contract'
            AND won.slug = 'won'
            AND lost.slug = 'lost'
        ),
        candidates AS (
          SELECT
            d.id,
            CASE
              WHEN psc.slug = 'estimate_in_progress' THEN target.estimating_id
              WHEN psc.slug = 'service_estimate_under_review' THEN target.estimate_under_review_id
              WHEN psc.slug = 'service_estimate_sent_to_client' THEN target.estimate_sent_to_client_id
              WHEN psc.slug IN ('contract_signed', 'service_contract_signed') THEN target.contract_id
              WHEN psc.slug IN ('sent_to_production', 'service_sent_to_production', 'closed_won') THEN target.won_id
              WHEN psc.slug IN ('production_lost', 'service_lost', 'closed_lost') THEN target.lost_id
              ELSE d.stage_id
            END AS next_stage_id,
            CASE
              WHEN d.bid_board_stage_slug = 'estimate_in_progress' THEN 'estimating'
              WHEN d.bid_board_stage_slug = 'service_estimate_under_review' THEN 'estimate_under_review'
              WHEN d.bid_board_stage_slug = 'service_estimate_sent_to_client' THEN 'estimate_sent_to_client'
              WHEN d.bid_board_stage_slug IN ('contract_signed', 'service_contract_signed') THEN 'contract'
              WHEN d.bid_board_stage_slug IN ('sent_to_production', 'service_sent_to_production', 'closed_won') THEN 'won'
              WHEN d.bid_board_stage_slug IN ('production_lost', 'service_lost', 'closed_lost') THEN 'lost'
              ELSE d.bid_board_stage_slug
            END AS next_bid_board_stage_slug
          FROM %I.deals AS d
          JOIN public.pipeline_stage_config AS psc
            ON psc.id = d.stage_id
          CROSS JOIN target
          WHERE COALESCE(d.is_active, true) = true
            AND (
              psc.slug IN (
                'estimate_in_progress',
                'service_estimate_under_review',
                'service_estimate_sent_to_client',
                'contract_signed',
                'service_contract_signed',
                'sent_to_production',
                'service_sent_to_production',
                'production_lost',
                'service_lost',
                'closed_won',
                'closed_lost'
              )
              OR d.bid_board_stage_slug IN (
                'estimate_in_progress',
                'service_estimate_under_review',
                'service_estimate_sent_to_client',
                'contract_signed',
                'service_contract_signed',
                'sent_to_production',
                'service_sent_to_production',
                'production_lost',
                'service_lost',
                'closed_won',
                'closed_lost',
                'estimating',
                'service_estimating',
                'estimate_under_review',
                'estimate_sent_to_client',
                'contract',
                'won',
                'lost'
              )
            )
        ),
        normalized AS (
          SELECT
            id,
            next_stage_id,
            next_bid_board_stage_slug,
            CASE
              WHEN next_bid_board_stage_slug IN ('estimating', 'service_estimating', 'estimate_under_review') THEN 'estimating'
              WHEN next_bid_board_stage_slug = 'estimate_sent_to_client' THEN 'proposal'
              WHEN next_bid_board_stage_slug = 'contract' THEN 'contract'
              WHEN next_bid_board_stage_slug = 'won' THEN 'terminal_won'
              WHEN next_bid_board_stage_slug = 'lost' THEN 'terminal_loss'
              ELSE NULL
            END AS next_bid_board_stage_family
          FROM candidates
        )
        UPDATE %I.deals AS d
        SET
          stage_id = normalized.next_stage_id,
          bid_board_stage_slug = normalized.next_bid_board_stage_slug,
          bid_board_stage_family = COALESCE(normalized.next_bid_board_stage_family, d.bid_board_stage_family),
          updated_at = NOW()
        FROM normalized
        WHERE d.id = normalized.id
          AND (
            d.stage_id IS DISTINCT FROM normalized.next_stage_id
            OR d.bid_board_stage_slug IS DISTINCT FROM normalized.next_bid_board_stage_slug
            OR d.bid_board_stage_family IS DISTINCT FROM COALESCE(normalized.next_bid_board_stage_family, d.bid_board_stage_family)
          )
        $sql$,
        tenant_schema,
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
