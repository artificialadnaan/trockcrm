-- Migration 0186: durable SyncHub Bid Board identity on tenant deals.
--
-- A project name is not an identity: multiple projects at the same property can legitimately
-- share it. Store the required SyncHub `bid_board_id` and enforce one such identity per tenant
-- so webhook replays are idempotent without ever matching by name.

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
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS synchub_bid_board_id text',
      schema_name
    );
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS deals_synchub_bid_board_id_uidx ON %I.deals (synchub_bid_board_id) WHERE synchub_bid_board_id IS NOT NULL',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants are cloned from office_dallas by the office provisioner.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals ADD COLUMN IF NOT EXISTS synchub_bid_board_id text;
CREATE UNIQUE INDEX IF NOT EXISTS deals_synchub_bid_board_id_uidx
  ON office_dallas.deals (synchub_bid_board_id)
  WHERE synchub_bid_board_id IS NOT NULL;
-- TENANT_SCHEMA_END
