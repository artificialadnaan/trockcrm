-- Migration 0079: field contractor auth and invite tokens.
-- Public-schema user additions are additive and idempotent.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS first_name varchar(255),
  ADD COLUMN IF NOT EXISTS last_name varchar(255),
  ADD COLUMN IF NOT EXISTS phone varchar(30),
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES public.users(id);

UPDATE public.users
SET
  first_name = COALESCE(first_name, split_part(display_name, ' ', 1)),
  last_name = COALESCE(
    last_name,
    NULLIF(regexp_replace(display_name, '^[^ ]+ ?', ''), '')
  )
WHERE first_name IS NULL OR last_name IS NULL;

CREATE TABLE IF NOT EXISTS public.field_user_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.offices(id),
  token_hash text NOT NULL UNIQUE,
  first_name varchar(255) NOT NULL,
  last_name varchar(255) NOT NULL,
  phone varchar(30),
  invited_by_user_id uuid NOT NULL REFERENCES public.users(id),
  accepted_user_id uuid REFERENCES public.users(id),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS field_user_invites_email_tenant_idx
  ON public.field_user_invites (lower(email), tenant_id);

CREATE INDEX IF NOT EXISTS field_user_invites_token_hash_idx
  ON public.field_user_invites (token_hash);

CREATE INDEX IF NOT EXISTS field_user_invites_tenant_status_idx
  ON public.field_user_invites (tenant_id, accepted_at, revoked_at, expires_at);
