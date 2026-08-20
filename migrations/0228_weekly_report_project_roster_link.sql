-- Migration 0228: point a weekly-report project's PM and superintendent at the FIELD TEAM ROSTER.
--
-- 0227 is the highest number on origin/main, so 0228 is the next free one.
--
-- WHY. `trock_pm_user_id` / `trock_super_user_id` are `public.users` FKs, and the picker that fills them
-- offers only users whose role is one of field_contractor / construction / admin / director. Measured
-- against the actual Dallas roster, that picker can offer SIX of the FIFTEEN active field-team members:
--
--   • 4 hold a login whose role is `rep` (Adam Sherwood, Andrew Green, Brett Bell, Caleb Stone). They are
--     real PMs and superintendents; `rep` was excluded from the picker so the sales roster would not bury
--     the handful of real candidates, and it took these four with it.
--   • 5 have no `public.users` row at all (Corey McShane, Eric Burnett, Kevin Posey, Nick Cheatam,
--     Triston Mitchell). They are field staff who never needed a CRM login.
--
-- `field_responders` (0198) is the director-managed roster the deal Team tab and the QC scorecards already
-- pick from, it is constrained to exactly the two roles this feature needs, and it contains all fifteen.
-- It is the right source for the LIST.
--
-- WHAT THIS DOES NOT DO. It does not move the authorisation. `trock_pm_user_id` is what `isAssignedPm`
-- compares against the acting user's id to decide who may approve and send, what `assignments-service`
-- filters "my projects" on, and who the reminder job emails. A roster row is a name and an address; it
-- cannot authorise anything. So the two ideas are stored SEPARATELY:
--
--   trock_*_responder_id  — WHO this is. Drives the picker, the printed PDF name, the reminder address.
--   trock_*_user_id       — the login that person signs in with, resolved by email at write time, or NULL.
--
-- Splitting them is what lets Adam Sherwood be selected at all (roster row + `rep` login, previously
-- unofferable) while keeping every existing gate byte-for-byte unchanged. For the five with no login the
-- responder id is set and the user id stays NULL: their name prints correctly and they receive reminders,
-- and approval falls back to the elevated (admin/director) arm that already exists. The form says so
-- rather than leaving it to be discovered.
--
-- BACKFILL. Existing rows are matched roster-ward by email, which is the only stable identifier the two
-- tables share (the roster carries no user_id). Case-insensitive, ACTIVE roster rows only, and only where
-- the match is UNAMBIGUOUS — a duplicated address leaves the column NULL rather than guessing, because a
-- wrong PM here silently reassigns who may approve a client-facing report. In production this touches a
-- single test project; the query is written to be correct on a real one.
--
-- Per-office, like every weekly-report table bar the public share token. Skips any office lacking
-- `weekly_report_projects` or `field_responders`, so an ALTER against a table that was never created
-- there cannot abort the migration for every office after it.
--
-- Idempotent / replayable: ADD COLUMN IF NOT EXISTS, a guarded constraint add, CREATE INDEX IF NOT
-- EXISTS, and a backfill that only writes rows still NULL.

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.weekly_report_projects', schema_name)) IS NULL
       OR to_regclass(format('%I.field_responders', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.weekly_report_projects
         ADD COLUMN IF NOT EXISTS trock_pm_responder_id uuid,
         ADD COLUMN IF NOT EXISTS trock_super_responder_id uuid',
      schema_name
    );

    -- Added separately from the columns: ADD CONSTRAINT has no IF NOT EXISTS, so a replay would raise
    -- 42710 and abort. ON DELETE SET NULL because the roster deactivates rather than deletes — this
    -- fires only if somebody removes a row by hand, and losing the link beats a failed delete.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('%I.weekly_report_projects', schema_name)::regclass
         AND conname = 'weekly_report_projects_pm_responder_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.weekly_report_projects
           ADD CONSTRAINT weekly_report_projects_pm_responder_fkey
           FOREIGN KEY (trock_pm_responder_id) REFERENCES %I.field_responders(id) ON DELETE SET NULL',
        schema_name, schema_name
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('%I.weekly_report_projects', schema_name)::regclass
         AND conname = 'weekly_report_projects_super_responder_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.weekly_report_projects
           ADD CONSTRAINT weekly_report_projects_super_responder_fkey
           FOREIGN KEY (trock_super_responder_id) REFERENCES %I.field_responders(id) ON DELETE SET NULL',
        schema_name, schema_name
      );
    END IF;

    -- "Which projects is this person the PM / super on" — the drill-down behind a roster row, and the
    -- lookup the reminder job runs per person. Partial: most projects fill both slots, but a NULL slot
    -- is exactly the row this index should not carry.
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS weekly_report_projects_pm_responder_idx
         ON %I.weekly_report_projects (trock_pm_responder_id)
        WHERE trock_pm_responder_id IS NOT NULL',
      schema_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS weekly_report_projects_super_responder_idx
         ON %I.weekly_report_projects (trock_super_responder_id)
        WHERE trock_super_responder_id IS NOT NULL',
      schema_name
    );

    -- Backfill. The subquery is correlated on the CURRENT user link's email and resolves only when
    -- exactly one ACTIVE roster person holds that address, so an ambiguous roster leaves NULL. Restricted
    -- to the matching ROLE as well: a person on the roster as a superintendent must not be backfilled
    -- into the PM slot just because they happen to be the user sitting in it.
    --
    -- `(array_agg(...))[1]` with a bare HAVING, rather than `SELECT fr.id ... HAVING count(*) = 1`: the
    -- latter is an aggregate query whose target list is not grouped, which Postgres rejects outright. This
    -- form yields one row when the match is unique and NO rows otherwise (count 0 or >1 both fail the
    -- HAVING), and a scalar subquery returning no rows is NULL — exactly the "don't guess" behaviour.
    EXECUTE format(
      'UPDATE %I.weekly_report_projects wrp
          SET trock_pm_responder_id = (
                SELECT (array_agg(fr.id))[1]
                  FROM %I.field_responders fr
                  JOIN public.users u ON lower(u.email) = lower(fr.email)
                 WHERE u.id = wrp.trock_pm_user_id
                   AND fr.is_active
                   AND fr.role = ''project_manager''
                HAVING count(*) = 1
              )
        WHERE wrp.trock_pm_responder_id IS NULL
          AND wrp.trock_pm_user_id IS NOT NULL',
      schema_name, schema_name
    );
    EXECUTE format(
      'UPDATE %I.weekly_report_projects wrp
          SET trock_super_responder_id = (
                SELECT (array_agg(fr.id))[1]
                  FROM %I.field_responders fr
                  JOIN public.users u ON lower(u.email) = lower(fr.email)
                 WHERE u.id = wrp.trock_super_user_id
                   AND fr.is_active
                   AND fr.role = ''superintendent''
                HAVING count(*) = 1
              )
        WHERE wrp.trock_super_responder_id IS NULL
          AND wrp.trock_super_user_id IS NOT NULL',
      schema_name, schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- Both halves are required. The DO loop above fixes the offices that already exist; without this block a
-- NEWLY provisioned office gets 0227's shape, and the first person who opens the setup form there is
-- offered a picker backed by a column that does not exist.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.weekly_report_projects
  ADD COLUMN IF NOT EXISTS trock_pm_responder_id uuid,
  ADD COLUMN IF NOT EXISTS trock_super_responder_id uuid;

DO $tenant_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'office_dallas.weekly_report_projects'::regclass
       AND conname = 'weekly_report_projects_pm_responder_fkey'
  ) THEN
    ALTER TABLE office_dallas.weekly_report_projects
      ADD CONSTRAINT weekly_report_projects_pm_responder_fkey
      FOREIGN KEY (trock_pm_responder_id) REFERENCES office_dallas.field_responders(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'office_dallas.weekly_report_projects'::regclass
       AND conname = 'weekly_report_projects_super_responder_fkey'
  ) THEN
    ALTER TABLE office_dallas.weekly_report_projects
      ADD CONSTRAINT weekly_report_projects_super_responder_fkey
      FOREIGN KEY (trock_super_responder_id) REFERENCES office_dallas.field_responders(id) ON DELETE SET NULL;
  END IF;
END $tenant_fk$;

CREATE INDEX IF NOT EXISTS weekly_report_projects_pm_responder_idx
  ON office_dallas.weekly_report_projects (trock_pm_responder_id)
  WHERE trock_pm_responder_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS weekly_report_projects_super_responder_idx
  ON office_dallas.weekly_report_projects (trock_super_responder_id)
  WHERE trock_super_responder_id IS NOT NULL;
-- TENANT_SCHEMA_END
