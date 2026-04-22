-- Migration 0034: Repair estimating market-rate contract drift

DO $$
DECLARE
  schema_name text;
  has_bad_fallback boolean;
  has_good_fallback boolean;
  has_bad_rule boolean;
  has_good_rule boolean;
BEGIN
  FOR schema_name IN
    SELECT schemata.schema_name
    FROM information_schema.schemata AS schemata
    WHERE schemata.schema_name LIKE 'office_%'
  LOOP
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
      'SELECT EXISTS (
         SELECT 1
           FROM %I.estimate_market_fallback_geographies fg
           JOIN %I.estimate_markets m ON m.id = fg.market_id
          WHERE m.slug = ''default''
            AND fg.resolution_type = ''general''
            AND fg.resolution_key = ''default''
       )',
      schema_name,
      schema_name
    ) INTO has_bad_fallback;

    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
           FROM %I.estimate_market_fallback_geographies fg
           JOIN %I.estimate_markets m ON m.id = fg.market_id
          WHERE m.slug = ''default''
            AND fg.resolution_type = ''global''
            AND fg.resolution_key = ''default''
       )',
      schema_name,
      schema_name
    ) INTO has_good_fallback;

    IF has_bad_fallback THEN
      IF has_good_fallback THEN
        EXECUTE format(
          'DELETE FROM %I.estimate_market_fallback_geographies fg
            USING %I.estimate_markets m
           WHERE fg.market_id = m.id
             AND m.slug = ''default''
             AND fg.resolution_type = ''general''
             AND fg.resolution_key = ''default''',
          schema_name,
          schema_name
        );
      ELSE
        EXECUTE format(
          'UPDATE %I.estimate_market_fallback_geographies fg
              SET resolution_type = ''global'',
                  resolution_key = ''default'',
                  updated_at = NOW()
             FROM %I.estimate_markets m
            WHERE fg.market_id = m.id
              AND m.slug = ''default''
              AND fg.resolution_type = ''general''
              AND fg.resolution_key = ''default''',
          schema_name,
          schema_name
        );
      END IF;
    END IF;

    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
           FROM %I.estimate_market_adjustment_rules
          WHERE market_id IS NULL
            AND scope_type = ''global''
            AND scope_key = ''default''
            AND effective_from = ''2000-01-01 00:00:00+00''
       )',
      schema_name
    ) INTO has_bad_rule;

    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
           FROM %I.estimate_market_adjustment_rules
          WHERE market_id IS NULL
            AND scope_type = ''general''
            AND scope_key = ''default''
            AND effective_from = ''2000-01-01 00:00:00+00''
       )',
      schema_name
    ) INTO has_good_rule;

    IF has_bad_rule THEN
      IF has_good_rule THEN
        EXECUTE format(
          'DELETE FROM %I.estimate_market_adjustment_rules
           WHERE market_id IS NULL
             AND scope_type = ''global''
             AND scope_key = ''default''
             AND effective_from = ''2000-01-01 00:00:00+00''',
          schema_name
        );
      END IF;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.estimate_market_adjustment_rules
         DROP CONSTRAINT IF EXISTS estimate_market_adjustment_rules_scope_type_check',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.estimate_market_adjustment_rules
         DROP CONSTRAINT IF EXISTS estimate_market_adjustment_rules_fallback_scope_type_check',
      schema_name
    );

    IF has_bad_rule AND NOT has_good_rule THEN
      EXECUTE format(
        'UPDATE %I.estimate_market_adjustment_rules
            SET scope_type = ''general'',
                scope_key = ''default'',
                updated_at = NOW()
          WHERE market_id IS NULL
            AND scope_type = ''global''
            AND scope_key = ''default''
            AND effective_from = ''2000-01-01 00:00:00+00''',
        schema_name
      );
      has_good_rule := TRUE;
    END IF;

    EXECUTE format(
      'DELETE FROM %I.estimate_market_adjustment_rules
        WHERE scope_type IN (''global'', ''metro'', ''state'', ''region'')
           OR fallback_scope_type IN (''global'', ''metro'', ''state'', ''region'')',
      schema_name
    );

    IF NOT has_good_rule THEN
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
         VALUES (
           NULL,
           ''general'',
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
         )',
        schema_name
      );
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.estimate_market_adjustment_rules
         ADD CONSTRAINT estimate_market_adjustment_rules_scope_type_check
         CHECK (scope_type IN (''general'', ''division'', ''trade''))',
      schema_name
    );

    EXECUTE format(
      'ALTER TABLE %I.estimate_market_adjustment_rules
         ADD CONSTRAINT estimate_market_adjustment_rules_fallback_scope_type_check
         CHECK (fallback_scope_type IS NULL OR fallback_scope_type IN (''general'', ''division'', ''trade''))',
      schema_name
    );

  END LOOP;
END $$;

-- TENANT_SCHEMA_START
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

ALTER TABLE estimate_market_adjustment_rules
  DROP CONSTRAINT IF EXISTS estimate_market_adjustment_rules_scope_type_check;

ALTER TABLE estimate_market_adjustment_rules
  DROP CONSTRAINT IF EXISTS estimate_market_adjustment_rules_fallback_scope_type_check;

ALTER TABLE estimate_market_adjustment_rules
  ADD CONSTRAINT estimate_market_adjustment_rules_scope_type_check
  CHECK (scope_type IN ('general', 'division', 'trade'));

ALTER TABLE estimate_market_adjustment_rules
  ADD CONSTRAINT estimate_market_adjustment_rules_fallback_scope_type_check
  CHECK (fallback_scope_type IS NULL OR fallback_scope_type IN ('general', 'division', 'trade'));

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
    'general',
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
DO NOTHING;
-- TENANT_SCHEMA_END
