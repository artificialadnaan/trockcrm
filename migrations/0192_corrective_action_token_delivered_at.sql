-- Migration 0192: scorecard_corrective_action_tokens.delivered_at — a distinct DELIVERY marker.
-- Per-tenant (office_* schemas). The corrective-action email job INSERTS a token row BEFORE it sends the
-- email; a crash in that window leaves the row committed but the raw token never delivered. Recovery then
-- retries, and the reuse-existing-token skip (which inferred "delivered" from mere row existence) would skip
-- re-minting + re-sending while the scorecard-level stamp still marked it sent — so the recipient never got
-- the link. delivered_at fixes that: it is set ONLY AFTER a successful send, the reuse-skip requires
-- delivered_at IS NOT NULL (a token that exists but was never delivered is (re)sent, not skipped), and the
-- scorecard stamp requires every recipient delivered. consumed_at is unrelated (it marks a token USED by a
-- responder), so a distinct column is required. Nullable — existing rows predate the marker.
--
-- See docs/superpowers/specs/2026-07-22-scorecard-corrective-actions-design.md §5.

DO $tenant$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname LOOP
    IF to_regclass(format('%I.scorecard_corrective_action_tokens', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.scorecard_corrective_action_tokens ADD COLUMN IF NOT EXISTS delivered_at timestamptz',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.scorecard_corrective_action_tokens ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
-- TENANT_SCHEMA_END
