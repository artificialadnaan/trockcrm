-- Migration 0063: contract_signed_at and RFP Opportunity event fields
-- Additive only. All columns are nullable and have no defaults.
-- contract_signed_date remains populated and untouched; contract_signed_at is
-- backfilled only where contract_signed_date already exists.

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
    IF to_regclass(format('%I.deals', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS contract_signed_at timestamptz',
        tenant_schema
      );

      EXECUTE format(
        'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_approval_requested_at timestamptz',
        tenant_schema
      );

      EXECUTE format(
        'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_approval_request_event_id uuid',
        tenant_schema
      );

      EXECUTE format(
        'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_approval_requested_by uuid',
        tenant_schema
      );

      EXECUTE format(
        'UPDATE %I.deals
            SET contract_signed_at = contract_signed_date::timestamptz
          WHERE contract_signed_date IS NOT NULL
            AND contract_signed_at IS NULL',
        tenant_schema
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deals_contract_signed_at_idx ON %I.deals (contract_signed_at)',
        tenant_schema
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deals_rfp_approval_requested_at_idx ON %I.deals (rfp_approval_requested_at)',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
