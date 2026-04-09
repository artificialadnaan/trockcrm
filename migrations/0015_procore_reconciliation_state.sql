DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'procore_reconciliation_status' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.procore_reconciliation_status AS ENUM ('linked', 'ignored');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.procore_reconciliation_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid NOT NULL REFERENCES public.offices(id),
  procore_project_id bigint NOT NULL,
  deal_id uuid NULL,
  status public.procore_reconciliation_status NOT NULL,
  match_reason text,
  match_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid NULL REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS procore_reconciliation_state_scope_idx
  ON public.procore_reconciliation_state (
    office_id,
    procore_project_id,
    coalesce(deal_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
