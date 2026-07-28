-- Migration 0201: field_scorecards.corrective_action_oversight_opened_at / _closed_at — per-cycle
-- idempotency stamps for the OVERSIGHT notification (the FIELD_SCORECARD_EMAIL_RECIPIENTS watchers who are
-- told once when a corrective action opens and once when it completes).
--
-- Deliberately SEPARATE from corrective_action_email_sent_at. That stamp governs the RESPONDER notification
-- state machine: it suppresses duplicate responder sends and gates the server reconcile's re-enqueue
-- decision. Letting an oversight-send failure write to it would corrupt responder delivery.
--
-- Cleared where a genuinely new BUSINESS cycle starts: reconcileScorecardCorrectiveActions'
-- transitioningIntoOpen branch (a fresh submit, or an edit reopening a closed/submitted card). A reopen
-- therefore re-notifies oversight, while a queue retry never double-sends.
--
-- Deliberately NOT cleared by restartCorrectiveActionNotificationCycleForDeal / ...ForResponder. Those
-- restart the RESPONDER cycle after a super/PM reassignment, and only ever touch cards already at
-- 'corrective_action_open' — the corrective action never left open, so nothing new happened for oversight.
-- Clearing there would re-send the "opened" notice on every team-tab reassignment.
--
-- Also adds corrective_action_oversight_cycle: an INDEPENDENT supersession marker for the oversight flow.
-- corrective_action_cycle_nonce cannot serve that purpose, because the responder worker's self-repair path
-- rotates it WITHOUT starting a new business cycle — so a handler gating its send on that nonce could not
-- tell "my cycle was superseded by a reopen" (skip) from "the responder job repaired itself" (must still
-- send), and choosing either answer breaks one of the two. This column is rotated ONLY where a genuinely new
-- corrective-action cycle begins, so the oversight handler can safely refuse to send when it no longer
-- matches. Retiring queued jobs at the reopen is not sufficient on its own: a job already CLAIMED by a worker
-- is past that point, and the delivery stamp guard blocks only the stamp, never the send.
--
-- NOTE on the cycle nonce: the oversight handler dedups on THESE stamps alone and never compares its
-- payload nonce against corrective_action_cycle_nonce. The responder worker has a self-repair path that
-- rotates the stored nonce and re-enqueues itself; a pending oversight job minted with the older nonce
-- would then find payload != stored and return early, and the "opened" notice would never be sent. The
-- nonce is used only as the Resend idempotency-key dimension, read from the immutable payload.
--
-- Per-tenant (office_* schemas), idempotent + guarded per schema.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.field_scorecards
         ADD COLUMN IF NOT EXISTS corrective_action_oversight_opened_at timestamptz,
         ADD COLUMN IF NOT EXISTS corrective_action_oversight_closed_at timestamptz,
         ADD COLUMN IF NOT EXISTS corrective_action_oversight_cycle uuid',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards
  ADD COLUMN IF NOT EXISTS corrective_action_oversight_opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS corrective_action_oversight_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS corrective_action_oversight_cycle uuid;
-- TENANT_SCHEMA_END
