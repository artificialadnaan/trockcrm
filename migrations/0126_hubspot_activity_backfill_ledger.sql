CREATE TABLE IF NOT EXISTS public.hubspot_activity_backfill_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_schema TEXT NOT NULL,
  hubspot_object_type TEXT NOT NULL,
  hubspot_object_id TEXT NOT NULL,
  target_entity_type TEXT,
  target_entity_id UUID,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activity_id UUID,
  email_id UUID,
  status TEXT NOT NULL,
  skip_reason TEXT,
  source_payload JSONB,
  UNIQUE (tenant_schema, hubspot_object_type, hubspot_object_id)
);

CREATE INDEX IF NOT EXISTS hubspot_activity_backfill_ledger_tenant_status_idx
  ON public.hubspot_activity_backfill_ledger (tenant_schema, status);
