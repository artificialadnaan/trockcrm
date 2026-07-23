-- Migration 0193: corrective-action recipients — email-only team members + recipient-bound web tokens.
-- Per-tenant (office_* schemas). Extends the below-band corrective-action flow (migration 0192) so the
-- deal's superintendent / project_manager can be notified even when they are NOT a CRM user or a directory
-- contact — just a name + email — and can respond via a token-authed web page.
--
-- Changes, all idempotent + guarded per schema:
--   1. deal_team_members: add member_name / member_email; REPLACE the exclusive user-or-contact CHECK with
--      one that ALSO allows an email-only row (user_id AND contact_id both NULL, member_email present).
--   2. field_scorecards: add corrective_action_email_sent_at — the idempotency stamp for the notification
--      job (mirrors email_sent_at).
--   3. new table scorecard_corrective_action_tokens: recipient-bound web tokens (hash at rest, expiry),
--      mirroring public_photo_tokens.
--
-- See docs/superpowers/specs/2026-07-22-scorecard-corrective-actions-design.md §4.4, §4.5, §5, §6.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.deal_team_members', schema_name)) IS NULL
       OR to_regclass(format('%I.field_scorecards', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    -- (1) Email-only team-member columns.
    EXECUTE format(
      $sql$
        ALTER TABLE %1$I.deal_team_members ADD COLUMN IF NOT EXISTS member_name text;
        ALTER TABLE %1$I.deal_team_members ADD COLUMN IF NOT EXISTS member_email text;
      $sql$,
      schema_name
    );

    -- Replace the old exclusive user-or-contact CHECK (deal_team_members_user_or_contact_check) with the
    -- identity check that also permits an email-only row. Dropped IF EXISTS so a schema that never got the
    -- 0182 contact check (contact-less legacy shape) still lands on the new named constraint.
    EXECUTE format(
      'ALTER TABLE %I.deal_team_members DROP CONSTRAINT IF EXISTS deal_team_members_user_or_contact_check',
      schema_name
    );
    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = 'deal_team_members_identity_check'
         AND conrelid = format('%I.deal_team_members', schema_name)::regclass
    ) THEN
      EXECUTE format(
        $sql$
          ALTER TABLE %1$I.deal_team_members
            ADD CONSTRAINT deal_team_members_identity_check
            CHECK (
              (user_id IS NOT NULL AND contact_id IS NULL)
              OR (user_id IS NULL AND contact_id IS NOT NULL)
              OR (user_id IS NULL AND contact_id IS NULL AND member_email IS NOT NULL)
            );
        $sql$,
        schema_name
      );
    END IF;

    -- (2) Notification idempotency stamp on the scorecard.
    EXECUTE format(
      'ALTER TABLE %I.field_scorecards ADD COLUMN IF NOT EXISTS corrective_action_email_sent_at timestamptz',
      schema_name
    );

    -- (2b) Relax field_scorecard_photos.section_key to nullable: a corrective-action RESPONSE photo carries
    -- corrective_action_id and has section_key/deficiency_key null (spec §4.3). Existing evidence rows keep
    -- their section_key. Idempotent (DROP NOT NULL on an already-nullable column is a no-op).
    IF to_regclass(format('%I.field_scorecard_photos', schema_name)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.field_scorecard_photos ALTER COLUMN section_key DROP NOT NULL',
        schema_name
      );
    END IF;

    -- (3) Recipient-bound web tokens.
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.scorecard_corrective_action_tokens (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         scorecard_id uuid NOT NULL REFERENCES %I.field_scorecards(id) ON DELETE CASCADE,
         token_hash text NOT NULL,
         recipient_email text NOT NULL,
         role text NOT NULL,
         expires_at timestamptz NOT NULL,
         consumed_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT scorecard_corrective_action_tokens_token_hash_key UNIQUE (token_hash)
       )',
      schema_name, schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS scorecard_corrective_action_tokens_scorecard_idx
         ON %I.scorecard_corrective_action_tokens (scorecard_id)', schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deal_team_members ADD COLUMN IF NOT EXISTS member_name text;
ALTER TABLE office_dallas.deal_team_members ADD COLUMN IF NOT EXISTS member_email text;
ALTER TABLE office_dallas.deal_team_members DROP CONSTRAINT IF EXISTS deal_team_members_user_or_contact_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'deal_team_members_identity_check'
       AND conrelid = 'office_dallas.deal_team_members'::regclass
  ) THEN
    ALTER TABLE office_dallas.deal_team_members
      ADD CONSTRAINT deal_team_members_identity_check
      CHECK (
        (user_id IS NOT NULL AND contact_id IS NULL)
        OR (user_id IS NULL AND contact_id IS NOT NULL)
        OR (user_id IS NULL AND contact_id IS NULL AND member_email IS NOT NULL)
      );
  END IF;
END $$;
ALTER TABLE office_dallas.field_scorecards ADD COLUMN IF NOT EXISTS corrective_action_email_sent_at timestamptz;
ALTER TABLE office_dallas.field_scorecard_photos ALTER COLUMN section_key DROP NOT NULL;
CREATE TABLE IF NOT EXISTS office_dallas.scorecard_corrective_action_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scorecard_id uuid NOT NULL REFERENCES office_dallas.field_scorecards(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  recipient_email text NOT NULL,
  role text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scorecard_corrective_action_tokens_token_hash_key UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS scorecard_corrective_action_tokens_scorecard_idx
  ON office_dallas.scorecard_corrective_action_tokens (scorecard_id);
-- TENANT_SCHEMA_END
