-- Migration 0162: attribution_role discriminator on deal_signed_commissions.
--
-- WHY (money-safety): the estimator-removal path deletes a deal's commission row scoped to
-- (deal_id, rep_user_id = estimator). After an OWNER reassignment the deal's rep_user_id can no longer
-- distinguish the OWNER's full-cut row from an ESTIMATOR's additive row, so an estimator delete could
-- wipe an owner's row. `attribution_role` makes the role explicit so the estimator delete can scope to
-- attribution_role = 'estimator' and NEVER touch an owner row.
--
-- Every PRE-EXISTING row is an OWNER full-cut row (the additive estimator row is introduced by this PR),
-- so the 'owner' DEFAULT is correct for the backfill. NOT part of the (deal_id, rep_user_id) unique key.
--
-- Per-tenant (office_*) + the TENANT_SCHEMA block for new tenants. Idempotent / replayable.

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deal_signed_commissions', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.deal_signed_commissions ADD COLUMN IF NOT EXISTS attribution_role text NOT NULL DEFAULT ''owner''',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by IF NOT EXISTS).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deal_signed_commissions ADD COLUMN IF NOT EXISTS attribution_role text NOT NULL DEFAULT 'owner';
-- TENANT_SCHEMA_END
