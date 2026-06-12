-- Migration 0158: daily platform-usage summary snapshots + public-link tokens.
-- One FROZEN "as of 5pm CT" snapshot per (summary_date, office_code). The 5pm value is mid-day (the
-- day isn't rolled up yet) and the page may be opened for ~30 days, so we store the computed payload
-- rather than recompute later. An unguessable token (only its SHA-256 hash is stored) guards the
-- public /daily-summary page. Mirrors public.public_photo_tokens (migration 0084).
CREATE TABLE IF NOT EXISTS public.daily_summary_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  summary_date date NOT NULL,
  office_code text NOT NULL,
  as_of timestamptz NOT NULL,
  payload jsonb NOT NULL,
  token text NOT NULL UNIQUE,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_accessed_at timestamptz,
  access_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One snapshot per office per day — the cron's idempotency / double-send guard.
  UNIQUE (summary_date, office_code)
);

CREATE INDEX IF NOT EXISTS daily_summary_snapshots_token_idx
  ON public.daily_summary_snapshots (token);
CREATE INDEX IF NOT EXISTS daily_summary_snapshots_date_office_idx
  ON public.daily_summary_snapshots (summary_date, office_code);
