-- Migration 0220: record WHO entered a company, property or contact.
--
-- Wanted for the canvassing activity report ("how many new companies / properties / contacts did each
-- person add this week"), which had no way to answer the question:
--
--   * companies/contacts carried only `owner_id`, which is ASSIGNMENT and is reassigned over a record's
--     life, so it drifts away from whoever actually keyed the record in.
--   * `properties` carried neither an owner nor a creator.
--   * the audit_log cannot stand in: only `contacts` has an audit trigger among the three, and even there
--     `changed_by` is null on ~95% of insert rows (imports and syncs carry no session actor).
--
-- `leads` already has this column (migration 0128), so this brings the other three directory tables in
-- line with it and uses the same shape: nullable uuid, FK to public.users, ON DELETE SET NULL.
--
-- NULLABLE ON PURPOSE, and NOT backfilled. Null means "no human in a session created this row" and covers
-- two real cases that must stay distinguishable from a person's work: rows that predate this migration,
-- and rows minted by machinery (SyncHub/bid-board ingestion, HubSpot-era imports, the demo seed). The
-- report reads a null creator as unattributed rather than crediting it to anyone, so the counts start at
-- zero on deploy and only ever describe records a person actually entered.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) so it is safe to re-run across offices.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.companies', schema_name)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.companies
           ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL',
        schema_name
      );
      -- Partial: the report only ever looks up attributed rows, and the vast majority of existing rows
      -- are null, so this stays small.
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS companies_created_by_user_created_at_idx
           ON %I.companies (created_by_user_id, created_at)
           WHERE created_by_user_id IS NOT NULL',
        schema_name
      );
    END IF;

    IF to_regclass(format('%I.properties', schema_name)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.properties
           ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL',
        schema_name
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS properties_created_by_user_created_at_idx
           ON %I.properties (created_by_user_id, created_at)
           WHERE created_by_user_id IS NOT NULL',
        schema_name
      );
    END IF;

    IF to_regclass(format('%I.contacts', schema_name)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.contacts
           ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL',
        schema_name
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS contacts_created_by_user_created_at_idx
           ON %I.contacts (created_by_user_id, created_at)
           WHERE created_by_user_id IS NOT NULL',
        schema_name
      );
    END IF;

    -- leads.created_by_user_id already exists (0128); it only lacks the reporting index.
    IF to_regclass(format('%I.leads', schema_name)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS leads_created_by_user_created_at_idx
           ON %I.leads (created_by_user_id, created_at)
           WHERE created_by_user_id IS NOT NULL',
        schema_name
      );
    END IF;
  END LOOP;
END
$tenant$;

-- New tenants: the office provisioner replays this block (office_dallas -> new schema) when an office is
-- created after this deploy. Without it a fresh schema would be missing the column and every directory
-- create in that office would fail on the unknown column.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.companies
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE office_dallas.properties
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE office_dallas.contacts
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS companies_created_by_user_created_at_idx
  ON office_dallas.companies (created_by_user_id, created_at)
  WHERE created_by_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS properties_created_by_user_created_at_idx
  ON office_dallas.properties (created_by_user_id, created_at)
  WHERE created_by_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS contacts_created_by_user_created_at_idx
  ON office_dallas.contacts (created_by_user_id, created_at)
  WHERE created_by_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_created_by_user_created_at_idx
  ON office_dallas.leads (created_by_user_id, created_at)
  WHERE created_by_user_id IS NOT NULL;
-- TENANT_SCHEMA_END
