-- Migration 0043: Commission visibility foundations
-- - public.user_commission_settings stores editable per-user plan settings
-- - tenant deal_payment_events stores cash-received events used for earned commissions

CREATE TABLE IF NOT EXISTS public.user_commission_settings (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  commission_rate NUMERIC(7,6) NOT NULL DEFAULT 0,
  rolling_floor NUMERIC(14,2) NOT NULL DEFAULT 0,
  override_rate NUMERIC(7,6) NOT NULL DEFAULT 0,
  estimated_margin_rate NUMERIC(7,6) NOT NULL DEFAULT 0.30,
  min_margin_percent NUMERIC(7,6) NOT NULL DEFAULT 0.20,
  new_customer_share_floor NUMERIC(7,6) NOT NULL DEFAULT 0.10,
  new_customer_window_months INTEGER NOT NULL DEFAULT 6,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_commission_settings_rate_bounds_chk CHECK (
    commission_rate >= 0
    AND commission_rate <= 1
    AND override_rate >= 0
    AND override_rate <= 1
    AND estimated_margin_rate >= 0
    AND estimated_margin_rate <= 1
    AND min_margin_percent >= 0
    AND min_margin_percent <= 1
    AND new_customer_share_floor >= 0
    AND new_customer_share_floor <= 1
  ),
  CONSTRAINT user_commission_settings_floor_non_negative_chk CHECK (rolling_floor >= 0),
  CONSTRAINT user_commission_settings_window_positive_chk CHECK (new_customer_window_months >= 1)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_commission_settings_rate_bounds_chk'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE public.user_commission_settings
      ADD CONSTRAINT user_commission_settings_rate_bounds_chk CHECK (
        commission_rate >= 0
        AND commission_rate <= 1
        AND override_rate >= 0
        AND override_rate <= 1
        AND estimated_margin_rate >= 0
        AND estimated_margin_rate <= 1
        AND min_margin_percent >= 0
        AND min_margin_percent <= 1
        AND new_customer_share_floor >= 0
        AND new_customer_share_floor <= 1
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_commission_settings_floor_non_negative_chk'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE public.user_commission_settings
      ADD CONSTRAINT user_commission_settings_floor_non_negative_chk
      CHECK (rolling_floor >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_commission_settings_window_positive_chk'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE public.user_commission_settings
      ADD CONSTRAINT user_commission_settings_window_positive_chk
      CHECK (new_customer_window_months >= 1);
  END IF;
END $$;

-- Seed baseline rates/floors from 2026-04-21 commission sheet.
INSERT INTO public.user_commission_settings (
  user_id,
  commission_rate,
  rolling_floor,
  override_rate,
  estimated_margin_rate,
  min_margin_percent,
  new_customer_share_floor,
  new_customer_window_months,
  is_active
)
SELECT
  u.id,
  seed.commission_rate,
  seed.rolling_floor,
  seed.override_rate,
  0.30,
  0.20,
  0.10,
  6,
  true
FROM public.users u
JOIN (
  VALUES
    ('Derek Barr', 0.075::numeric, 5000000::numeric, 0.025::numeric),
    ('Kaleb Remington', 0.075::numeric, 5000000::numeric, 0::numeric),
    ('Chris Higingbotham', 0.050::numeric, 2000000::numeric, 0::numeric),
    ('Chris Higginbotham', 0.050::numeric, 2000000::numeric, 0::numeric),
    ('Kevin Scott', 0.030::numeric, 1500000::numeric, 0::numeric),
    ('Eddie McCarty', 0.050::numeric, 2000000::numeric, 0::numeric),
    ('Sidney', 0.020::numeric, 0::numeric, 0::numeric),
    ('Colby Burling', 0.030::numeric, 1000000::numeric, 0::numeric),
    ('Andrew Green', 0.030::numeric, 1000000::numeric, 0::numeric)
) AS seed(display_name, commission_rate, rolling_floor, override_rate)
  ON u.display_name = seed.display_name
ON CONFLICT (user_id) DO UPDATE
SET
  commission_rate = EXCLUDED.commission_rate,
  rolling_floor = EXCLUDED.rolling_floor,
  override_rate = EXCLUDED.override_rate,
  estimated_margin_rate = EXCLUDED.estimated_margin_rate,
  min_margin_percent = EXCLUDED.min_margin_percent,
  new_customer_share_floor = EXCLUDED.new_customer_share_floor,
  new_customer_window_months = EXCLUDED.new_customer_window_months,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = nspname
          AND table_name = 'deals'
      )
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.deal_payment_events (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL REFERENCES %I.deals(id) ON DELETE CASCADE,
         recorded_by_user_id UUID REFERENCES public.users(id),
         paid_at TIMESTAMPTZ NOT NULL,
         gross_revenue_amount NUMERIC(14,2) NOT NULL,
         gross_margin_amount NUMERIC(14,2),
         is_credit_memo BOOLEAN NOT NULL DEFAULT false,
         notes TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         CONSTRAINT deal_payment_events_credit_memo_sign_chk CHECK (
           (
             is_credit_memo = true
             AND gross_revenue_amount < 0
             AND (gross_margin_amount IS NULL OR gross_margin_amount < 0)
           )
           OR (
             is_credit_memo = false
             AND gross_revenue_amount >= 0
             AND (gross_margin_amount IS NULL OR gross_margin_amount >= 0)
           )
         ),
         CONSTRAINT deal_payment_events_margin_leq_revenue_chk CHECK (
           gross_margin_amount IS NULL
           OR ABS(gross_margin_amount) <= ABS(gross_revenue_amount)
         )
       )',
      schema_name,
      schema_name
    );

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = schema_name
        AND c.conname = 'deal_payment_events_credit_memo_sign_chk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.deal_payment_events
          ADD CONSTRAINT deal_payment_events_credit_memo_sign_chk CHECK (
            (
              is_credit_memo = true
              AND gross_revenue_amount < 0
              AND (gross_margin_amount IS NULL OR gross_margin_amount < 0)
            )
            OR (
              is_credit_memo = false
              AND gross_revenue_amount >= 0
              AND (gross_margin_amount IS NULL OR gross_margin_amount >= 0)
            )
          )',
        schema_name
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = schema_name
        AND c.conname = 'deal_payment_events_margin_leq_revenue_chk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.deal_payment_events
          ADD CONSTRAINT deal_payment_events_margin_leq_revenue_chk CHECK (
            gross_margin_amount IS NULL
            OR ABS(gross_margin_amount) <= ABS(gross_revenue_amount)
          )',
        schema_name
      );
    END IF;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deal_payment_events_deal_paid_at_idx
         ON %I.deal_payment_events (deal_id, paid_at)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deal_payment_events_paid_at_idx
         ON %I.deal_payment_events (paid_at)',
      schema_name
    );
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  CREATE TABLE IF NOT EXISTS deal_payment_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    recorded_by_user_id UUID REFERENCES public.users(id),
    paid_at TIMESTAMPTZ NOT NULL,
    gross_revenue_amount NUMERIC(14,2) NOT NULL,
    gross_margin_amount NUMERIC(14,2),
    is_credit_memo BOOLEAN NOT NULL DEFAULT false,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT deal_payment_events_credit_memo_sign_chk CHECK (
      (
        is_credit_memo = true
        AND gross_revenue_amount < 0
        AND (gross_margin_amount IS NULL OR gross_margin_amount < 0)
      )
      OR (
        is_credit_memo = false
        AND gross_revenue_amount >= 0
        AND (gross_margin_amount IS NULL OR gross_margin_amount >= 0)
      )
    ),
    CONSTRAINT deal_payment_events_margin_leq_revenue_chk CHECK (
      gross_margin_amount IS NULL
      OR ABS(gross_margin_amount) <= ABS(gross_revenue_amount)
    )
  );

  CREATE INDEX IF NOT EXISTS deal_payment_events_deal_paid_at_idx
    ON deal_payment_events (deal_id, paid_at);

  CREATE INDEX IF NOT EXISTS deal_payment_events_paid_at_idx
    ON deal_payment_events (paid_at);
END $tenant$;
-- TENANT_SCHEMA_END
