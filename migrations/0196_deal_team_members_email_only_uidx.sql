-- Migration 0196: dedup active EMAIL-ONLY deal_team_members rows (finding E).
--
-- Migration 0182 added partial unique indexes for the two LINKED shapes:
--   deal_team_members_deal_user_role_uidx     (deal_id, user_id, role)    WHERE user_id IS NOT NULL AND is_active
--   deal_team_members_deal_contact_role_uidx  (deal_id, contact_id, role) WHERE contact_id IS NOT NULL AND is_active
-- Migration 0193 then introduced the EMAIL-ONLY shape (user_id AND contact_id both NULL, member_email set), but
-- added NO uniqueness for it. So a retried add — or the same external email + role entered twice — creates a
-- SECOND active assignment: duplicates in the Team tab, removing one leaves access via the other, and each dup
-- add needlessly restarts the corrective-action notification cycle. This index closes that gap with a per-tenant
-- CASE-INSENSITIVE partial unique index on ACTIVE email-only rows so a deal can't hold two active email-only
-- assignments for the same (case-folded email, role). addTeamMember handles the conflict (onConflictDoNothing +
-- return the existing active row) so a duplicate add is a no-op, not an error and not a second cycle restart.
--
-- Idempotent across all tenant office_* schemas (matches 0182's pattern).

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

    -- Active-uniqueness for email-only rows. Case-insensitive on member_email (lower()) so "PM@x.com" and
    -- "pm@x.com" collide. Scoped to email-only rows (both fks NULL, member_email present) that are active.
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS deal_team_members_deal_email_role_uidx
         ON %I.deal_team_members (deal_id, lower(member_email), role)
         WHERE user_id IS NULL AND contact_id IS NULL AND is_active = TRUE AND member_email IS NOT NULL',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
CREATE UNIQUE INDEX IF NOT EXISTS deal_team_members_deal_email_role_uidx
  ON office_dallas.deal_team_members (deal_id, lower(member_email), role)
  WHERE user_id IS NULL AND contact_id IS NULL AND is_active = TRUE AND member_email IS NOT NULL;
-- TENANT_SCHEMA_END
