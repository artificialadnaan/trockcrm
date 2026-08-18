-- Migration 0223: the stretches during which a project was NOT reporting.
--
-- 0222 gave a setup a status of active | paused | completed, and the CRM promises that paused and
-- completed projects "stop generating weeks". They did not. The dashboard regenerates the expected weeks
-- from `cadence_start_date` through the current week on every read, and `status` is merely a filter on
-- which projects are generated at all — so a project paused for six weeks and then set back to Active
-- came back owing all six, each one "Not started" and late, with the reminder worker chasing a
-- superintendent for reports leadership had explicitly stood down.
--
-- WHY AN INTERVAL RATHER THAN MOVING cadence_start_date. Advancing the start date on resume is one line
-- and wrong twice over: it erases the weeks genuinely missed BEFORE the pause, which is the whole
-- accountability the board exists to create, and it rewrites the answer to "when did we start reporting
-- to this client" — a fact the report header prints. Recording the pause remembers; moving the start
-- date forgets.
--
-- `resumed_on IS NULL` means reporting is still stopped. The partial unique index allows exactly ONE open
-- interval per project, so two PATCHes racing the same pause cannot leave overlapping stretches for the
-- week generator to reconcile.
--
-- Per-office, like every weekly-report table bar the public share token. Skips any office without
-- `weekly_report_projects` — 0222 itself skips offices lacking `deals`/`files`, and a pause table
-- referencing a setup table that does not exist is worse than no table.

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.weekly_report_projects', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.weekly_report_pauses (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         weekly_report_project_id uuid NOT NULL REFERENCES %I.weekly_report_projects(id) ON DELETE CASCADE,
         paused_from date NOT NULL,
         resumed_on date,
         paused_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
         resumed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT weekly_report_pauses_range CHECK (resumed_on IS NULL OR resumed_on >= paused_from)
       )',
      schema_name, schema_name
    );
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS weekly_report_pauses_open_uidx
         ON %I.weekly_report_pauses (weekly_report_project_id) WHERE resumed_on IS NULL',
      schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS weekly_report_pauses_project_idx
         ON %I.weekly_report_pauses (weekly_report_project_id, paused_from)',
      schema_name
    );

    -- Anything already sitting in a non-active status was stopped at a moment nobody recorded, so it gets
    -- an open interval here or it resumes owing the whole pause. `updated_at` is the closest recorded
    -- moment the row changed: it can only be LATER than the true pause, which errs towards still asking
    -- for a week rather than silently forgiving one.
    EXECUTE format(
      'INSERT INTO %I.weekly_report_pauses (weekly_report_project_id, paused_from)
       SELECT wrp.id, wrp.updated_at::date
         FROM %I.weekly_report_projects wrp
        WHERE wrp.is_active
          AND wrp.status <> ''active''
          AND NOT EXISTS (
                SELECT 1 FROM %I.weekly_report_pauses p
                 WHERE p.weekly_report_project_id = wrp.id AND p.resumed_on IS NULL
              )',
      schema_name, schema_name, schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.weekly_report_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_report_project_id uuid NOT NULL REFERENCES office_dallas.weekly_report_projects(id) ON DELETE CASCADE,
  paused_from date NOT NULL,
  resumed_on date,
  paused_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  resumed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_report_pauses_range CHECK (resumed_on IS NULL OR resumed_on >= paused_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS weekly_report_pauses_open_uidx
  ON office_dallas.weekly_report_pauses (weekly_report_project_id) WHERE resumed_on IS NULL;
CREATE INDEX IF NOT EXISTS weekly_report_pauses_project_idx
  ON office_dallas.weekly_report_pauses (weekly_report_project_id, paused_from);
-- TENANT_SCHEMA_END
