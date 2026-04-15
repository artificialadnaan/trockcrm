-- Migration 0020: Add workflow families to pipeline stage configuration

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'workflow_family'
  ) THEN
    CREATE TYPE public.workflow_family AS ENUM ('lead', 'standard_deal', 'service_deal');
  END IF;
END $$;

ALTER TABLE public.pipeline_stage_config
  ADD COLUMN IF NOT EXISTS workflow_family public.workflow_family;

ALTER TABLE public.pipeline_stage_config
  ALTER COLUMN workflow_family SET DEFAULT 'standard_deal';

UPDATE public.pipeline_stage_config
SET workflow_family = 'standard_deal'
WHERE workflow_family IS NULL;

ALTER TABLE public.pipeline_stage_config
  ALTER COLUMN workflow_family SET NOT NULL;
