-- Migration 0115: Bid Board estimate writeback reporting
--
-- Adds per-run counters for the Bid Board Total Sales -> CRM bid_estimate
-- writeback and adds explicit source/reason fields to deal_history so
-- system-authored estimate changes are audit-distinguishable from user edits.
-- The estimate itself uses the existing tenant deals.bid_estimate numeric(14,2)
-- column; no new deal value column is introduced.

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'migration')
      AND schema_name NOT LIKE 'pg_%'
  LOOP
    IF to_regclass(format('%I.bid_board_sync_runs', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        $sql$
          ALTER TABLE %I.bid_board_sync_runs
            ADD COLUMN IF NOT EXISTS estimate_updated_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS estimate_updated_higher_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS estimate_updated_lower_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS estimate_skipped_no_value_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS estimate_skipped_no_change_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS estimate_warning_count INTEGER NOT NULL DEFAULT 0
        $sql$,
        tenant_schema
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS bid_board_sync_runs_estimate_updated_idx ON %I.bid_board_sync_runs (estimate_updated_count, created_at DESC)',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.deal_history', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        $sql$
          ALTER TABLE %I.deal_history
            ADD COLUMN IF NOT EXISTS source TEXT,
            ADD COLUMN IF NOT EXISTS reason TEXT
        $sql$,
        tenant_schema
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deal_history_source_changed_at_idx ON %I.deal_history (source, changed_at DESC) WHERE source IS NOT NULL',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
