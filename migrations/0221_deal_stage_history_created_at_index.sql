-- Migration 0221: index deal_stage_history for a TIME-WINDOW scan.
--
-- The estimates-sent feed (POST /api/internal/estimates-sent, read by SyncHub's RFP Report email) filters
-- deal_stage_history by created_at and the stage it moved INTO — and by nothing else. The only existing
-- supporting index, 0122_deal_stage_history_lateral_index, leads with deal_id, which that query never
-- constrains, so the planner had to scan the office's ENTIRE stage history to keep at most 31 days of it.
-- Cheap today and quietly worse every month, and the feed sweeps every office in sequence, so the cost is
-- multiplied by the number of tenants.
--
-- (created_at, to_stage_id): created_at leads because it is the selective predicate; to_stage_id rides
-- along so the stage-slug join can be answered from the index rather than a heap fetch per row.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deal_stage_history_created_at_idx ON %I.deal_stage_history (created_at, to_stage_id)',
      schema_name
    );
  END LOOP;
END
$tenant$;

-- New tenants: the office provisioner replays this block, so a schema created after this deploy gets the
-- same index instead of silently falling back to a full scan.
-- TENANT_SCHEMA_START
CREATE INDEX IF NOT EXISTS deal_stage_history_created_at_idx
  ON office_dallas.deal_stage_history (created_at, to_stage_id);
-- TENANT_SCHEMA_END
