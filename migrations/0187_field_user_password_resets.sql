-- Migration 0187: single-use password reset links for accepted T-Rock Cam field users.

ALTER TYPE local_auth_event_type
  ADD VALUE IF NOT EXISTS 'password_reset_requested';

ALTER TYPE local_auth_event_type
  ADD VALUE IF NOT EXISTS 'password_reset_completed';

CREATE TABLE IF NOT EXISTS public.field_user_password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  requested_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS field_user_password_resets_active_user_idx
  ON public.field_user_password_resets (user_id, created_at DESC)
  WHERE used_at IS NULL AND invalidated_at IS NULL;
