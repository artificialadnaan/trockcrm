-- Migration 0198: a GLOBAL managed roster of field Superintendents & Project Managers ("field
-- responders") — the managed source for corrective-action recipient emails, replacing per-deal retyping.
--
-- Adds two things, per-tenant (office_* schemas):
--   1. field_responders — one row per roster person (name, email, role, is_active). Case-insensitive
--      email uniqueness among ACTIVE rows via a partial unique index on (lower(email)) WHERE is_active,
--      so a deactivated person's email can be re-added later (only ACTIVE emails must be distinct).
--   2. deal_team_members.responder_id — nullable FK -> field_responders(id) ON DELETE SET NULL, linking a
--      deal assignment to a roster person (for the "where assigned" view). Corrective-action recipient
--      resolution is UNCHANGED: it still resolves the team member's copied member_email — responder_id is
--      just the roster LINK. ON DELETE SET NULL so removing a roster person never orphans / voids the
--      assignment's own copied name+email.
--
-- Idempotent across all tenant office_* schemas (matches 0182 / 0196's pattern). No CREATE INDEX
-- CONCURRENTLY: CONCURRENTLY cannot run inside a transaction block, and field_responders is new / empty at
-- create time so a plain CREATE UNIQUE INDEX is instant and safe here.

DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deal_team_members', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.field_responders (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         name text NOT NULL,
         email text NOT NULL,
         role text NOT NULL CHECK (role IN (''superintendent'', ''project_manager'')),
         is_active boolean NOT NULL DEFAULT true,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )',
      schema_name
    );

    -- Case-insensitive email uniqueness among ACTIVE rows only. A deactivated person's email is free to be
    -- re-added (a new active row, or the same person reactivated) — only ACTIVE emails must collide.
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS field_responders_active_email_uidx
         ON %I.field_responders (lower(email))
         WHERE is_active = TRUE',
      schema_name
    );

    -- Link a deal assignment to a roster person. ON DELETE SET NULL: removing the roster person clears the
    -- link but leaves the assignment (which carries its own copied name+email) intact.
    EXECUTE format(
      'ALTER TABLE %I.deal_team_members
         ADD COLUMN IF NOT EXISTS responder_id uuid
         REFERENCES %I.field_responders(id) ON DELETE SET NULL',
      schema_name, schema_name
    );

    -- Support the assignmentCount / "where assigned" lookups (all active assignments for a responder).
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deal_team_members_responder_idx
         ON %I.deal_team_members (responder_id)
         WHERE responder_id IS NOT NULL',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.field_responders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('superintendent', 'project_manager')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS field_responders_active_email_uidx
  ON office_dallas.field_responders (lower(email))
  WHERE is_active = TRUE;
ALTER TABLE office_dallas.deal_team_members
  ADD COLUMN IF NOT EXISTS responder_id uuid
  REFERENCES office_dallas.field_responders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS deal_team_members_responder_idx
  ON office_dallas.deal_team_members (responder_id)
  WHERE responder_id IS NOT NULL;
-- TENANT_SCHEMA_END
