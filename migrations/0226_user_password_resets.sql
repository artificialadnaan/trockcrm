-- Migration 0226: single-use password reset links for CRM local-auth users.
--
-- Mirrors 0187 (field users), with two differences:
--   * requested_by_user_id is NULLABLE and NULL means self-service. The field table only ever had
--     admin-initiated rows; here the common case has no actor.
--   * requested_ip is recorded for forensics on an UNAUTHENTICATED endpoint.
--
-- public schema, keyed by users.id -- NOT tenant-scoped, so no TENANT_SCHEMA_START/END block.
--
-- No enum migration: local_auth_event_type already carries 'password_reset_requested' and
-- 'password_reset_completed' (added by 0187), and ALTER TYPE ... ADD VALUE cannot run in the same
-- transaction as its first use anyway.

CREATE TABLE IF NOT EXISTS public.user_password_resets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash           text NOT NULL UNIQUE,
  requested_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- text, not inet: this is a forensic breadcrumb written on an unauthenticated path, and a malformed
  -- proxy-supplied value must never be able to fail the INSERT and swallow someone's reset request.
  requested_ip         text,
  expires_at           timestamptz NOT NULL,
  used_at              timestamptz,
  invalidated_at       timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Lookup of the live link for a user (the "one live link at a time" invalidation sweep).
CREATE INDEX IF NOT EXISTS user_password_resets_active_user_idx
  ON public.user_password_resets (user_id, created_at DESC)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

-- Supports the per-account rate limit, which counts ALL recent rows for a user regardless of state.
-- The partial index above cannot serve it: a used or invalidated row still counts against the limit,
-- otherwise burning a link would refill the quota.
CREATE INDEX IF NOT EXISTS user_password_resets_user_created_idx
  ON public.user_password_resets (user_id, created_at DESC);
