ALTER TABLE user_local_auth
  ADD COLUMN IF NOT EXISTS invite_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failed_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_by_user_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'local_auth_event_type'
  ) THEN
    CREATE TYPE local_auth_event_type AS ENUM (
      'invite_previewed',
      'invite_sent',
      'invite_resent',
      'invite_revoked',
      'login_succeeded',
      'login_failed',
      'login_locked',
      'password_changed'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_local_auth_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  event_type local_auth_event_type NOT NULL,
  actor_user_id uuid,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
