-- Migration 0114: Bid Board stage writeback reporting
--
-- Expands the existing per-tenant Bid Board sync run table with the counters
-- needed to audit Project # matching and guarded CRM stage writeback.

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
            ADD COLUMN IF NOT EXISTS matched_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS stage_updated_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS skipped_no_project_number_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS skipped_unmapped_status_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS skipped_template_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS skipped_backward_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS skipped_terminal_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS skipped_no_stage_change_count INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS unmatched_project_numbers JSONB NOT NULL DEFAULT '[]'::jsonb
        $sql$,
        tenant_schema
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS bid_board_sync_runs_stage_updated_idx ON %I.bid_board_sync_runs (stage_updated_count, created_at DESC)',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.deals', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deals_project_number_lower_idx ON %I.deals (LOWER(TRIM(project_number))) WHERE project_number IS NOT NULL',
        tenant_schema
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deals_deal_number_lower_idx ON %I.deals (LOWER(TRIM(deal_number)))',
        tenant_schema
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deals_bid_board_project_number_lower_idx ON %I.deals (LOWER(TRIM(bid_board_project_number))) WHERE bid_board_project_number IS NOT NULL',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
