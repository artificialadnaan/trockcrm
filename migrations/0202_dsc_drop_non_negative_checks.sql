-- Migration 0202: drop deal_signed_commissions' amount / source_value_amount non-negative CHECKs.
--
-- WHY (do not restore these): a DEDUCTIVE change order carries a NEGATIVE amount, and the locked product
-- decision is that COMMISSION CLAWS BACK — the CO child mints its own owner commission row at the
-- NEGATIVE source value, so a rep's earned commission always equals their rate applied to the CURRENT
-- contract value. That claw-back row is, by construction, a row with amount < 0 and
-- source_value_amount < 0. Migration 0062's
--     deal_signed_commissions_amount_non_negative_chk        CHECK (amount >= 0)
--     deal_signed_commissions_source_value_non_negative_chk  CHECK (source_value_amount >= 0)
-- reject it with SQLSTATE 23514. That is not a survivable error: the mint runs INSIDE the deal-signing
-- transaction, and a CHECK violation ABORTS the Postgres transaction — so although addDealChangeOrder
-- catches the JS error and continues ("a commission-config gap must not block creating the CO"), the
-- subsequent COMMIT fails and the ENTIRE change order rolls back. Creating a deductive CO errored out
-- with nothing saved.
--
-- WHY NOT SCOPE THEM TO NON-CHANGE-ORDER ROWS INSTEAD: a CHECK cannot join, and deal_signed_commissions
-- has no is_change_order column of its own (the flag lives on deals). There is no predicate available to
-- a CHECK on this table that separates a claw-back row from an ordinary one. Dropping is therefore forced
-- by the claw-back decision, not a free choice. If negative rows ever need bounding, that belongs in a
-- trigger or the application layer, not a CHECK.
--
-- WHAT IS DELIBERATELY KEPT: deal_signed_commissions_rate_bounds_chk (applied_rate BETWEEN 0 AND 1) and
-- deal_signed_commissions_source_value_kind_chk stay. The claw-back is a NEGATIVE SOURCE VALUE at a
-- POSITIVE rate — the sign lives on the money, never on the rate — and resolveAppliedRateForRole only
-- ever returns a rate > 0, so nothing in the write path needs a negative rate.
--
-- Per-tenant (office_*) + the TENANT_SCHEMA block for new tenants. Idempotent / replayable
-- (DROP CONSTRAINT IF EXISTS is a no-op on a second run and on a freshly provisioned schema).

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
      'ALTER TABLE %I.deal_signed_commissions DROP CONSTRAINT IF EXISTS deal_signed_commissions_amount_non_negative_chk',
      schema_name
    );
    EXECUTE format(
      'ALTER TABLE %I.deal_signed_commissions DROP CONSTRAINT IF EXISTS deal_signed_commissions_source_value_non_negative_chk',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by IF EXISTS).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deal_signed_commissions DROP CONSTRAINT IF EXISTS deal_signed_commissions_amount_non_negative_chk;
ALTER TABLE office_dallas.deal_signed_commissions DROP CONSTRAINT IF EXISTS deal_signed_commissions_source_value_non_negative_chk;
-- TENANT_SCHEMA_END
