-- Migration 0145: Bid Board applied-backward stage move reporting
--
-- The Bid Board export is now the source of truth for stage, including backward
-- moves (Path A: bid-board-sync ingest). A backward move (target display_order <
-- the deal's current stage, among non-terminal stages) is now APPLIED rather than
-- pinned/skipped. The legacy skipped_backward_count column is retired in place
-- (kept for historical run rows, no longer written) and replaced by
-- applied_backward_count, which records how many CRM deals were moved to an
-- earlier stage to follow the board in each sync run.
--
-- Additive and idempotent: only ADD COLUMN IF NOT EXISTS on each tenant schema's
-- bid_board_sync_runs. The terminal lock is unchanged, so Won/Lost rows are never
-- moved and the Won basis is unaffected by this change.

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
        'ALTER TABLE %I.bid_board_sync_runs ADD COLUMN IF NOT EXISTS applied_backward_count INTEGER NOT NULL DEFAULT 0',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
