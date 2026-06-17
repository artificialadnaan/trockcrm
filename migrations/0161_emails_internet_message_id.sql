-- Adds internet_message_id (stable RFC822 Message-ID, identical across Draft/Sent/recipient copies) to
-- office_*.emails. This is the dedup key that prevents a CRM-composed outbound email from being
-- double-stored when the Sent-folder sync later reads its Sent-Items copy (different Graph message id,
-- same Message-ID).
--
-- Two indexes:
--   • emails_internet_message_id_idx — the dedup lookup (only non-null values are probed).
--   • emails_outbound_internet_message_id_uq — a PARTIAL UNIQUE on (user_id, internet_message_id) for
--     outbound rows. The DB enforces the dedup so a concurrent CRM-send + Sent-folder-sync can't both
--     insert the same outbound message (read-then-write always races). Scoped to (user_id, direction
--     outbound) because the SAME Message-ID legitimately appears in two mailboxes for an internal A→B
--     email (A's Sent copy + B's Inbox copy) — those must NOT collide.
--
-- The DO block updates EXISTING office schemas; the TENANT_SCHEMA block is replayed by the office
-- provisioner (server/src/modules/office/service.ts) so FUTURE offices get the column + indexes too.

DO $tenant$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.emails', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE %I.emails ADD COLUMN IF NOT EXISTS internet_message_id varchar(1000)',
        tenant_schema
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS emails_internet_message_id_idx ON %I.emails (internet_message_id) WHERE internet_message_id IS NOT NULL',
        tenant_schema
      );
      EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS emails_outbound_internet_message_id_uq ON %I.emails (user_id, internet_message_id) WHERE internet_message_id IS NOT NULL AND direction = ''outbound''',
        tenant_schema
      );
    END IF;
  END LOOP;
END
$tenant$;

-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.emails
  ADD COLUMN IF NOT EXISTS internet_message_id varchar(1000);

CREATE INDEX IF NOT EXISTS emails_internet_message_id_idx
  ON office_dallas.emails (internet_message_id)
  WHERE internet_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS emails_outbound_internet_message_id_uq
  ON office_dallas.emails (user_id, internet_message_id)
  WHERE internet_message_id IS NOT NULL AND direction = 'outbound';
-- TENANT_SCHEMA_END
