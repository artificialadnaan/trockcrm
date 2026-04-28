-- Migration 0064: SyncHub project-number convention support
--
-- Preserves imported HubSpot project numbers, enforces per-tenant uniqueness
-- for assigned CRM/Bid Board project numbers, and lets the staging layer carry
-- HubSpot's existing project_number property through promotion.

DO $$
DECLARE
  tenant_schema text;
BEGIN
  ALTER TABLE IF EXISTS migration.staged_deals
    ADD COLUMN IF NOT EXISTS mapped_project_number varchar(100);

  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'migration')
      AND schema_name NOT LIKE 'pg_%'
  LOOP
    IF to_regclass(format('%I.deals', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'DROP INDEX IF EXISTS %I.%I',
        tenant_schema,
        'deals_bid_board_project_number_idx'
      );
      EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS deals_bid_board_project_number_uidx ON %I.deals (bid_board_project_number) WHERE bid_board_project_number IS NOT NULL',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
