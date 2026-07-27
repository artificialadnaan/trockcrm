-- Migration 0201: field_scorecards.corrective_action_oversight_opened_at / _closed_at — per-cycle
-- idempotency stamps for the OVERSIGHT notification (the FIELD_SCORECARD_EMAIL_RECIPIENTS watchers who are
-- told once when a corrective action opens and once when it completes).
--
-- Deliberately SEPARATE from corrective_action_email_sent_at. That stamp governs the RESPONDER notification
-- state machine: it suppresses duplicate responder sends and gates the server reconcile's re-enqueue
-- decision. Letting an oversight-send failure write to it would corrupt responder delivery.
--
-- Both are cleared wherever a genuinely new cycle starts — i.e. every site that resets
-- corrective_action_email_sent_at to NULL (the reconcile enqueue and the shared restart helper behind
-- restartCorrectiveActionNotificationCycleForDeal / ...ForResponder) — so a reopen re-notifies oversight
-- while a queue retry never double-sends.
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
         ADD COLUMN IF NOT EXISTS corrective_action_oversight_closed_at timestamptz',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards
  ADD COLUMN IF NOT EXISTS corrective_action_oversight_opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS corrective_action_oversight_closed_at timestamptz;
-- TENANT_SCHEMA_END
