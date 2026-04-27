-- Migration 0059: lead-level verification status + assigned approver on companies.
-- Additive-only. Idempotent. Multi-tenant: applies the column adds to every
-- tenant schema that already has the leads/companies tables (matches 0057's pattern).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_verification_status') THEN
    CREATE TYPE lead_verification_status AS ENUM (
      'not_required', 'pending', 'approved', 'rejected'
    );
  END IF;
END $$;

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog')
      AND schema_name NOT LIKE 'pg_%'
  LOOP
    IF to_regclass(format('%I.leads', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.leads ADD COLUMN IF NOT EXISTS verification_status lead_verification_status NOT NULL DEFAULT ''not_required''',
        tenant_schema
      );
      EXECUTE format(
        'ALTER TABLE %I.leads ADD COLUMN IF NOT EXISTS verification_required_reason text',
        tenant_schema
      );
    END IF;

    IF to_regclass(format('%I.companies', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS assigned_approver_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
