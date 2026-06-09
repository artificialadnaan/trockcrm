-- Migration 0157: usage_tracking
--
-- Platform Usage tracker — per-office telemetry (sessions, heartbeats, view events)
-- plus the forever daily rollup. Tables created in every existing office_* schema
-- (DO loop) and in the office_dallas template block cloned for new tenants.

-- Existing tenants: create the tables in every office_* schema.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    EXECUTE format(
      $sql$
        CREATE TABLE IF NOT EXISTS %1$I.usage_session (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_heartbeat_at TIMESTAMPTZ,
          ended_at TIMESTAMPTZ,
          active_seconds INTEGER NOT NULL DEFAULT 0,
          user_agent VARCHAR(500),
          impersonator_id UUID,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS usage_session_user_started_idx
          ON %1$I.usage_session (user_id, started_at);

        CREATE TABLE IF NOT EXISTS %1$I.usage_heartbeat (
          id BIGSERIAL PRIMARY KEY,
          session_id UUID NOT NULL,
          user_id UUID NOT NULL,
          at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS usage_heartbeat_user_at_idx
          ON %1$I.usage_heartbeat (user_id, at);
        CREATE INDEX IF NOT EXISTS usage_heartbeat_session_idx
          ON %1$I.usage_heartbeat (session_id);

        CREATE TABLE IF NOT EXISTS %1$I.usage_view_event (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          session_id UUID NOT NULL,
          at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          entity_type TEXT NOT NULL,
          entity_id UUID,
          route TEXT NOT NULL,
          label_snapshot TEXT
        );
        CREATE INDEX IF NOT EXISTS usage_view_event_user_at_idx
          ON %1$I.usage_view_event (user_id, at);

        CREATE TABLE IF NOT EXISTS %1$I.usage_daily (
          user_id UUID NOT NULL,
          date DATE NOT NULL,
          active_seconds INTEGER NOT NULL DEFAULT 0,
          session_count INTEGER NOT NULL DEFAULT 0,
          view_count INTEGER NOT NULL DEFAULT 0,
          action_count INTEGER NOT NULL DEFAULT 0,
          breakdown JSONB NOT NULL,
          first_active_at TIMESTAMPTZ,
          last_active_at TIMESTAMPTZ,
          rolled_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, date)
        );
      $sql$,
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner clones this marked block (office_dallas -> new schema).
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.usage_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  user_agent VARCHAR(500),
  impersonator_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS usage_session_user_started_idx ON office_dallas.usage_session (user_id, started_at);

CREATE TABLE IF NOT EXISTS office_dallas.usage_heartbeat (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL,
  user_id UUID NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS usage_heartbeat_user_at_idx ON office_dallas.usage_heartbeat (user_id, at);
CREATE INDEX IF NOT EXISTS usage_heartbeat_session_idx ON office_dallas.usage_heartbeat (session_id);

CREATE TABLE IF NOT EXISTS office_dallas.usage_view_event (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  session_id UUID NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entity_type TEXT NOT NULL,
  entity_id UUID,
  route TEXT NOT NULL,
  label_snapshot TEXT
);
CREATE INDEX IF NOT EXISTS usage_view_event_user_at_idx ON office_dallas.usage_view_event (user_id, at);

CREATE TABLE IF NOT EXISTS office_dallas.usage_daily (
  user_id UUID NOT NULL,
  date DATE NOT NULL,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  action_count INTEGER NOT NULL DEFAULT 0,
  breakdown JSONB NOT NULL,
  first_active_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  rolled_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, date)
);
-- TENANT_SCHEMA_END
