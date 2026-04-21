-- Migration 0033: Add market-rate storage for estimating

DO $$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT schemata.schema_name
    FROM information_schema.schemata AS schemata
    WHERE schemata.schema_name LIKE 'office_%'
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_markets (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         name VARCHAR(255) NOT NULL,
         slug VARCHAR(100) NOT NULL,
         type VARCHAR(32) NOT NULL,
         state_code VARCHAR(2),
         region_id UUID REFERENCES public.region_config(id) ON DELETE SET NULL,
         is_active BOOLEAN NOT NULL DEFAULT TRUE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         CONSTRAINT estimate_markets_slug_uidx UNIQUE (slug)
       )',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_markets_active_idx
         ON %I.estimate_markets (is_active)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_markets_type_idx
         ON %I.estimate_markets (type, is_active)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_markets_state_idx
         ON %I.estimate_markets (state_code, is_active)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_markets_region_idx
         ON %I.estimate_markets (region_id, is_active)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_market_zip_mappings (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         zip VARCHAR(10) NOT NULL,
         market_id UUID NOT NULL REFERENCES %I.estimate_markets(id) ON DELETE CASCADE,
         source_type TEXT NOT NULL DEFAULT ''manual'',
         source_confidence NUMERIC(5, 2) NOT NULL DEFAULT 1,
         is_active BOOLEAN NOT NULL DEFAULT TRUE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         CONSTRAINT estimate_market_zip_mappings_zip_uidx UNIQUE (zip)
       )',
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_market_zip_mappings_market_idx
         ON %I.estimate_market_zip_mappings (market_id, is_active)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_market_fallback_geographies (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         market_id UUID NOT NULL REFERENCES %I.estimate_markets(id) ON DELETE CASCADE,
         resolution_type VARCHAR(32) NOT NULL,
         resolution_key VARCHAR(120) NOT NULL,
         is_active BOOLEAN NOT NULL DEFAULT TRUE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         CONSTRAINT estimate_market_fallback_geographies_scope_uidx UNIQUE (resolution_type, resolution_key)
       )',
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_market_fallback_geographies_market_idx
         ON %I.estimate_market_fallback_geographies (market_id, is_active)',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_market_adjustment_rules (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         market_id UUID REFERENCES %I.estimate_markets(id) ON DELETE CASCADE,
         scope_type VARCHAR(32) NOT NULL,
         scope_key VARCHAR(120) NOT NULL,
         fallback_scope_type VARCHAR(32),
         fallback_scope_key VARCHAR(120),
         priority INTEGER NOT NULL DEFAULT 0,
         fallback_priority INTEGER NOT NULL DEFAULT 0,
         labor_adjustment_percent NUMERIC(8, 3) NOT NULL DEFAULT 0,
         material_adjustment_percent NUMERIC(8, 3) NOT NULL DEFAULT 0,
         equipment_adjustment_percent NUMERIC(8, 3) NOT NULL DEFAULT 0,
         default_labor_weight NUMERIC(8, 4) NOT NULL DEFAULT 0.3333,
         default_material_weight NUMERIC(8, 4) NOT NULL DEFAULT 0.3333,
         default_equipment_weight NUMERIC(8, 4) NOT NULL DEFAULT 0.3334,
         effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         effective_to TIMESTAMPTZ,
         is_active BOOLEAN NOT NULL DEFAULT TRUE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       )',
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_market_adjustment_rules_selection_idx
         ON %I.estimate_market_adjustment_rules (market_id, scope_type, scope_key, priority, fallback_priority, is_active, effective_from, effective_to)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_market_adjustment_rules_fallback_idx
         ON %I.estimate_market_adjustment_rules (fallback_scope_type, fallback_scope_key, fallback_priority)',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS estimate_market_adjustment_rules_market_scope_uidx
         ON %I.estimate_market_adjustment_rules (market_id, scope_type, scope_key, effective_from)
         WHERE market_id IS NOT NULL',
      schema_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS estimate_market_adjustment_rules_default_scope_uidx
         ON %I.estimate_market_adjustment_rules (scope_type, scope_key, effective_from)
         WHERE market_id IS NULL',
      schema_name
    );

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.estimate_deal_market_overrides (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         deal_id UUID NOT NULL,
         market_id UUID NOT NULL REFERENCES %I.estimate_markets(id) ON DELETE CASCADE,
         overridden_by_user_id UUID NOT NULL REFERENCES public.users(id),
         override_reason TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         CONSTRAINT estimate_deal_market_overrides_deal_uidx UNIQUE (deal_id)
       )',
      schema_name,
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_deal_market_overrides_deal_idx
         ON %I.estimate_deal_market_overrides (deal_id, updated_at)',
      schema_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS estimate_deal_market_overrides_market_idx
         ON %I.estimate_deal_market_overrides (market_id, created_at)',
      schema_name
    );

    EXECUTE format(
      'INSERT INTO %I.estimate_markets (name, slug, type, state_code, region_id, is_active)
       VALUES (''Default Market'', ''default'', ''global'', NULL, NULL, TRUE)
       ON CONFLICT (slug)
       DO UPDATE SET
         name = EXCLUDED.name,
         type = EXCLUDED.type,
         state_code = EXCLUDED.state_code,
         region_id = EXCLUDED.region_id,
         is_active = EXCLUDED.is_active,
         updated_at = NOW()',
      schema_name
    );

    EXECUTE format(
      'INSERT INTO %I.estimate_market_fallback_geographies (
         market_id,
         resolution_type,
         resolution_key,
         is_active
       )
       SELECT id, ''global'', ''default'', TRUE
         FROM %I.estimate_markets
        WHERE slug = ''default''
       ON CONFLICT (resolution_type, resolution_key)
       DO UPDATE SET
         market_id = EXCLUDED.market_id,
         is_active = EXCLUDED.is_active,
         updated_at = NOW()',
      schema_name,
      schema_name
    );

    EXECUTE format(
      'INSERT INTO %I.estimate_market_adjustment_rules (
         market_id,
         scope_type,
         scope_key,
         fallback_scope_type,
         fallback_scope_key,
         priority,
         fallback_priority,
         labor_adjustment_percent,
         material_adjustment_percent,
         equipment_adjustment_percent,
         default_labor_weight,
         default_material_weight,
         default_equipment_weight,
         effective_from,
         effective_to,
         is_active
       )
       SELECT
         NULL,
         ''global'',
         ''default'',
         NULL,
         NULL,
         0,
         0,
         0,
         0,
         0,
         0.3333,
         0.3333,
         0.3334,
         ''2000-01-01 00:00:00+00'',
         NULL,
         TRUE
       ON CONFLICT (scope_type, scope_key, effective_from) WHERE market_id IS NULL
       DO UPDATE SET
         fallback_scope_type = EXCLUDED.fallback_scope_type,
         fallback_scope_key = EXCLUDED.fallback_scope_key,
         priority = EXCLUDED.priority,
         fallback_priority = EXCLUDED.fallback_priority,
         labor_adjustment_percent = EXCLUDED.labor_adjustment_percent,
         material_adjustment_percent = EXCLUDED.material_adjustment_percent,
         equipment_adjustment_percent = EXCLUDED.equipment_adjustment_percent,
         default_labor_weight = EXCLUDED.default_labor_weight,
         default_material_weight = EXCLUDED.default_material_weight,
         default_equipment_weight = EXCLUDED.default_equipment_weight,
         effective_to = EXCLUDED.effective_to,
         is_active = EXCLUDED.is_active,
         updated_at = NOW()',
      schema_name,
      schema_name
    );
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS estimate_markets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  type VARCHAR(32) NOT NULL,
  state_code VARCHAR(2),
  region_id UUID REFERENCES public.region_config(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT estimate_markets_slug_uidx UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS estimate_markets_active_idx
  ON estimate_markets (is_active);

CREATE INDEX IF NOT EXISTS estimate_markets_type_idx
  ON estimate_markets (type, is_active);

CREATE INDEX IF NOT EXISTS estimate_markets_state_idx
  ON estimate_markets (state_code, is_active);

CREATE INDEX IF NOT EXISTS estimate_markets_region_idx
  ON estimate_markets (region_id, is_active);

CREATE TABLE IF NOT EXISTS estimate_market_zip_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zip VARCHAR(10) NOT NULL,
  market_id UUID NOT NULL REFERENCES estimate_markets(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_confidence NUMERIC(5, 2) NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT estimate_market_zip_mappings_zip_uidx UNIQUE (zip)
);

CREATE INDEX IF NOT EXISTS estimate_market_zip_mappings_market_idx
  ON estimate_market_zip_mappings (market_id, is_active);

CREATE TABLE IF NOT EXISTS estimate_market_fallback_geographies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES estimate_markets(id) ON DELETE CASCADE,
  resolution_type VARCHAR(32) NOT NULL,
  resolution_key VARCHAR(120) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT estimate_market_fallback_geographies_scope_uidx UNIQUE (resolution_type, resolution_key)
);

