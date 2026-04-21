DO $$ BEGIN
  CREATE TYPE lead_scoping_intake_status AS ENUM ('draft', 'ready', 'completed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS lead_scoping_intake (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE UNIQUE,
  office_id UUID NOT NULL REFERENCES public.offices(id),
  status lead_scoping_intake_status NOT NULL DEFAULT 'draft',
  section_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  completion_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  readiness_errors JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_ready_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_autosaved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES public.users(id),
  last_edited_by UUID NOT NULL REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lead_scoping_intake_office_id_idx
  ON lead_scoping_intake(office_id, updated_at DESC);

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id);

CREATE INDEX IF NOT EXISTS files_lead_idx
  ON files(lead_id, category, created_at);
