-- Migration 0153: deal_change_orders (CRM-native, dated change orders)
--
-- A dedicated per-office table for CRM change orders captured against Won / Bid-Board-Owned
-- deals AFTER they close. Distinct from the Procore-synced `change_orders` table — these rows
-- are CRM-only and are NEVER synced out to Procore / Bid Board.
--
-- Each row is its own DATED value record: `amount` (positive; CHECK amount > 0) adds to the
-- parent deal's Current Contract Value, but for Won-value reporting it attributes to the period
-- of its own `signed_date` (NOT the parent deal's won_closed_date). Modeled as a dedicated table
-- (never a child deal) so change orders stay entirely out of deal counts / pipeline / rep-keyed
-- report invariants. Per-tenant, mirroring migration 0104 (deal_contacts) / 0150 patterns.

-- Existing tenants: create the table + indexes in every office_* schema.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    EXECUTE format(
      $sql$
        CREATE TABLE IF NOT EXISTS %1$I.deal_change_orders (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          deal_id UUID NOT NULL REFERENCES %1$I.deals(id) ON DELETE CASCADE,
          signed_date DATE NOT NULL,
          amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
          description TEXT,
          created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
          updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS deal_change_orders_deal_id_idx
          ON %1$I.deal_change_orders (deal_id);
        CREATE INDEX IF NOT EXISTS deal_change_orders_signed_date_idx
          ON %1$I.deal_change_orders (signed_date);
      $sql$,
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner clones this marked block (office_dallas -> new schema).
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.deal_change_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES office_dallas.deals(id) ON DELETE CASCADE,
  signed_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  description TEXT,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deal_change_orders_deal_id_idx
  ON office_dallas.deal_change_orders (deal_id);
CREATE INDEX IF NOT EXISTS deal_change_orders_signed_date_idx
  ON office_dallas.deal_change_orders (signed_date);
-- TENANT_SCHEMA_END