CREATE INDEX IF NOT EXISTS estimate_market_fallback_geographies_market_idx
  ON estimate_market_fallback_geographies (market_id, is_active);

CREATE TABLE IF NOT EXISTS estimate_market_adjustment_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID REFERENCES estimate_markets(id) ON DELETE CASCADE,
  scope_type VARCHAR(32) NOT NULL,
  scope_key VARCHAR(120) NOT NULL,
  fallback_scope_type VARCHAR(32),
  fallback_scope_key VARCHAR(120),
  priority INTEGER NOT NULL DEFAULT 0,
  fallback_priority INTEGER NOT NULL DEFAULT 0,
  labor_adjustment_percent NUMERIC(8, 3) NOT NULL DEFAULT 0,
  material_adjustment_percent NUMERIC(8, 3) NOT NULL DEFAULT 0,
  equipment_adjustment_percent NUMERIC(8, 3) NOT NULL DEFAULT 0,
  default_labor_weight NUMERIC(8, 4) NOT NULL DEFAULT 0.3333,
  default_material_weight NUMERIC(8, 4) NOT NULL DEFAULT 0.3333,
  default_equipment_weight NUMERIC(8, 4) NOT NULL DEFAULT 0.3334,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS estimate_market_adjustment_rules_selection_idx
  ON estimate_market_adjustment_rules (market_id, scope_type, scope_key, priority, fallback_priority, is_active, effective_from, effective_to);

