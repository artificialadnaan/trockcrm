-- Migration 0230: record WHICH report a week's starting values were carried from.
--
-- 0229 is the highest number on this stack, so 0230 is the next free one.
--
-- WHY A COLUMN AT ALL, when the carried values are just the previous report's. Because the phone has to
-- tell the superintendent that the Work Completed section holds LAST WEEK'S PLAN rather than a record of
-- what happened — and it has to stop saying so the moment they edit it.
--
-- Without this, "is this text carried or written" can only be answered by re-reading the previous
-- report and string-comparing, which is a second round trip on the jobsite and wrong the moment two
-- weeks legitimately say the same thing. The pointer answers it locally and exactly.
--
-- It is also the audit answer. A report whose work-completed section was never edited away from the
-- plan it inherited is a materially different artifact from one somebody wrote, and this is the only
-- record of that difference — which matters because the send gate's "work completed is not empty" check
-- is satisfied by carried text, and therefore now proves less than it used to.
--
-- NULLABLE and unconstrained by design: the first report on a project carries from nothing, and neither
-- does a correction. ON DELETE SET NULL because reports are soft-deleted, so this fires only if somebody
-- removes a row by hand — losing the pointer beats failing the delete.
--
-- Per-office. Skips any office lacking `weekly_reports`, like 0226 and 0228.

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.weekly_reports', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.weekly_reports ADD COLUMN IF NOT EXISTS carried_from_report_id uuid',
      schema_name
    );

    -- Separate from the column add: ADD CONSTRAINT has no IF NOT EXISTS, so an unguarded replay raises
    -- 42710 and aborts every office after this one.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('%I.weekly_reports', schema_name)::regclass
         AND conname = 'weekly_reports_carried_from_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.weekly_reports
           ADD CONSTRAINT weekly_reports_carried_from_fkey
           FOREIGN KEY (carried_from_report_id) REFERENCES %I.weekly_reports(id) ON DELETE SET NULL',
        schema_name, schema_name
      );
    END IF;
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- Both halves are required. Without this block a newly provisioned office gets 0229's shape, and the
-- first draft created there fails on a column that does not exist — which is the whole draft-creation
-- path, so weekly reporting in that office would not start at all.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.weekly_reports
  ADD COLUMN IF NOT EXISTS carried_from_report_id uuid;

DO $tenant_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'office_dallas.weekly_reports'::regclass
       AND conname = 'weekly_reports_carried_from_fkey'
  ) THEN
    ALTER TABLE office_dallas.weekly_reports
      ADD CONSTRAINT weekly_reports_carried_from_fkey
      FOREIGN KEY (carried_from_report_id) REFERENCES office_dallas.weekly_reports(id) ON DELETE SET NULL;
  END IF;
END $tenant_fk$;
-- TENANT_SCHEMA_END
