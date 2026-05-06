-- Migration 0086: Persist SyncHub enriched Procore webhook relays that cannot be linked automatically.
-- Idempotent and safe to rerun.

CREATE TABLE IF NOT EXISTS public.synchub_webhook_orphans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.offices(id),
  synchub_webhook_log_id text,
  synchub_sync_mapping_id text,
  procore_company_id text NOT NULL,
  procore_portfolio_project_id text NOT NULL,
  project_number text,
  project_name text,
  raw_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open',
  notes text,
  received_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_user_id uuid REFERENCES public.users(id),
  CONSTRAINT synchub_webhook_orphans_status_check CHECK (status IN ('open', 'resolved', 'ignored'))
);

CREATE INDEX IF NOT EXISTS synchub_webhook_orphans_status_idx
  ON public.synchub_webhook_orphans (status);

CREATE INDEX IF NOT EXISTS synchub_webhook_orphans_received_at_idx
  ON public.synchub_webhook_orphans (received_at);

CREATE INDEX IF NOT EXISTS synchub_webhook_orphans_project_number_idx
  ON public.synchub_webhook_orphans (project_number);

CREATE INDEX IF NOT EXISTS synchub_webhook_orphans_portfolio_project_idx
  ON public.synchub_webhook_orphans (procore_portfolio_project_id);

CREATE INDEX IF NOT EXISTS synchub_webhook_orphans_webhook_log_idx
  ON public.synchub_webhook_orphans (synchub_webhook_log_id)
  WHERE synchub_webhook_log_id IS NOT NULL;