CREATE INDEX IF NOT EXISTS estimate_market_adjustment_rules_fallback_idx
  ON estimate_market_adjustment_rules (fallback_scope_type, fallback_scope_key, fallback_priority);

CREATE UNIQUE INDEX IF NOT EXISTS estimate_market_adjustment_rules_market_scope_uidx
  ON estimate_market_adjustment_rules (market_id, scope_type, scope_key, effective_from)
  WHERE market_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS estimate_market_adjustment_rules_default_scope_uidx
  ON estimate_market_adjustment_rules (scope_type, scope_key, effective_from)
  WHERE market_id IS NULL;

CREATE TABLE IF NOT EXISTS estimate_deal_market_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL,
  market_id UUID NOT NULL REFERENCES estimate_markets(id) ON DELETE CASCADE,
  overridden_by_user_id UUID NOT NULL REFERENCES public.users(id),
  override_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT estimate_deal_market_overrides_deal_uidx UNIQUE (deal_id)
);

CREATE INDEX IF NOT EXISTS estimate_deal_market_overrides_deal_idx
  ON estimate_deal_market_overrides (deal_id, updated_at);

CREATE INDEX IF NOT EXISTS estimate_deal_market_overrides_market_idx
  ON estimate_deal_market_overrides (market_id, created_at);

INSERT INTO estimate_markets (name, slug, type, state_code, region_id, is_active)
VALUES ('Default Market', 'default', 'global', NULL, NULL, TRUE)
ON CONFLICT (slug)
DO UPDATE SET
  name = EXCLUDED.name,
  type = EXCLUDED.type,
  state_code = EXCLUDED.state_code,
  region_id = EXCLUDED.region_id,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

INSERT INTO estimate_market_fallback_geographies (
  market_id,
  resolution_type,
  resolution_key,
  is_active
)
SELECT id, 'global', 'default', TRUE
  FROM estimate_markets
 WHERE slug = 'default'
ON CONFLICT (resolution_type, resolution_key)
DO UPDATE SET
  market_id = EXCLUDED.market_id,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

INSERT INTO estimate_market_adjustment_rules (
  market_id,
  scope_type,
  scope_key,
  fallback_scope_type,
  fallback_scope_key,
  priority,
  fallback_priority,
  labor_adjustment_percent,
  material_adjustment_percent,
  equipment_adjustment_percent,
  default_labor_weight,
  default_material_weight,
  default_equipment_weight,
  effective_from,
  effective_to,
  is_active
)
SELECT
  NULL,
  'global',
  'default',
  NULL,
  NULL,
  0,
  0,
  0,
  0,
  0,
  0.3333,
  0.3333,
  0.3334,
  '2000-01-01 00:00:00+00',
  NULL,
  TRUE
ON CONFLICT (scope_type, scope_key, effective_from) WHERE market_id IS NULL
DO UPDATE SET
  fallback_scope_type = EXCLUDED.fallback_scope_type,
  fallback_scope_key = EXCLUDED.fallback_scope_key,
  priority = EXCLUDED.priority,
  fallback_priority = EXCLUDED.fallback_priority,
  labor_adjustment_percent = EXCLUDED.labor_adjustment_percent,
  material_adjustment_percent = EXCLUDED.material_adjustment_percent,
  equipment_adjustment_percent = EXCLUDED.equipment_adjustment_percent,
  default_labor_weight = EXCLUDED.default_labor_weight,
  default_material_weight = EXCLUDED.default_material_weight,
  default_equipment_weight = EXCLUDED.default_equipment_weight,
  effective_to = EXCLUDED.effective_to,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();
-- TENANT_SCHEMA_END
