-- Migration 0229: admit a FOURTH weekly-report reminder kind — the 5pm escalation to the sales rep.
--
-- 0228 is the highest number on this stack, so 0229 is the next free one.
--
-- WHY. The reminder cron runs 07:00 with catch-up ticks at 09:00 and 11:00 CT, in three kinds:
-- `t_minus_2` and `t_minus_1` nudge the superintendent and the PM, `due_digest` tells leadership what is
-- outstanding. After 11:00 on the due day nothing else happens, ever — so a report that is simply not
-- written goes unmentioned until the next week's cycle starts, and the person who owns the CLIENT
-- relationship is never told that the client is not getting their report.
--
-- `rep_escalation` is that fourth tier: at 17:00 CT on the due date, if the report has still not reached
-- `pending_review`, the deal's assigned sales rep is emailed and the PM is copied.
--
-- WHAT THIS MIGRATION DOES, AND WHY IT IS ONLY A CONSTRAINT. `weekly_report_reminders_sent` already has
-- everything the new kind needs — a project, a week, a kind and a sent stamp. The one thing standing in
-- the way is `weekly_report_reminders_sent_kind_check`, which lists the three existing kinds by name. A
-- fourth kind INSERTs into a constraint that rejects it, so the constraint has to widen before the job
-- that writes it ships. Nothing else about the table changes.
--
-- DROP-then-ADD rather than an ALTER: Postgres has no "alter constraint" for a CHECK. Both halves are
-- guarded so a replay is a no-op — the runner tracks migrations by filename and will not re-run this,
-- but a replay is a routine thing to need and a migration that cannot survive one is a trap.
--
-- Per-office, like the table itself. An office lacking `weekly_report_reminders_sent` is SKIPPED rather
-- than failing the whole migration for every office after it — the same rule 0226 and 0228 follow.

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.weekly_report_reminders_sent', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    -- IF EXISTS, so an office that somehow never had the constraint is widened rather than skipped.
    EXECUTE format(
      'ALTER TABLE %I.weekly_report_reminders_sent
         DROP CONSTRAINT IF EXISTS weekly_report_reminders_sent_kind_check',
      schema_name
    );
    EXECUTE format(
      'ALTER TABLE %I.weekly_report_reminders_sent
         ADD CONSTRAINT weekly_report_reminders_sent_kind_check
         CHECK (kind IN (''t_minus_2'', ''t_minus_1'', ''due_digest'', ''rep_escalation''))',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- Both halves are required. The DO loop above fixes the offices that already exist; without this block a
-- NEWLY provisioned office keeps the three-kind constraint, and the first 5pm escalation there fails on
-- a CHECK violation — which the job would log and swallow, so the rep would simply never be told.
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.weekly_report_reminders_sent
  DROP CONSTRAINT IF EXISTS weekly_report_reminders_sent_kind_check;

ALTER TABLE office_dallas.weekly_report_reminders_sent
  ADD CONSTRAINT weekly_report_reminders_sent_kind_check
  CHECK (kind IN ('t_minus_2', 't_minus_1', 'due_digest', 'rep_escalation'));
-- TENANT_SCHEMA_END
