-- Migration 0143: Re-enable forward deal_stage_history recording as a DB backstop.
--
-- Background (see .audit/stage-history-data.md): the original stage_history_trigger
-- was disabled in 0003 because changeDealStage inserts its own rich history row, so
-- the trigger duplicated it. The side effect: every OTHER path that changes a deal's
-- stage -- bid-board sync, internal-rfp, routing, scoping, bulk/raw SQL -- records no
-- history at all, and deal creation records none either.
--
-- This migration restores the trigger as a universal backstop that CANNOT be bypassed
-- by a forgotten helper call, while staying de-duplicated against the app's rich insert:
--   * Skips itself when the app set app.skip_stage_history_trigger = '1' (changeDealStage
--     and the demo seed set it), so the app's explicit insert is never doubled.
--   * Fires for every OTHER INSERT/UPDATE of stage_id, from any caller or raw SQL.
--   * Schema-safe: inserts into TG_TABLE_SCHEMA.deal_stage_history via dynamic SQL, so it
--     is correct even when the caller did not set search_path (e.g. the bid-board sync,
--     which issues fully schema-qualified UPDATEs).
--   * Never breaks a stage change: deal_stage_history.changed_by is NOT NULL + FK to
--     public.users, so we resolve an actor (session user -> assigned rep -> creator) and
--     SKIP the row if none resolves; an exception guard makes recording strictly
--     best-effort so it can never roll back the underlying stage change.
--
-- We do NOT backfill historical entry dates (that history was lost across seeds/imports);
-- this only governs transitions from the moment it ships forward.
--
-- Idempotent (CREATE OR REPLACE, DROP TRIGGER IF EXISTS + CREATE) and tenant-aware
-- (DO-loop over existing office_* schemas + a TENANT_SCHEMA block for future offices,
-- per the 0122 pattern).

-- 1. One schema-agnostic function in public; office triggers reference it. TG_TABLE_SCHEMA
--    makes it insert into the firing table's own schema regardless of search_path.
CREATE OR REPLACE FUNCTION public.record_stage_history()
RETURNS trigger AS $body$
DECLARE
  v_actor uuid;
BEGIN
  -- The app (changeDealStage) and the demo seed record history explicitly and set this
  -- transaction-local flag so this backstop does not duplicate their rows.
  IF coalesce(current_setting('app.skip_stage_history_trigger', true), '') = '1' THEN
    RETURN NEW;
  END IF;

  -- Only act on creation and genuine stage changes (ignore no-op updates).
  IF TG_OP = 'UPDATE' AND OLD.stage_id IS NOT DISTINCT FROM NEW.stage_id THEN
    RETURN NEW;
  END IF;

  -- Strictly best-effort: nothing below (actor resolution, the uuid cast, or the insert)
  -- may roll back the stage change that fired this trigger. changed_by is NOT NULL + FK to
  -- public.users, so we resolve an actor (session user -> assigned rep -> creator) and skip
  -- the history row entirely if none resolves, rather than fail the transition.
  BEGIN
    v_actor := coalesce(
      nullif(current_setting('app.current_user_id', true), '')::uuid,
      NEW.assigned_rep_id,
      NEW.created_by_user_id
    );
    -- created_at mirrors deals.stage_entered_at (NOT now()) so the row reflects the actual
    -- stage-entry time. For normal transitions the reset trigger already set
    -- stage_entered_at = now(); for creation paths that supply a backdated stage_entered_at
    -- (e.g. the SyncHub mirror create) the history is dated correctly, and created_at ==
    -- stage_entered_at holds by construction.
    IF v_actor IS NOT NULL THEN
      IF TG_OP = 'INSERT' THEN
        EXECUTE format(
          'INSERT INTO %I.deal_stage_history '
          || '(deal_id, from_stage_id, to_stage_id, changed_by, duration_in_previous_stage, created_at) '
          || 'VALUES ($1, NULL, $2, $3, NULL, $4)',
          TG_TABLE_SCHEMA
        ) USING NEW.id, NEW.stage_id, v_actor, NEW.stage_entered_at;
      ELSE
        EXECUTE format(
          'INSERT INTO %I.deal_stage_history '
          || '(deal_id, from_stage_id, to_stage_id, changed_by, duration_in_previous_stage, created_at) '
          || 'VALUES ($1, $2, $3, $4, $5, $6)',
          TG_TABLE_SCHEMA
        ) USING NEW.id, OLD.stage_id, NEW.stage_id, v_actor,
                NEW.stage_entered_at - OLD.stage_entered_at, NEW.stage_entered_at;
      END IF;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'record_stage_history backstop skipped for deal %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$body$ LANGUAGE plpgsql;

-- 2. Existing offices: (re)attach the backstop trigger.
DO $mig$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS stage_history_trigger ON %I.deals', tenant_schema);
    EXECUTE format(
      'CREATE TRIGGER stage_history_trigger AFTER INSERT OR UPDATE ON %I.deals '
      || 'FOR EACH ROW EXECUTE FUNCTION public.record_stage_history()',
      tenant_schema
    );
  END LOOP;
END
$mig$;

-- 3. Future offices: provisioning replays this block (office_dallas -> new schema).
-- TENANT_SCHEMA_START
DROP TRIGGER IF EXISTS stage_history_trigger ON office_dallas.deals;
CREATE TRIGGER stage_history_trigger AFTER INSERT OR UPDATE ON office_dallas.deals
  FOR EACH ROW EXECUTE FUNCTION public.record_stage_history();
-- TENANT_SCHEMA_END
