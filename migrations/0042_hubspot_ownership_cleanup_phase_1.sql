CREATE TABLE IF NOT EXISTS public.hubspot_owner_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hubspot_owner_id varchar(64) NOT NULL UNIQUE,
  hubspot_owner_email varchar(320),
  user_id uuid REFERENCES public.users(id),
  office_id uuid REFERENCES public.offices(id),
  mapping_status varchar(32) NOT NULL DEFAULT 'pending',
  failure_reason_code varchar(64),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS hubspot_owner_id varchar(64),
  ADD COLUMN IF NOT EXISTS hubspot_owner_email varchar(320),
  ADD COLUMN IF NOT EXISTS ownership_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS ownership_sync_status varchar(32),
  ADD COLUMN IF NOT EXISTS unassigned_reason_code varchar(64);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS hubspot_owner_id varchar(64),
  ADD COLUMN IF NOT EXISTS hubspot_owner_email varchar(320),
  ADD COLUMN IF NOT EXISTS ownership_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS ownership_sync_status varchar(32),
  ADD COLUMN IF NOT EXISTS unassigned_reason_code varchar(64);
