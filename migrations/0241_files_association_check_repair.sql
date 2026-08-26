-- Migration 0241: remove the obsolete files_association_check from existing and future office schemas.
--
-- 0232 originally rebuilt that CHECK to add marketing_expense_request_id. That is not a valid invariant:
-- field-photo capture deliberately confirms a targetless file and later presents it as a pending capture
-- for the user to assign. `NOT VALID` is not a repair because it still rejects every NEW targetless row.
--
-- Existing offices are repaired by the runner's runFilesAssociationCheckRepair step, one transaction per
-- office. An ALTER TABLE inside a SQL-file DO loop would hold ACCESS EXCLUSIVE locks on every files table
-- until the last office completed. The marker below is for provisionOfficeSchema: it runs after 0001's
-- historical CHECK and after 0232, so a newly provisioned office starts with the same valid shape.

-- A rollout can overlap an API container that still has the old 0232 file baked into its image. Such a
-- container creates public.offices and its tenant schema in one transaction. Keep this deferred trigger
-- permanently as a narrow compatibility guard: at that transaction's COMMIT it sees the completed schema
-- and removes only the obsolete named CHECK. New containers already provision the valid shape, so they
-- take the catalog fast path and do no ALTER TABLE work. CREATE TRIGGER serializes any older transaction
-- that already inserted public.offices; the runner's post-marker scan repairs that just-committed office.
CREATE OR REPLACE FUNCTION public.repair_files_association_check_after_office_provision()
RETURNS trigger
LANGUAGE plpgsql
AS $office_files$
DECLARE
  schema_name text := 'office_' || NEW.slug;
  files_relation regclass;
BEGIN
  -- `createOffice` accepts exactly this slug grammar. Fail closed because this function is attached to
  -- public.offices rather than only to that one application call site: a no-op would consume the deferred
  -- trigger event and let a caller commit a newly provisioned office with the obsolete CHECK.
  IF NEW.slug IS NULL OR NEW.slug !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Cannot provision files-association repair for invalid office slug "%"', NEW.slug;
  END IF;

  files_relation := to_regclass(format('%I.files', schema_name));
  IF files_relation IS NULL THEN
    RAISE EXCEPTION 'Office "%" was committed before its files table was provisioned', NEW.slug;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'files_association_check'
      AND conrelid = files_relation
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.files DROP CONSTRAINT IF EXISTS files_association_check',
      schema_name
    );
  END IF;

  RETURN NULL;
END $office_files$;

DROP TRIGGER IF EXISTS files_association_check_on_office_provision ON public.offices;
CREATE CONSTRAINT TRIGGER files_association_check_on_office_provision
AFTER INSERT ON public.offices
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.repair_files_association_check_after_office_provision();

-- TENANT_SCHEMA_START
DO $files$
BEGIN
  -- On a normal migration run the runner step removed this already, so avoid even a no-op table lock.
  -- During new-office provisioning, 0001 created the historical constraint and this removes it.
  IF to_regclass('office_dallas.files') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'files_association_check'
         AND conrelid = 'office_dallas.files'::regclass
     ) THEN
    ALTER TABLE office_dallas.files DROP CONSTRAINT files_association_check;
  END IF;
END $files$;
-- TENANT_SCHEMA_END
