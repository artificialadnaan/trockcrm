-- Migration 0063: Bid Board project ingestion fields and provenance
--
-- Adds the 13 Bid Board-canonical fields to tenant deals without
-- competing with the CRM-owned deal_number. The per-tenant
-- bid_board_sync_runs table records each ingestion attempt for audit.

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
        $sql$
          ALTER TABLE %I.deals
            ADD COLUMN IF NOT EXISTS bid_board_estimator TEXT,
            ADD COLUMN IF NOT EXISTS bid_board_office TEXT,
            ADD COLUMN IF NOT EXISTS bid_board_status TEXT,
            ADD COLUMN IF NOT EXISTS bid_board_sales_price_per_area TEXT,
            ADD COLUMN IF NOT EXISTS bid_board_project_cost NUMERIC(14,2),
            ADD COLUMN IF NOT EXISTS bid_board_profit_margin_pct NUMERIC(9,4),
            ADD COLUMN IF NOT EXISTS bid_board_total_sales NUMERIC(14,2),
            ADD COLUMN IF NOT EXISTS bid_board_created_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS bid_board_due_date DATE,
            ADD COLUMN IF NOT EXISTS bid_board_customer_name TEXT,
            ADD COLUMN IF NOT EXISTS bid_board_customer_contact_raw TEXT,
            ADD COLUMN IF NOT EXISTS bid_board_project_number TEXT
        $sql$,
        tenant_schema
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deals_bid_board_project_number_idx ON %I.deals (bid_board_project_number)',
        tenant_schema
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deals_bid_board_name_created_idx ON %I.deals (name, bid_board_created_at) WHERE bid_board_project_number IS NULL',
        tenant_schema
      );

      EXECUTE format(
        $sql$
          CREATE TABLE IF NOT EXISTS %I.bid_board_sync_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            source_filename TEXT,
            extracted_at TIMESTAMPTZ,
            payload_hash TEXT NOT NULL,
            row_count INTEGER NOT NULL DEFAULT 0,
            updated_count INTEGER NOT NULL DEFAULT 0,
            no_match_count INTEGER NOT NULL DEFAULT 0,
            multi_match_count INTEGER NOT NULL DEFAULT 0,
            warning_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'received',
            errors JSONB NOT NULL DEFAULT '[]'::jsonb,
            warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        $sql$,
        tenant_schema
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS bid_board_sync_runs_created_idx ON %I.bid_board_sync_runs (created_at DESC)',
        tenant_schema
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS bid_board_sync_runs_payload_hash_idx ON %I.bid_board_sync_runs (payload_hash)',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
