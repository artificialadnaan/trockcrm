-- Migration 0203: field_scorecards.corrective_action_approval_requested_at
--
-- The THIRD oversight phase stamp. Each phase dedups on its OWN column: the stamp is what encodes "this
-- cycle has been told", and a fresh cycle clears it server-side. Reusing corrective_action_oversight_opened_at
-- or _closed_at would make an approval request suppress the opened or the completion notice for the same
-- cycle -- a silently missed notification rather than a visible error.
--
-- Left NULL for every existing row, deliberately, and this is the OPPOSITE of migration 0201's grandfathering.
-- 0201 suppressed a phantom notice for a cycle whose opened phase had already passed unobserved. Here a card
-- sitting in corrective_action_submitted right now has real work in the approver's queue that nobody has told
-- them about, so the first notice is wanted, not suppressed.
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
         ADD COLUMN IF NOT EXISTS corrective_action_approval_requested_at timestamptz',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.field_scorecards
  ADD COLUMN IF NOT EXISTS corrective_action_approval_requested_at timestamptz;
-- TENANT_SCHEMA_END
