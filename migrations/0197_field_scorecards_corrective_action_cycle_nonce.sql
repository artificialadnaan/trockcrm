-- Migration 0197: field_scorecards.corrective_action_cycle_nonce — persist the ACTIVE corrective-action
-- notification cycle's nonce on the scorecard so the worker's final delivery stamp can require the job's
-- payload.cycleNonce to still match the cycle currently awaiting delivery (P1 notification-cycle guard).
--
-- Crash scenario this closes: a token-email worker crashes AFTER the provider accepts cycle A but BEFORE
-- stamping corrective_action_email_sent_at; an edit/team-mutation then starts cycle B (deletes A's tokens,
-- mints a new cycleNonce). A's retry sees the provider's same-key response as delivered and, unguarded,
-- STAMPS the still-open scorecard → cycle B's job then skips (sent_at set) → the recipient's only delivered
-- link holds a DELETED cycle-A token → permanently stranded. The stamp UPDATE now ANDs
-- `corrective_action_cycle_nonce = payload.cycleNonce`, so a stale-cycle job (A) updates 0 rows and does NOT
-- stamp; cycle B's matching-nonce job stamps.
--
-- The server sets this column to the SAME cycleNonce it enqueues on EVERY fresh corrective-action cycle
-- (reconcile transitioningIntoOpen / alreadyOpenGainedWork + restartCorrectiveActionNotificationCycleForDeal),
-- in the same transaction, so the scorecard's stored nonce always equals the active cycle's job nonce.
--
-- Nullable: legacy scorecards (and legacy in-flight jobs whose payload has no cycleNonce) fall back to the
-- pre-guard behavior — the worker only ANDs the nonce clause when BOTH the payload nonce and the column are
-- present. Per-tenant (office_* schemas), idempotent + guarded per schema.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.field_scorecards', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.field_scorecards ADD COLUMN IF NOT EXISTS corrective_action_cycle_nonce uuid',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards ADD COLUMN IF NOT EXISTS corrective_action_cycle_nonce uuid;
-- TENANT_SCHEMA_END
