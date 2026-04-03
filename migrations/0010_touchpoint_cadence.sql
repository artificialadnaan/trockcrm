-- Migration 0010: Add touchpoint cadence to pipeline stage config
-- This column defines how often contacts on deals in this stage should be contacted

ALTER TABLE public.pipeline_stage_config
  ADD COLUMN IF NOT EXISTS touchpoint_cadence_days INTEGER DEFAULT 14;
