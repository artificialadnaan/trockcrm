-- Migration 0141: app-owned Won-period reporting date column.
--
-- Adds deals.won_closed_date (nullable DATE) to every office_* tenant schema.
-- This is the EXPAND step of an expand / migrate / contract for Won-period
-- reporting. Today the reporting helpers gate Won YTD/MTD windows on
-- hubspot_extra_properties->>'hs_closed_won_date' (a HubSpot JSON blob; the
-- HubSpot connection is seed-only / disconnected). That basis is correct but
-- fragile. The two rejected alternatives:
--   - actual_close_date: reseed-contaminated (mass-stamped by a Bid-Board reseed)
--     and reintroduces bid-board same-day collisions; never use it for period
--     gating.
--   - contract_signed_date: NULL on all Won deals; reserved for the commissions
--     page.
-- won_closed_date is purpose-built, written ONLY by changeDealStage on Won-outcome
-- entry (and cleared on reopen / Lost), so it is contamination-free and decoupled
-- from the HubSpot blob.
--
-- SAFETY: this migration is purely ADDITIVE. Reads and writes are UNCHANGED by it.
-- The dual-write (changeDealStage) ships in the SAME release so new wins populate
-- the column. The read helpers are flipped to this column only in a LATER,
-- separately-gated change, and only AFTER a per-office parity backfill proves
-- won_closed_date reproduces each office's current Won total. The live Won number
-- is therefore unchanged by this migration. Idempotent via IF NOT EXISTS.
--
-- Full rationale + sequencing: .reviews/trockcrm-date-field-decision/plan.md
-- Pattern mirrors migration 0131 (per-tenant ADD COLUMN loop).

DO $tenant$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    EXECUTE format(
      $sql$
        ALTER TABLE %I.deals
          ADD COLUMN IF NOT EXISTS won_closed_date date;
      $sql$,
      tenant_schema
    );
  END LOOP;
END
$tenant$;
