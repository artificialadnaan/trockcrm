-- Migration 0116: Bid Board estimate terminal-skip reporting
-- Adds a dedicated counter for terminal-stage estimate guards. Stage terminal skips and
-- estimate terminal skips are separate because one protects workflow state and the other
-- protects historical financial values.

DO $$
DECLARE
  tenant_schema TEXT;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    IF to_regclass(format('%I.bid_board_sync_runs', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.bid_board_sync_runs
           ADD COLUMN IF NOT EXISTS estimate_skipped_terminal_count INTEGER NOT NULL DEFAULT 0',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
