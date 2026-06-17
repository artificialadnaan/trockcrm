-- Adds internet_message_id (stable RFC822 Message-ID, identical across Draft/Sent/recipient copies)
-- to office_*.emails. This is the dedup key that prevents a CRM-composed outbound email from being
-- double-stored when the Sent-folder sync later reads its Sent-Items copy back in (that copy can carry
-- a DIFFERENT Graph message id, so graph_message_id alone does not catch it).
--
-- Nullable: legacy rows + any message without an internetMessageId stay NULL. Dedup is enforced in
-- application code (SELECT-before-INSERT under the per-user advisory sync lock), matching the existing
-- graph_message_id dedup pattern — NOT a DB unique constraint, to avoid failing on any pre-existing
-- value and to keep the single-target ON CONFLICT (graph_message_id) insert path intact.

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
        $sql$
          ALTER TABLE %I.emails
            ADD COLUMN IF NOT EXISTS internet_message_id varchar(1000);
        $sql$,
        tenant_schema
      );

      -- Partial index for the dedup lookup (only non-null values are ever probed).
      EXECUTE format(
        $sql$
          CREATE INDEX IF NOT EXISTS emails_internet_message_id_idx
            ON %I.emails (internet_message_id)
            WHERE internet_message_id IS NOT NULL;
        $sql$,
        tenant_schema
      );
    END IF;
  END LOOP;
END
$tenant$;
