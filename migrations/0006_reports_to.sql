ALTER TABLE public.users ADD COLUMN IF NOT EXISTS reports_to UUID REFERENCES public.users(id);

ALTER TABLE public.pipeline_stage_config ADD COLUMN IF NOT EXISTS stale_escalation_tiers JSONB DEFAULT '[{"days":30,"severity":"warning"},{"days":60,"severity":"escalation"},{"days":90,"severity":"critical"}]';
