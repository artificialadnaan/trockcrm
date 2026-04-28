-- Migration 0062: deal_signed_commissions per-tenant table
--
-- Captures the booked/awarded commission at the moment a deal's
-- contract_signed_date transitions from null → a date. Distinct from
-- 0043's deal_payment_events table, which models earned commissions on
-- cash actually received. This table is the "we owe this rep $X for
-- closing this deal" record at signing time.
--
-- Idempotency guard: UNIQUE(deal_id, rep_user_id) so the calculation can
-- be retried safely (e.g. if the deal-update transaction fires twice for
-- the same null→date transition due to a retry, only one row lands).

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'migration')
      AND schema_name NOT LIKE 'pg_%'
  LOOP
    IF to_regclass(format('%I.deals', tenant_schema)) IS NOT NULL THEN
      EXECUTE format(
        $sql$
          CREATE TABLE IF NOT EXISTS %I.deal_signed_commissions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            deal_id UUID NOT NULL REFERENCES %I.deals(id) ON DELETE CASCADE,
            rep_user_id UUID NOT NULL REFERENCES public.users(id),
            source_value_kind TEXT NOT NULL,
            source_value_amount NUMERIC(14,2) NOT NULL,
            applied_rate NUMERIC(7,6) NOT NULL,
            amount NUMERIC(14,2) NOT NULL,
            contract_signed_date_at_signing DATE NOT NULL,
            calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by UUID REFERENCES public.users(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT deal_signed_commissions_dedup UNIQUE (deal_id, rep_user_id),
            CONSTRAINT deal_signed_commissions_amount_non_negative_chk CHECK (amount >= 0),
            CONSTRAINT deal_signed_commissions_source_value_non_negative_chk CHECK (source_value_amount >= 0),
            CONSTRAINT deal_signed_commissions_rate_bounds_chk CHECK (applied_rate >= 0 AND applied_rate <= 1),
            CONSTRAINT deal_signed_commissions_source_value_kind_chk CHECK (
              source_value_kind IN ('awarded_amount', 'bid_estimate', 'dd_estimate')
            )
          )
        $sql$,
        tenant_schema, tenant_schema
      );

      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deal_signed_commissions_rep_calc_idx ON %I.deal_signed_commissions (rep_user_id, calculated_at DESC)',
        tenant_schema
      );
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS deal_signed_commissions_deal_idx ON %I.deal_signed_commissions (deal_id)',
        tenant_schema
      );
    END IF;
  END LOOP;
END $$;
