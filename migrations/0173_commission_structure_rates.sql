-- Migration 0173: solo/mixed commission structure + per-rep capX and service-source rates.
--
-- Adds four columns to the SHARED public.user_commission_settings table (one row per user):
--   commission_structure  'solo' | 'mixed' -- the rep's active structure.
--   capx_rate_solo        capX rate when solo (the higher rate).
--   capx_rate_mixed       capX rate when mixed (the lower rate).
--   service_source_rate   rate on service deals this rep sourced (effective under 'mixed' only).
--
-- The existing commission_rate column is RETAINED as the denormalized EFFECTIVE capX rate,
-- kept in sync by the settings-save. Backfill sets both capX rates to the current
-- commission_rate and leaves every rep on 'solo', so the effective rate is UNCHANGED and no
-- payout moves on deploy. Idempotent: IF NOT EXISTS + re-runnable UPDATE.
--
-- public.user_commission_settings is a single shared table (FK to public.users), so this is a
-- plain ALTER -- no per-tenant office_* loop and no provisioner replay block.

ALTER TABLE public.user_commission_settings
  ADD COLUMN IF NOT EXISTS commission_structure text NOT NULL DEFAULT 'solo';
ALTER TABLE public.user_commission_settings
  ADD COLUMN IF NOT EXISTS capx_rate_solo numeric(7,6) NOT NULL DEFAULT 0;
ALTER TABLE public.user_commission_settings
  ADD COLUMN IF NOT EXISTS capx_rate_mixed numeric(7,6) NOT NULL DEFAULT 0;
ALTER TABLE public.user_commission_settings
  ADD COLUMN IF NOT EXISTS service_source_rate numeric(7,6) NOT NULL DEFAULT 0;

-- Backfill: existing reps keep their current effective rate. Both capX rates start equal to
-- commission_rate; structure stays 'solo' (the default). Re-runnable (guarded so it only seeds
-- rows still carrying the 0 default, never clobbering an edited rate on re-run).
UPDATE public.user_commission_settings
SET capx_rate_solo = commission_rate,
    capx_rate_mixed = commission_rate
WHERE capx_rate_solo = 0
  AND capx_rate_mixed = 0
  AND commission_rate <> 0;
