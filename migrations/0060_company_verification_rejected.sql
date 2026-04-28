-- Migration 0060: extend company_verification_status enum + reject audit columns
-- Additive-only. Enum gains a 'rejected' value; per-tenant companies tables get
-- nullable rejected_at + rejected_by columns mirroring the existing verified_at /
-- verified_by audit pair from migration 0057.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'rejected'
      AND enumtypid = 'company_verification_status'::regtype
  ) THEN
    ALTER TYPE company_verification_status ADD VALUE 'rejected';
  END IF;
END $$;

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'migration')
      AND schema_name NOT LIKE 'pg_%'
  LOOP
    IF to_regclass(format('%I.companies', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS company_verification_rejected_at timestamptz',
        tenant_schema
      );
      EXECUTE format(
        'ALTER TABLE %I.companies ADD COLUMN IF NOT EXISTS company_verification_rejected_by uuid',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
