-- Final SLA migration cleanup: the hold-aware SLA policy engine replaced the
-- admin-configured stale threshold. The column is now orphaned.
ALTER TABLE public.pipeline_stage_config
  DROP COLUMN IF EXISTS stale_threshold_days;
