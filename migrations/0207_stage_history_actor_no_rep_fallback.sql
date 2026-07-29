-- Migration 0207: stop attributing unattributed stage writes to the deal's assigned rep.
--
-- The 0143 backstop resolves the actor as
--   coalesce(app.current_user_id, NEW.assigned_rep_id, NEW.created_by_user_id)
-- because deal_stage_history.changed_by was NOT NULL + FK to public.users: it had to name SOMEBODY or
-- drop the row. The fallback is therefore not a guess about who acted — it is a guess about who to blame
-- when nobody is known, and it reads downstream as fact.
--
-- Two real consequences, both observed in production:
--
--   1. INVESTIGATIONS ARE MISDIRECTED. On 2026-07-28 and again on 2026-07-29 a nightly sync moved deals
--      with no session actor; every row was stamped with that deal's own assigned rep, so one batch job
--      presented as five different reps hand-moving months-old deals inside a few minutes. Both times the
--      first hours of diagnosis went into "which rep did this".
--
--   2. USAGE METRICS ARE INFLATED. server/src/scripts/usage-rollup.ts counts DISTINCT changed_by from
--      deal_stage_history as evidence a user was ACTIVE that day. A 147-deal sync run therefore marked
--      every one of those reps active on a day they may not have signed in.
--
-- The honest value is NULL. `changed_by` becomes nullable and the fallback is removed, so a write with no
-- session actor records the transition and declines to name one.
--
-- This also RECOVERS history that is silently lost today: the backstop currently skips the row entirely
-- when no actor resolves, so a stage change on a deal with neither an assigned rep nor a creator leaves no
-- trace at all. Recording it with a null actor is strictly more truthful than not recording it.
--
-- Deliberately NOT backfilled. Existing rows cannot be separated from genuine rep moves without a
-- heuristic (changed_by = assigned_rep_id AND created_at = stage_entered_at), and that heuristic
-- misclassifies the common case of a rep moving their own deal. This governs transitions from here on,
-- the same scope 0143 took.

-- 1. Existing offices: allow the honest answer.
DO $mig$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.deal_stage_history ALTER COLUMN changed_by DROP NOT NULL',
      tenant_schema
    );
  END LOOP;
END
$mig$;

-- 2. Future offices: provisioning replays this block (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deal_stage_history ALTER COLUMN changed_by DROP NOT NULL;
-- TENANT_SCHEMA_END

-- 3. The backstop itself. Identical to 0143 except for actor resolution and the removal of the
--    "skip the row if no actor" guard; the skip flag, the no-op check, the backward-move computation,
--    created_at mirroring stage_entered_at, and the never-roll-back exception guard are unchanged.
CREATE OR REPLACE FUNCTION public.record_stage_history()
RETURNS trigger AS $body$
DECLARE
  v_actor uuid;
  v_backward boolean;
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

  -- Strictly best-effort: nothing below may roll back the stage change that fired this trigger.
  BEGIN
    -- The SESSION actor or nobody. A write that set no app.current_user_id was made by a script, a
    -- worker, a sync or raw SQL, and naming the deal's assigned rep here states something untrue about a
    -- real person. NULL means "no actor was identified", which is the fact.
    v_actor := nullif(current_setting('app.current_user_id', true), '')::uuid;

    -- created_at mirrors deals.stage_entered_at (NOT now()) so the row reflects the actual
    -- stage-entry time. For normal transitions the reset trigger already set stage_entered_at = now();
    -- for creation paths that supply a backdated stage_entered_at (e.g. the SyncHub mirror create) the
    -- history is dated correctly, and created_at == stage_entered_at holds by construction.
    --
    -- Recorded unconditionally now: the old `IF v_actor IS NOT NULL` guard silently discarded the
    -- transition whenever nobody could be named, which lost exactly the machine-made history that is
    -- hardest to reconstruct later.
    IF TG_OP = 'INSERT' THEN
      EXECUTE format(
        'INSERT INTO %I.deal_stage_history '
        || '(deal_id, from_stage_id, to_stage_id, changed_by, duration_in_previous_stage, created_at) '
        || 'VALUES ($1, NULL, $2, $3, NULL, $4)',
        TG_TABLE_SCHEMA
      ) USING NEW.id, NEW.stage_id, v_actor, NEW.stage_entered_at;
    ELSE
      -- Mark backward moves so the History/Timeline UI does not render a backstop-recorded
      -- reversal as a forward change. Best-effort by pipeline display_order (the same
      -- definition the worker reverse-sync uses); unknown orders fall back to false.
      SELECT nps.display_order < ops.display_order
        INTO v_backward
        FROM public.pipeline_stage_config ops, public.pipeline_stage_config nps
        WHERE ops.id = OLD.stage_id AND nps.id = NEW.stage_id;
      EXECUTE format(
        'INSERT INTO %I.deal_stage_history '
        || '(deal_id, from_stage_id, to_stage_id, changed_by, is_backward_move, duration_in_previous_stage, created_at) '
        || 'VALUES ($1, $2, $3, $4, $5, $6, $7)',
        TG_TABLE_SCHEMA
      ) USING NEW.id, OLD.stage_id, NEW.stage_id, v_actor, coalesce(v_backward, false),
              NEW.stage_entered_at - OLD.stage_entered_at, NEW.stage_entered_at;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'record_stage_history backstop skipped for deal %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$body$ LANGUAGE plpgsql;
