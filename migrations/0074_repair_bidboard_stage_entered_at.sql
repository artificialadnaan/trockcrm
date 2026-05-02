-- Migration 0074: Repair stage_entered_at after Bid Board stage-v2 active deal backfill.
--
-- Migration 0065 updated stage_id for active deals. The tenant trigger from
-- 0001 resets stage_entered_at whenever stage_id changes, so many migrated
-- deals started rendering as "0d in stage". Repair those rows using the best
-- available historical signal:
--   1. latest deal_stage_history.created_at, when present
--   2. bid_board_stage_entered_at, when present
--   3. deal.created_at as a conservative fallback for imported rows with no
--      stage history; updated_at is intentionally avoided because sync writes
--      are frequent and do not represent stage entry.

DO $$
DECLARE
  tenant_schema text;
  migration_0065_executed_at timestamptz;
BEGIN
  -- Use the actual 0065 application timestamp instead of a literal cutover
  -- timestamp so replayed databases, restored staging snapshots, and future
  -- tenant runs repair rows stamped by their own migration execution time.
  IF to_regclass('public._migrations') IS NOT NULL THEN
    SELECT executed_at
    INTO migration_0065_executed_at
    FROM public._migrations
    WHERE name = '0065_bidboard_stage_v2_active_deal_backfill.sql'
    ORDER BY executed_at DESC
    LIMIT 1;
  END IF;

  IF migration_0065_executed_at IS NULL THEN
    RAISE NOTICE 'Skipping stage_entered_at repair because 0065 migration timestamp is not available';
    RETURN;
  END IF;

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
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = tenant_schema
        AND table_name = 'deal_stage_history'
    ) THEN
      EXECUTE format(
        $sql$
        WITH latest_history AS (
          SELECT
            dsh.deal_id,
            MAX(dsh.created_at) AS latest_stage_history_at
          FROM %I.deal_stage_history AS dsh
          GROUP BY dsh.deal_id
        ),
        candidates AS (
          SELECT
            d.id,
            COALESCE(
              latest_history.latest_stage_history_at,
              d.bid_board_stage_entered_at,
              d.created_at
            ) AS repaired_stage_entered_at
          FROM %I.deals AS d
          JOIN public.pipeline_stage_config AS psc
            ON psc.id = d.stage_id
          LEFT JOIN latest_history
            ON latest_history.deal_id = d.id
          WHERE COALESCE(d.is_active, true) = true
            AND psc.slug IN (
              'estimating',
              'service_estimating',
              'estimate_under_review',
              'estimate_sent_to_client',
              'contract',
              'won',
              'lost'
            )
            AND COALESCE(
              latest_history.latest_stage_history_at,
              d.bid_board_stage_entered_at,
              d.created_at
            ) IS NOT NULL
            AND (
              d.stage_entered_at IS NULL
              OR latest_history.latest_stage_history_at > d.stage_entered_at
              OR (
                d.stage_entered_at >= %L::timestamptz - INTERVAL '10 seconds'
                AND d.stage_entered_at <= %L::timestamptz + INTERVAL '10 seconds'
                AND d.created_at < d.stage_entered_at
              )
            )
        )
        UPDATE %I.deals AS d
        SET stage_entered_at = candidates.repaired_stage_entered_at
        FROM candidates
        WHERE d.id = candidates.id
          AND d.stage_entered_at IS DISTINCT FROM candidates.repaired_stage_entered_at
        $sql$,
        tenant_schema,
        tenant_schema,
        migration_0065_executed_at,
        migration_0065_executed_at,
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
