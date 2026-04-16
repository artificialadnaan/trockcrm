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

INSERT INTO public.pipeline_stage_config (
  name,
  slug,
  display_order,
  workflow_family,
  is_active_pipeline,
  is_terminal,
  color
)
VALUES
  ('Contacted', 'contacted', 1, 'lead', true, false, '#2563EB'),
  ('Converted', 'converted', 99, 'lead', false, true, '#16A34A')
ON CONFLICT (slug) DO UPDATE
SET
  name = EXCLUDED.name,
  display_order = EXCLUDED.display_order,
  workflow_family = EXCLUDED.workflow_family,
  is_active_pipeline = EXCLUDED.is_active_pipeline,
  is_terminal = EXCLUDED.is_terminal,
  color = EXCLUDED.color;
